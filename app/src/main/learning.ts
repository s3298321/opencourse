import { log } from './log'
import { app, powerMonitor } from 'electron'
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { db, tx } from './db'
import {
  serverAccess,
  listConnections,
  probeServer,
  rememberServerInfo,
  rememberServerAccount,
  type ServerAccess
} from './servers'
import { callServer, downloadArchive, ServerError, type CallOptions } from './serverclient'
import { currentUserId, requireUser } from './users'
import { learningEvents, anyBinding, scopedId, localId, mapValue, enqueue, type Binding } from './learning-store'
import { visitNodes } from '../core/course-document'
import { unpackServerCourse } from './server-courses'
import { adoptPackage } from './import'
import { listCourses, reloadCourses } from './courses'
import { readProgress, persistProgress } from './progress'
import { receiveExerciseCode } from './workspace'
import { readDocument, courseDirectory, commitCourseOperation } from './course-store'
import { registerDocument } from './course-registry'
import { removeEditSession } from './edit-sessions'
import { isEditSessionDirty, stopCourseActivity } from './course-authoring'
import { importedAttachments } from './assets'
import { userDocumentsDir } from './paths'
import { documentEvents, startDocumentIndex, stopDocumentIndex } from './documents'
import { selectChats, selectMessages } from './chatdb'
import { REVIEW_CONFIGURATION } from '../core/review'
import { parseOverview } from '../core/catalog/parse'
import {
  newer,
  type ContentKind,
  type LearningState,
  type SyncPage,
  type SyncResult,
  type LearningOperation,
  type LearningChatView
} from '../core/learning/types'

const statuses = new Map<string, { state: string; message?: string; lastSynced?: string }>(),
  running = new Map<string, Promise<void>>(),
  failures = new Map<string, { attempt: number; next: number }>()
let timer: ReturnType<typeof setInterval> | undefined,
  debounce: ReturnType<typeof setTimeout> | undefined,
  firstPending = 0,
  epoch = 0,
  syncOwner: string | null = null
