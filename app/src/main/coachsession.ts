/**
 * A live coaching session, from main's side.
 *
 * Main holds three things the renderer must not: the API key, the ephemeral
 * secret, and the record of what is running. The renderer owns the peer
 * connection and the microphone - audio flows straight from it to OpenAI over
 * WebRTC - but every credential and every decision about whether a session may
 * exist is made here.
 *
 * The teardown discipline is copied from pty.ts, and for the same reason: a
 * session is bound to the renderer that asked for it, there is no reattach, and
 * a reload, a navigation or a quit must end it rather than leave a row claiming
 * to be live for ever. `sweepLiveSessions` in coachdb.ts catches the hard-kill
 * case that no listener can.
 */
import { app, systemPreferences, type WebContents } from 'electron'
import { newSessionId } from '../core/coach/ids'
import { buildInstructions } from '../core/coach/prompt'
import { MAX_TOOL_CALLS_PER_SESSION, MAX_WEB_SEARCHES_PER_SESSION, toolsFor } from '../core/coach/tools'
import type { CoachSessionSummary, CoachStartResult, TranscriptTurn } from '../core/types'
import { requireProject } from './coach'
import { finishSession, insertSession, saveTurns, selectSessionRow, selectSessionSummary } from './coachdb'
import { listFiles } from './coachfiles'
import { readKey } from './coachkey'
import { holdMic } from './mic'
import { mintClientSecret, exchangeSdp, type ClientSecret } from './openai'
import { log } from './log'
import { holdCoachProject } from './coach-activity'
import { getCoachAllowDelete } from './preferences'
import { currentUserId, requireUser } from './users'
import { runCoachTool, type CoachToolResult } from './coachtools'
import type { CoachResponseDiagnostic } from '../core/types'

const coachLog = log.child('coach')

interface Live {
  sessionId: string
  projectId: string
  model: string
  senderId: number
  secret: ClientSecret
  toolCalls: number
  searches: number
  started: number
  releaseMic: () => void
  releaseProject: () => void
  owner: string
}

const live = new Map<string, Live>()
const watched = new WeakSet<WebContents>()

/** A session is bound to the renderer that started it. */
function watchSender(sender: WebContents): void {
  if (watched.has(sender)) return
  watched.add(sender)
  const endAll = (): void => endForSender(sender.id, 'the window closed')
  sender.once('destroyed', endAll)
  sender.on('render-process-gone', endAll)
  sender.on('did-start-navigation', (event) => {
    if (event.isMainFrame && event.isSameDocument === false) endAll()
  })
}

function close(entry: Live, status: 'ended' | 'failed', error?: string): void {
  entry.releaseMic()
  live.delete(entry.sessionId)
  entry.releaseProject()
  const fields = { sessionId: entry.sessionId, projectId: entry.projectId, model: entry.model, status, minutes: Math.round((Date.now() - entry.started) / 6_000) / 10, toolCalls: entry.toolCalls, searches: entry.searches }
  if (status === 'failed') coachLog.warn('Coach session ended early', { ...fields, reason: error ?? null })
  else coachLog.info('Coach session ended', fields)
  try {
    finishSession(entry.sessionId, status, error)
  } catch {
    // The database may already be closed on the way out of the app. The sweep
    // on the next open is what covers this.
  }
}

export function endForSender(senderId: number, reason: string): void {
  for (const entry of [...live.values()]) {
    if (entry.senderId === senderId) close(entry, 'failed', reason)
  }
}

export function endAllSessions(): void {
  for (const entry of [...live.values()]) close(entry, 'failed', 'OpenCourse quit')
}

app.on('before-quit', endAllSessions)

export function liveSessionCount(): number {
  return live.size
}

/**
 * Starts a session, in the order that wastes the least.
 *
 * The microphone is asked for *before* the secret is minted: a denied mic
 * should not have cost an API call, and the system prompt fires at a moment we
 * chose rather than halfway through a handshake.
 */
export async function startSession(sender: WebContents, projectId: string): Promise<CoachStartResult> {
  const project = requireProject(projectId)

  const key = readKey()
  if (!key) return { status: 'no-key' }

  const releaseProject = holdCoachProject(projectId)
  let kept = false
  const releaseMic = holdMic()
  try {
    const owner = requireUser()
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) {
        releaseMic()
        coachLog.info('The microphone was refused', { projectId })
        return { status: 'mic-denied' }
      }
    } catch (error) {
      releaseMic()
      coachLog.warn('The microphone could not be asked for', { projectId, error })
      return { status: 'mic-denied' }
    }

    // The coach should start knowing what it already wrote down.
    if (currentUserId() !== owner) { releaseMic(); throw new Error('The user changed while connecting.') }
    const effectiveProject = { ...project, allowDelete: getCoachAllowDelete() }
    const instructions = buildInstructions(effectiveProject, listFiles(projectId))
    const tools = toolsFor(effectiveProject)

    let secret: ClientSecret
    try {
      secret = await mintClientSecret(key, {
        model: project.model,
        voice: project.voice,
        instructions,
        tools
      })
    } catch (err) {
      releaseMic()
      coachLog.error('A coach session could not be started', { projectId, model: project.model, error: err })
      return { status: 'failed', message: (err as Error).message }
    }

    if (currentUserId() !== owner) { releaseMic(); throw new Error('The user changed while connecting.') }
    const sessionId = newSessionId()
    const startedAt = new Date().toISOString()
    // The model and the brief are snapshotted: an old transcript should show the
    // coach that actually produced it, not today's settings.
    insertSession({ id: sessionId, projectId, startedAt, model: project.model, instructions })

    live.set(sessionId, {
      sessionId,
      projectId,
      model: project.model,
      senderId: sender.id,
      secret,
      toolCalls: 0,
      searches: 0,
      started: Date.now(),
      releaseMic,
      releaseProject,
      owner
    })
    kept = true
    watchSender(sender)
    coachLog.info('Coach session started', { sessionId, projectId, model: project.model, voice: project.voice })

    // Note what is absent: the secret. The renderer never sees one.
    return {
      status: 'ok',
      sessionId,
      model: project.model,
      voice: project.voice,
      instructions,
      tools,
      startedAt
    }
  } finally {
    if (!kept) { releaseMic(); releaseProject() }
  }
}

function requireLive(sessionId: string): Live {
  const entry = live.get(sessionId)
  if (!entry) throw new Error('that session is not running')
  return entry
}

/** Roughly a minute of slack, so a secret does not expire mid-handshake. */
function expired(secret: ClientSecret): boolean {
  return secret.expiresAt * 1000 - Date.now() < 10_000
}

/**
 * The signalling round trip. Re-mints once if OpenAI refuses the secret, which
 * is what an expired one looks like from here.
 */
export async function connectSession(sessionId: string, offerSdp: string): Promise<{ answerSdp: string }> {
  const entry = requireLive(sessionId)
  const key = readKey()
  if (!key) throw new Error('no OpenAI key')

  const remint = async (): Promise<void> => {
    const project = requireProject(entry.projectId)
    entry.secret = await mintClientSecret(key, {
      model: project.model,
      voice: project.voice,
      instructions: selectSessionRow(sessionId)?.instructions ?? project.instructions,
      tools: toolsFor({ ...project, allowDelete: getCoachAllowDelete() })
    })
  }

  if (expired(entry.secret)) await remint()

  try {
    return { answerSdp: await exchangeSdp(entry.secret.value, offerSdp, entry.model) }
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status !== 401 && status !== 403) {
      coachLog.error('The coach could not connect', { sessionId, model: entry.model, error: err })
      throw err
    }
    // One retry, then give up: a loop here bills for nothing.
    coachLog.info('The session secret was refused; minting a new one', { sessionId, status })
    try {
      await remint()
      return { answerSdp: await exchangeSdp(entry.secret.value, offerSdp, entry.model) }
    } catch (retry) {
      coachLog.error('The coach could not connect', { sessionId, model: entry.model, error: retry })
      throw retry
    }
  }
}