export function syncStatuses() {
  return Object.fromEntries(statuses)
}
export function stopLearningSync(): void {
  epoch++
  if (timer) clearInterval(timer)
  if (debounce) clearTimeout(debounce)
  firstPending = 0
  syncOwner = null
  timer = undefined
  statuses.clear()
  failures.clear()
}
export function startLearningSync(): void {
  if (timer && syncOwner === currentUserId()) return
  stopLearningSync()
  if (!currentUserId()) return
  syncOwner = currentUserId()
  recoverDocumentInstalls()
  void syncAll()
  timer = setInterval(() => void syncAll(), 30000)
  timer.unref()
}
learningEvents.on('pending', () => {
  if (!firstPending) firstPending = Date.now()
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(
    () => {
      firstPending = 0
      void syncAll(true)
    },
    Math.min(2000, Math.max(0, 10000 - (Date.now() - firstPending)))
  )
  debounce.unref()
})
export function registerLearningLifecycle(): void {
  powerMonitor.on('resume', () => void syncAll(true))
  app.on('before-quit', stopLearningSync)
}
/** Bound JSON and reject dangerous property names before it reaches a renderer or a local merge. */
export function learningJSON<T>(raw: unknown): T | null {
  function safe(v: unknown, depth = 0): boolean {
    if (depth > 25) return false
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return true
    if (typeof v === 'string') return v.length <= 200000
    if (Array.isArray(v)) return v.length <= 10000 && v.every((x) => safe(x, depth + 1))
    return (
      !!v &&
      typeof v === 'object' &&
      Object.entries(v).length <= 10000 &&
      Object.entries(v).every(([k, x]) => !['__proto__', 'constructor', 'prototype'].includes(k) && safe(x, depth + 1))
    )
  }
  return safe(raw) ? (raw as T) : null
}
function checkState(raw: unknown): LearningState | null {
  const s = learningJSON<LearningState>(raw)
  return s &&
    s.enrollment &&
    ['course', 'document'].includes(s.enrollment.kind) &&
    /^[a-f0-9-]{36}$/.test(s.enrollment.id) &&
    typeof s.enrollment.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(s.enrollment.version) &&
    typeof s.enrollment.generation === 'string' &&
    typeof s.enrollment.title === 'string' &&
    typeof s.epoch === 'string' &&
    s.fields &&
    typeof s.fields === 'object'
    ? s
    : null
}
function accessValid(access: ServerAccess, owner: string, generation: number) {
  if (currentUserId() !== owner || generation !== epoch || serverAccess(access.id).account?.id !== access.account?.id)
    throw new Error('The connected account changed.')
}
export async function learningRequest<T = unknown>(
  connection: string,
  path: string,
  method: CallOptions['method'] = 'GET',
  body?: unknown
): Promise<T> {
  if (
    typeof path !== 'string' ||
    path.length > 1000 ||
    !/^\/(documents(?:[/?]|$)|me\/(?:learning|ai|username|sessions|documents)(?:[/?]|$)|learning\/chats(?:[/?]|$)|learn\/)/.test(
      path
    ) ||
    path.includes('..') ||
    path.includes('#')
  )
    throw new Error('Invalid learning request.')
  const access = serverAccess(connection),
    owner = requireUser(),
    generation = epoch
  if (!access.account || !access.token) throw new Error('Sign in to this server first.')
  try {
    const value = await callServer(access.url, path, learningJSON<T>, {
      method,
      json: body,
      token: access.token,
      route: '/learning'
    })
    accessValid(access, owner, generation)
    if (path === '/me/username' && method === 'PUT')
      rememberServerAccount(connection, (value as { account: unknown }).account)
    if (method === 'DELETE' && /^\/learning\/chats\/[^/]+$/.test(path) && access.serverId)
      db().prepare('DELETE FROM learning_chat_cache WHERE server_id=? AND account_id=? AND id=?')
        .run(access.serverId, access.account.id, path.split('/').at(-1)!)
    if (method === 'GET' && /^\/learning\/chats\/[^/]+$/.test(path) && access.serverId) {
      const view = value as LearningChatView
      if (view?.chat?.id && Array.isArray(view.messages))
        db()
          .prepare(
            'INSERT INTO learning_chat_cache VALUES(?,?,?,?) ON CONFLICT(server_id,account_id,id) DO UPDATE SET value=excluded.value'
          )
          .run(access.serverId, access.account.id, view.chat.id, JSON.stringify(view))
    }
    return value
  } catch (error) {
    accessValid(access, owner, generation)
    if (
      method === 'GET' &&
      path.startsWith('/learning/chats') &&
      access.serverId &&
      !(error instanceof ServerError && error.status >= 400 && error.status < 500)
    ) {
      const views = (
        db()
          .prepare('SELECT value FROM learning_chat_cache WHERE server_id=? AND account_id=?')
          .all(access.serverId, access.account.id) as { value: string }[]
      ).map((r) => JSON.parse(r.value) as LearningChatView)
      const url = new URL(path, 'http://local')
      if (url.pathname === '/learning/chats')
        return {
          chats: views
            .filter(
              (v) => v.chat.kind === url.searchParams.get('kind') && v.chat.contentId === url.searchParams.get('id')
            )
            .map((v) => v.chat)
        } as T
      const view = views.find((v) => url.pathname === `/learning/chats/${v.chat.id}`)
      if (view) return view as T
    }
    throw error
  }
}
export async function syncAll(force = false): Promise<void> {
  if (!currentUserId()) return
  await Promise.all(
    listConnections()
      .filter((c) => c.account)
      .map((c) => syncServer(c.id, force))
  )
}
export async function syncServer(connection: string, force = false): Promise<void> {
  const owner = requireUser(),
    key = `${owner}:${connection}`,
    inflight = running.get(key)
  if (inflight) {
    await inflight
    if (force && currentUserId() === owner) return syncServer(connection, true)
    return
  }
  if (!force && (failures.get(key)?.next ?? 0) > Date.now()) return
  const generation = epoch,
    access = serverAccess(connection)
  if (!access.account) return
  const work = (async () => {
    try {
      statuses.set(connection, { state: 'Syncing' })
      learningEvents.emit('status')
      const info = (await probeServer(access.url)).info
      accessValid(access, owner, generation)
      if (!info.id || !info.capabilities?.includes('learning-sync-v1')) {
        statuses.set(connection, { state: 'Sync unavailable on this server' })
        return
      }
      rememberServerInfo(access.id, info)
      if (access.serverId !== info.id || JSON.stringify(access.capabilities) !== JSON.stringify(info.capabilities))
        learningEvents.emit('servers')
      access.serverId = info.id
      const server = info.id,
        account = access.account!.id
      db().prepare('INSERT OR IGNORE INTO learning_cursors(server_id,account_id) VALUES(?,?)').run(server, account)
      async function pull() {
        let more = true
        while (more) {
          const cursor = (
            db()
              .prepare('SELECT cursor FROM learning_cursors WHERE server_id=? AND account_id=?')
              .get(server, account) as { cursor: number }
          ).cursor
          const started = Date.now(),
            page = await callServer(access.url, `/sync?cursor=${cursor}`, learningJSON<SyncPage>, {
              token: access.token,
              route: '/sync'
            })
          accessValid(access, owner, generation)
          if (
            !Array.isArray(page.changes) ||
            !Number.isSafeInteger(page.cursor) ||
            page.cursor < cursor ||
            !Number.isFinite(page.serverTime)
          )
            throw new Error('Invalid sync response.')
          tx(() => {
            for (const item of page.changes) {
              if (item.type === 'state') {
                const state = checkState(item.value)
                if (!state) throw new Error('Invalid learning state.')
                saveState(access, state)
              }
              if (item.type === 'chat') {
                if ((item.value as { deleted?: boolean } | null)?.deleted === true) {
                  db().prepare('DELETE FROM learning_chat_cache WHERE server_id=? AND account_id=? AND id=?')
                    .run(server, account, item.key)
                  continue
                }
                const view = learningJSON<LearningChatView>(item.value)
                if (view?.chat?.id === item.key && Array.isArray(view.messages))
                  db()
                    .prepare(
                      'INSERT INTO learning_chat_cache VALUES(?,?,?,?) ON CONFLICT(server_id,account_id,id) DO UPDATE SET value=excluded.value'
                    )
                    .run(server, account, item.key, JSON.stringify(view))
              }
            }
            db()
              .prepare('UPDATE learning_cursors SET cursor=?,clock_offset=? WHERE server_id=? AND account_id=?')
              .run(page.cursor, page.serverTime - (started + Date.now()) / 2, server, account)
          })
          if (page.more && page.cursor === cursor) throw new Error('The server returned a stalled sync cursor.')
          more = page.more
        }
      }
      await pull()
      for (const b of db()
        .prepare('SELECT * FROM learning_bindings WHERE server_id=? AND account_id=? AND downloaded=1')
        .all(server, account) as unknown as Binding[]) {
        const s = JSON.parse(b.state) as LearningState
        if (s.enrollment.active && s.enrollment.version === b.version) applyState(b)
      }
      // Only installed learner copies are eligible for legacy enrollment.
      for (const course of listCourses()) {
        if (course.origin?.server !== access.url || course.origin.role !== 'learner' || course.error) continue
        const existing = db()
          .prepare('SELECT 1 FROM learning_bootstrap WHERE server_id=? AND account_id=? AND local_id=?')
          .get(server, account, course.courseId)
        if (existing) continue
        const document = readDocument(course.courseId)
        if (document.origin?.serverId) continue
        const remote = document.origin!.contentId ?? course.courseId
        const cached = db()
          .prepare(
            "SELECT state FROM learning_bindings WHERE server_id=? AND account_id=? AND kind='course' AND remote_id=?"
          )
          .get(server, account, remote) as { state: string } | undefined
        const state = cached
          ? (JSON.parse(cached.state) as LearningState)
          : await callServer(access.url, `/me/learning/course/${remote}`, checkState, {
              method: 'PUT',
              json: { version: document.origin!.version },
              token: access.token,
              route: '/me/learning/:kind/:id'
            })
        accessValid(access, owner, generation)
        const snapshot = readProgress(course.courseId)
        tx(() => {
          saveState(access, state, course.courseId)
          visitNodes(document.manifest!, (node) => {
            db()
              .prepare('INSERT OR IGNORE INTO learning_elements VALUES(?,?,?,?)')
              .run(server, account, String(node.nodeId), String(node.nodeId))
          })
          db()
            .prepare('UPDATE learning_bindings SET downloaded=1,version=? WHERE local_id=?')
            .run(document.origin!.version, course.courseId)
          db()
            .prepare('INSERT OR IGNORE INTO learning_bootstrap VALUES(?,?,?,?)')
            .run(server, account, course.courseId, JSON.stringify(snapshot))
          const b = db()
            .prepare('SELECT * FROM learning_bindings WHERE local_id=?')
            .get(course.courseId) as unknown as Binding
          for (const id of snapshot.completedLessons)
            if (!state.fields[`lesson:${id}`]) enqueue(b, `lesson:${id}`, true, 0, `bootstrap:${course.courseId}:${id}`)
          for (const [field, values] of [
            ['quiz', snapshot.quizAttempts],
            ['exercise', snapshot.exercises],
            ['project', snapshot.projects]
          ] as const)
            for (const [id, value] of Object.entries(values))
              if (!state.fields[`${field}:${id}`])
                enqueue(b, `${field}:${id}`, value, 0, `bootstrap:${course.courseId}:${field}:${id}`)
        })
      }
      // Only legacy reading conversations qualify. Mixed notebook conversations remain local.
      const legacy = db()
        .prepare(
          'SELECT b.* FROM learning_bindings b JOIN learning_bootstrap m ON m.local_id=b.local_id AND m.server_id=b.server_id AND m.account_id=b.account_id WHERE b.server_id=? AND b.account_id=?'
        )
        .all(server, account) as unknown as Binding[]
      for (const b of legacy)
        for (const chat of selectChats(b.local_id)) {
          if (
            chat.startedInNotebook ||
            db()
              .prepare('SELECT 1 FROM learning_chat_imports WHERE server_id=? AND account_id=? AND chat_id=?')
              .get(server, account, chat.id)
          )
            continue
          const messages = selectMessages(chat.id)
          if (messages.some((m) => m.notebook || m.quote?.from === 'notebook')) continue
          const reading = messages
            .filter((m) => m.role !== 'context')
            .map((m) => ({ role: m.role, text: m.quote ? `${m.quote.text}\n\n${m.text}` : m.text, at: m.at }))
          await callServer(access.url, '/learning/chats/import', learningJSON, {
            method: 'POST',
            token: access.token,
            json: {
              kind: b.kind,
              id: b.remote_id,
              version: b.version,
              importId: `legacy:${chat.id}`,
              title: chat.title.slice(0, 300),
              messages: reading
            },
            route: '/learning/chats/import'
          })
          accessValid(access, owner, generation)
          db().prepare('INSERT OR IGNORE INTO learning_chat_imports VALUES(?,?,?)').run(server, account, chat.id)
        }
      for (;;) {
        const pending = db()
          .prepare(
            'SELECT id,payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL LIMIT 100'
          )
          .all(server, account) as { id: string; payload: string }[]
        if (!pending.length) break
        const result = await callServer(access.url, '/sync', learningJSON<SyncResult>, {
          method: 'POST',
          token: access.token,
          json: { operations: pending.map((r) => JSON.parse(r.payload)) },
          route: '/sync'
        })
        accessValid(access, owner, generation)
        if (
          !Array.isArray(result.accepted) ||
          !Array.isArray(result.rejected) ||
          (!result.accepted.length && !result.rejected.length)
        )
          throw new Error('Invalid sync acknowledgment.')
        const sent = new Set(pending.map((p) => p.id))
        tx(() => {
          for (const id of result.accepted)
            if (sent.has(id)) db().prepare('DELETE FROM learning_outbox WHERE id=?').run(id)
          for (const r of result.rejected)
            if (sent.has(r.id)) db().prepare('UPDATE learning_outbox SET error=? WHERE id=?').run(String(r.code), r.id)
        })
      }
      await pull()
      const bindings = db()
        .prepare('SELECT * FROM learning_bindings WHERE server_id=? AND account_id=?')
        .all(server, account) as unknown as Binding[]
      let downloadError = false
      for (const b of bindings) {
        accessValid(access, owner, generation)
        const state = JSON.parse(b.state) as LearningState
        if (!state.enrollment.active || b.downloaded === -1) continue
        try {
          if (!b.downloaded || b.version !== state.enrollment.version)
            await install(access, b, state, () => {
              accessValid(access, owner, generation)
              if (
                (
                  db().prepare('SELECT downloaded FROM learning_bindings WHERE local_id=?').get(b.local_id) as {
                    downloaded: number
                  }
                )?.downloaded === -1
              )
                throw new Error('Download removed.')
            })
          applyState(b)
        } catch {
          downloadError = true
        }
      }
      reloadCourses()
      documentEvents.emit('changed')
      learningEvents.emit('content')
      const retained = Number(
        (
          db()
            .prepare(
              'SELECT COUNT(*) AS n FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NOT NULL'
            )
            .get(server, account) as { n: number }
        ).n
      )
      failures.delete(key)
      statuses.set(connection, {
        ...(retained
          ? { message: `${retained} earlier actions were retained locally after a reset, version change, or removal.` }
          : {}),
        state: downloadError ? 'Download pending — retry sync' : 'Synced',
        lastSynced: new Date().toISOString()
      })
    } catch (error) {
      log.child('learning-sync').warn('Sync interrupted', {
        data: { connection, code: error instanceof ServerError ? error.code : 'unavailable' }
      })
      const retry = (failures.get(key)?.attempt ?? 0) + 1
      failures.set(key, {
        attempt: retry,
        next: Date.now() + Math.min(300000, 2000 * 2 ** Math.min(retry, 8)) * (0.8 + Math.random() * 0.4)
      })
      if (currentUserId() === owner && generation === epoch)
        statuses.set(connection, {
          state: error instanceof ServerError && error.status === 401 ? 'Sign-in required' : 'Offline changes pending'
        })
    } finally {
      running.delete(key)
      learningEvents.emit('status')
    }
  })()
  running.set(key, work)
  return work
}
function saveState(access: ServerAccess, state: LearningState, legacyId?: string): void {
  const e = state.enrollment,
    server = access.serverId!,
    account = access.account!.id
  const old = db()
    .prepare('SELECT local_id FROM learning_bindings WHERE server_id=? AND account_id=? AND kind=? AND remote_id=?')
    .get(server, account, e.kind, e.id) as { local_id: string } | undefined
  if (!old && !legacyId && e.kind === 'course') {
    const candidate = listCourses().find(
      (c) =>
        c.origin?.role === 'learner' &&
        c.origin.server === access.url &&
        c.courseId === e.id &&
        !db().prepare('SELECT 1 FROM learning_bindings WHERE local_id=?').get(c.courseId)
    )
    legacyId = candidate?.courseId
  }
  const id = old?.local_id ?? legacyId ?? scopedId(`${server}:${account}`, `${e.kind}:${e.id}`)
  db()
    .prepare(
      `INSERT INTO learning_bindings(server_id,account_id,connection_id,kind,remote_id,local_id,version,state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,account_id,kind,remote_id) DO UPDATE SET connection_id=excluded.connection_id,state=excluded.state`
    )
    .run(server, account, access.id, e.kind, e.id, id, e.version, JSON.stringify(state))
}
async function install(access: ServerAccess, b: Binding, state: LearningState, check: () => void): Promise<void> {
  const version = state.enrollment.version,
    work = mkdtempSync(join(tmpdir(), 'opencourse-learning-')),
    file = join(work, b.kind === 'course' ? 'course.zip' : 'document.pdf')
  try {
    await downloadArchive(
      access.url,
      `/learn/${b.kind}/${b.remote_id}/${version}/download`,
      file,
      b.kind === 'course' ? 200 * 1024 ** 2 : 100 * 1024 ** 2,
      { token: access.token, route: '/learn/:kind/:id/:version/download' }
    )
    check()
    if (b.kind === 'course') {
      const staging = join(work, 'package'),
        manifest = await unpackServerCourse(file, staging, b.remote_id)
      check()
      visitNodes(manifest, (node) => {
        const remote = String(node.nodeId)
        const row = db()
          .prepare('SELECT local_id FROM learning_elements WHERE server_id=? AND account_id=? AND remote_id=?')
          .get(b.server_id, b.account_id, remote) as { local_id: string } | undefined
        const id = row?.local_id ?? scopedId(`${b.server_id}:${b.account_id}`, remote)
        db()
          .prepare('INSERT OR IGNORE INTO learning_elements VALUES(?,?,?,?)')
          .run(b.server_id, b.account_id, remote, id)
        node.nodeId = id
      })
      // Who published it is the catalog's to say; an unlisted course keeps what the copy said.
      let publisher = ''
      try {
        publisher = (await callServer(access.url, `/courses/${b.remote_id}`, parseOverview, { token: access.token, route: '/courses/:id' })).publisher
      } catch {
        if (existsSync(join(courseDirectory(b.local_id), 'document.json'))) publisher = readDocument(b.local_id).origin?.publisher ?? ''
      }
      check()
      const origin = {
        kind: 'server' as const,
        server: access.url,
        serverName: access.name,
        serverId: b.server_id,
        accountId: b.account_id,
        contentId: b.remote_id,
        version,
        role: 'learner' as const,
        publisher,
        installedAt: new Date().toISOString(),
        revision: 1
      }
      if (!existsSync(join(courseDirectory(b.local_id), 'document.json')))
        adoptPackage(staging, b.local_id, manifest, origin)
      else {
        await stopCourseActivity(requireUser(), b.local_id)
        check()
        if (isEditSessionDirty(b.local_id)) throw new Error('Finish editing this course before updating it.')
        const document = readDocument(b.local_id)
        if (document.origin?.role !== 'learner') throw new Error('Publisher drafts cannot be replaced by sync.')
        cpSync(staging, join(courseDirectory(b.local_id), 'package.next'), { recursive: true })
        rmSync(join(courseDirectory(b.local_id), 'package.next', 'course.json'), { force: true })
        const next = {
          ...document,
          manifest,
          attachments: importedAttachments(staging, manifest),
          origin,
          revision: document.revision + 1
        }
        commitCourseOperation(next, null, b.local_id, [], (d) => registerDocument(d, next), { packageSwap: true })
        removeEditSession(requireUser(), b.local_id)
      }
    } else {
      const data = await callServer(
        access.url,
        `/learn/document/${b.remote_id}/${version}`,
        learningJSON<{
          document: {
            title: string
            description: string
            tags: string
            cover_type: string | null
            pages: number
            bytes: number
            fingerprint: string
          }
        }>,
        { token: access.token, route: '/learn/document/:id/:version' }
      )
      check()
      await stopDocumentIndex(b.local_id)
      check()
      const root = userDocumentsDir(requireUser())
      mkdirSync(root, { recursive: true })
      cpSync(file, join(root, `${b.local_id}.pdf.next`))
      const fd = openSync(join(root, `${b.local_id}.pdf.next`), 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const fingerprint = createHash('sha256')
        .update(`${b.server_id}:${b.account_id}:${b.remote_id}:${data.document.fingerprint}`)
        .digest('hex')
      db()
        .prepare('INSERT OR REPLACE INTO learning_document_installs VALUES(?,?,?)')
        .run(b.local_id, version, JSON.stringify({ ...data.document, fingerprint }))
      recoverDocumentInstalls()
      startDocumentIndex(b.local_id)
    }
    db().prepare('UPDATE learning_bindings SET version=?,downloaded=1 WHERE local_id=?').run(version, b.local_id)
    b.version = version
    b.downloaded = 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
function applyState(b: Binding): void {
  const value = JSON.parse(b.state) as LearningState
  const pending = db()
    .prepare('SELECT payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL')
    .all(b.server_id, b.account_id) as { payload: string }[]
  for (const row of pending) {
    const o = JSON.parse(row.payload) as LearningOperation
    if (
      o.id === b.remote_id &&
      o.kind === b.kind &&
      o.epoch === value.epoch &&
      o.generation === value.enrollment.generation &&
      (b.kind === 'course' || o.version === b.version) &&
      newer({ at: o.at, operation: o.idempotencyKey }, value.fields[o.field])
    )
      value.fields[o.field] = { value: o.value, at: o.at, operation: o.idempotencyKey }
  }
  if (b.kind === 'document') {
    const read = value.fields.readPage?.value ?? 0,
      position = value.fields.position?.value ?? 1
    if (typeof read === 'number')
      db().prepare('UPDATE documents SET read_page=min(pages,?) WHERE id=?').run(read, b.local_id)
    if (typeof position === 'number')
      db().prepare('UPDATE documents SET last_page=min(pages,max(1,?)) WHERE id=?').run(position, b.local_id)
    return
  }
  const progress = readProgress(b.local_id),
    codeArrived: string[] = []
  progress.completedLessons = []
  progress.quizAttempts = {}
  delete progress.lastItem
  delete progress.lastLesson
  for (const v of Object.values(progress.exercises)) delete v.completedAt
  for (const v of Object.values(progress.projects)) delete v.completedAt
  for (const [field, entry] of Object.entries(value.fields)) {
    const [kind, ...parts] = field.split(':'),
      id = localId(b, parts.join(':')),
      v = mapValue(entry.value, (x) => localId(b, x))
    if (kind === 'lesson') {
      progress.completedLessons = progress.completedLessons.filter((x) => x !== id)
      if (v === true) progress.completedLessons.push(id)
    }
    if (kind === 'quiz') {
      if (v) progress.quizAttempts[id] = v as CourseProgressQuiz
      else delete progress.quizAttempts[id]
    }
    if (kind === 'exercise') {
      if (v) progress.exercises[id] = { ...progress.exercises[id], ...(v as object) }
      else delete progress.exercises[id]
    }
    if (kind === 'project') {
      if (v) progress.projects[id] = { ...progress.projects[id], ...(v as object) }
      else delete progress.projects[id]
    }
    if (kind === 'code') codeArrived.push(id)
    if (kind === 'lastItem' && v) {
      progress.lastItem = v as import('../core/types').CourseProgress['lastItem']
      if (progress.lastItem?.kind === 'lesson')
        progress.lastLesson = { moduleId: progress.lastItem.moduleId, lessonId: progress.lastItem.lessonId }
    }
    if (kind === 'review' && !v)
      db().prepare('DELETE FROM flashcard_states WHERE card_id=? AND course_id=?').run(id, b.local_id)
    if (kind === 'review' && v && typeof v === 'object' && 'card' in v) {
      const card = (v as { card: { due: string } }).card
      if (db().prepare('SELECT 1 FROM course_elements WHERE id=?').get(id))
        db()
          .prepare(
            `INSERT INTO flashcard_states(card_id,course_id,due,state,configuration,version) VALUES(?,?,?,?,?,1) ON CONFLICT(card_id) DO UPDATE SET due=excluded.due,state=excluded.state,version=flashcard_states.version+1 WHERE flashcard_states.state<>excluded.state`
          )
          .run(id, b.local_id, card.due, JSON.stringify(card), JSON.stringify(REVIEW_CONFIGURATION))
    }
  }
  persistProgress(progress)
  for (const blockId of codeArrived)
    try {
      receiveExerciseCode({ courseId: b.local_id, blockId })
    } catch {
      // An exercise this copy of the course no longer has, or a course busy saving.
    }
}
type CourseProgressQuiz = import('../core/types').QuizAttempt
export async function enrollFromDesktop(
  connection: string,
  kind: ContentKind,
  id: string,
  version?: string
): Promise<{ courseId: string; title: string; version: string }> {
  const access = serverAccess(connection),
    info = (await probeServer(access.url)).info
  access.serverId = info.id
  if (!info.id || !access.account) throw new Error('This server does not support learning sync.')
  const value = await learningRequest<LearningState>(
    connection,
    `/me/learning/${kind}/${id}`,
    'PUT',
    version ? { version } : {}
  )
  if (!checkState(value)) throw new Error('Invalid enrollment.')
  saveState(access, value)
  db()
    .prepare(
      'UPDATE learning_bindings SET downloaded=CASE WHEN downloaded=-1 THEN 0 ELSE downloaded END WHERE server_id=? AND account_id=? AND kind=? AND remote_id=?'
    )
    .run(info.id, access.account.id, kind, id)
  await syncServer(connection, true)
  const b = db()
    .prepare('SELECT * FROM learning_bindings WHERE server_id=? AND account_id=? AND kind=? AND remote_id=?')
    .get(info.id, access.account.id, kind, id) as unknown as Binding
  if (!b.downloaded) throw new Error('Enrollment saved. The download is pending; retry from Server settings.')
  return { courseId: b.local_id, title: value.enrollment.title, version: value.enrollment.version }
}

/** Remove cached content on this device; learning history, chats and workspaces survive. */
export async function removeLearningDownload(local: string): Promise<void> {
  const b = anyBinding(local)
  if (!b) throw new Error('This is not a server download.')
  const owner = requireUser()
  if (b.kind === 'course') {
    if (isEditSessionDirty(local)) throw new Error('Finish editing this course first.')
    await stopCourseActivity(owner, local)
  } else await stopDocumentIndex(local)
  if (requireUser() !== owner) throw new Error('The local user changed.')
  db().prepare('UPDATE learning_bindings SET downloaded=-1 WHERE local_id=?').run(local)
  rmSync(
    b.kind === 'course' ? join(courseDirectory(local), 'package') : join(userDocumentsDir(owner), `${local}.pdf`),
    { recursive: true, force: true }
  )
  reloadCourses()
  documentEvents.emit('changed')
  learningEvents.emit('content')
}

function recoverDocumentInstalls(): void {
  const root = userDocumentsDir(requireUser())
  for (const row of db().prepare('SELECT * FROM learning_document_installs').all() as {
    local_id: string
    version: string
    metadata: string
  }[]) {
    const next = join(root, `${row.local_id}.pdf.next`),
      target = join(root, `${row.local_id}.pdf`)
    if (existsSync(next)) renameSync(next, target)
    if (!existsSync(target)) continue
    const fd = openSync(root, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const value = JSON.parse(row.metadata) as {
      title: string
      description: string
      tags: string
      bytes: number
      fingerprint: string
      pages: number
    }
    tx(() => {
      db()
        .prepare(
          `INSERT INTO documents(id,title,bytes,fingerprint,pages,created_at,status) VALUES(?,?,?,?,?,?,'indexing') ON CONFLICT(id) DO UPDATE SET title=excluded.title,bytes=excluded.bytes,fingerprint=excluded.fingerprint,pages=excluded.pages,status='indexing',index_version=0,indexed_pages=0,read_page=0,last_page=1`
        )
        .run(row.local_id, value.title, value.bytes, value.fingerprint, value.pages, new Date().toISOString())
      db()
        .prepare('UPDATE documents SET title_override=?,publication=? WHERE id=?')
        .run(
          value.title,
          JSON.stringify({
            description: value.description,
            tags: JSON.parse(value.tags ?? '[]'),
            version: row.version,
            publications: {}
          }),
          row.local_id
        )
      db()
        .prepare('UPDATE learning_bindings SET version=?,downloaded=1 WHERE local_id=?')
        .run(row.version, row.local_id)
      db().prepare('DELETE FROM learning_document_installs WHERE local_id=?').run(row.local_id)
    })
  }
}