/** The caps a tool call is checked against, and the counters behind them. */
export function toolCaps(sessionId: string): {
  toolCalls: number
  searches: number
  maxToolCalls: number
  maxSearches: number
} {
  const entry = requireLive(sessionId)
  return {
    toolCalls: entry.toolCalls,
    searches: entry.searches,
    maxToolCalls: MAX_TOOL_CALLS_PER_SESSION,
    maxSearches: MAX_WEB_SEARCHES_PER_SESSION
  }
}

export function countToolCall(sessionId: string, name: string): void {
  const entry = live.get(sessionId)
  if (!entry) return
  entry.toolCalls += 1
  if (name === 'web_search') entry.searches += 1
}

/**
 * Flushing turns mid-session. Deliberately tolerant of a session that has
 * already ended: the renderer flushes on a timer, and the last one can land
 * after the stop.
 */
export function flushTurns(sessionId: string, turns: readonly TranscriptTurn[]): void {
  if (!selectSessionRow(sessionId)) throw new Error('that session does not exist')
  saveTurns(sessionId, turns)
}

export function endSession(
  sessionId: string,
  outcome: { status: 'ended' | 'failed'; error?: string; turns?: readonly TranscriptTurn[] }
): CoachSessionSummary | null {
  if (outcome.turns?.length) {
    try {
      saveTurns(sessionId, outcome.turns)
    } catch {
      // A last flush that cannot land must not stop the session from closing.
    }
  }
  const entry = live.get(sessionId)
  if (entry) close(entry, outcome.status, outcome.error)
  else finishSession(sessionId, outcome.status, outcome.error)
  return selectSessionSummary(sessionId)
}

/** Session-bound metadata only; callers cannot write arbitrary log messages. */
export function assertCoachSender(sessionId: string, senderId: number): void {
  const entry = requireLive(sessionId)
  if (entry.senderId !== senderId || entry.owner !== requireUser()) throw new Error('This coach session belongs to another window or user.')
}
export function reportCoachResponse(sessionId: string, senderId: number, raw: CoachResponseDiagnostic): void {
  if (!live.has(sessionId)) return // a diagnostic can land just after teardown
  assertCoachSender(sessionId, senderId)
  if (!raw || !['response.started', 'response.done', 'speech.started', 'wrapup.started'].includes(raw.event)) throw new Error('Invalid coach diagnostic.')
  const entry = requireLive(sessionId)
  const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined
  const fields = {
    sessionId, projectId: entry.projectId, event: raw.event,
    responseId: identifier(raw.responseId), status: identifier(raw.status), reason: identifier(raw.reason),
    errorCode: identifier(raw.errorCode), errorType: identifier(raw.errorType),
    expected: raw.expected === true, wrappingUp: raw.wrappingUp === true,
    pendingTools: Number.isInteger(raw.pendingTools) ? Math.max(0, Math.min(60, raw.pendingTools!)) : 0
  }
  const logger = log.child('coach', { userId: entry.owner })
  if (raw.event === 'response.done' && ['cancelled', 'failed', 'incomplete'].includes(fields.status ?? '') && !fields.expected) logger.warn('Coach response interrupted', fields)
  else logger.info('Coach response lifecycle', fields)
}

/** Reserve the budget before awaiting, and hold the project through late tools. */
export async function executeCoachTool(sessionId: string, senderId: number, name: string, args: string): Promise<CoachToolResult> {
  assertCoachSender(sessionId, senderId)
  const entry = requireLive(sessionId)
  const release = holdCoachProject(entry.projectId)
  const logger = log.child('coach', { userId: entry.owner })
  const started = Date.now()
  try {
    const caps = toolCaps(sessionId)
    countToolCall(sessionId, name)
    const result = await runCoachTool(sessionId, name, args, caps)
    const fields = { sessionId, projectId: entry.projectId, tool: /^[a-z_]{1,40}$/.test(name) ? name : 'unknown', ok: result.ok, durationMs: Date.now() - started }
    if (result.ok) logger.info('Coach tool completed', fields)
    else logger.warn('Coach tool failed', fields)
    return result
  } finally { release() }
}
