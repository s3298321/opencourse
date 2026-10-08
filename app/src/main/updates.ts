/**
 * Updates of the app itself: is there a newer release, download it when asked,
 * and put it in place of this copy when the app quits.
 *
 * Off unless turned on. Automatic checks are a setting in updates.json, false
 * until someone ticks it in Settings, and while it is off the app never
 * contacts GitHub on its own - only when "Check for updates" is pressed. A
 * check is one GET of GitHub's releases API; a download happens only when the
 * learner presses Install.
 *
 * App-wide, like the log: every user here runs the same copy. The renderer is
 * told where things stand (AppUpdateStatus) and can ask to check or install,
 * but never names a URL or a version - the release stays in this module.
 *
 * The network half follows favicons.ts: net.request with manual redirects,
 * every hop checked against core/updates/policy.ts before it is followed, no
 * cookies, no referrer, nothing cached. The disk half is update-install.ts.
 */
import { app, net, powerMonitor } from 'electron'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { isLoopbackHost } from '../core/catalog/url'
import { DOWNLOAD_PAGE, parseRelease, releaseFeedUrl, type Release } from '../core/updates/release'
import { allowedUpdateUrl, checkDue, CHECK_INTERVAL_MS, installTarget, installTargetMessage, isNewer, notWritable, type InstallTarget } from '../core/updates/policy'
import type { AppUpdateInfo, AppUpdateStatus } from '../core/types'
import { log } from './log'
import { appUpdatesDir, appUpdatesFile } from './paths'
import { isolatedRun } from './run-mode'
import {
  backupPathFor,
  bundleIdentity,
  canReplace,
  helperArgs,
  stageUpdate,
  UpdateInstallError,
  writeHelper,
  type HelperResult
} from './update-install'

const logger = log.child('updates', { userId: null })

const FEED_TIMEOUT_MS = 15_000
const FEED_MAX_BYTES = 1024 * 1024
/** A download may take as long as it takes; what it may not do is stall. */
const DOWNLOAD_IDLE_MS = 60_000
const MAX_REDIRECTS = 3
/** The first automatic check waits for the app to settle. */
const FIRST_CHECK_MS = 60_000
const PROGRESS_EVERY_MS = 250

/** Tells ipc.ts to broadcast `appUpdate:changed`. */
export const updateEvents = new EventEmitter()

let automatic = false
let status: AppUpdateStatus = { state: 'idle' }
let checkedAt: number | null = null
/** The newer release last found. Never sent to the renderer whole. */
let release: Release | null = null
/** A staged bundle waiting for the app to quit, and whether to open it again. */
let pending: { target: string; staged: string; version: string; relaunch: boolean } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<unknown> | null = null
let started = false
/** Set by smoke and shots: a status shown without any network or disk. */
let simulated = false

/**
 * A test feed on this machine, for checking the whole path against a local
 * release (CLAUDE.md, "Changing updates"). It names its own digest, so in a
 * packaged build it amounts to "install whatever this server says" - for
 * someone who can already set the app's environment, which is to say who
 * already owns the account. Loopback only, and logged when used.
 */
function testFeed(): URL | null {
  const raw = process.env['OPENCOURSE_UPDATE_FEED']
  if (!raw) return null
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname) ? url : null
  } catch {
    return null
  }
}

/**
 * Whether this run may check and install at all. An isolated run (smoke,
 * shots, a live check) never reaches the network - but a test feed is this
 * machine, not the network, so an isolated run with one may: that is how the
 * whole path is checked end to end without a learner's profile.
 */
function updatesAllowed(): boolean {
  return !isolatedRun || testFeed() !== null
}

export function appUpdateInfo(): AppUpdateInfo {
  return { status, automatic, currentVersion: app.getVersion(), checkedAt, downloadUrl: DOWNLOAD_PAGE }
}

function set(next: AppUpdateStatus): void {
  status = next
  updateEvents.emit('changed')
}

function readSettings(): boolean {
  try {
    return (JSON.parse(readFileSync(appUpdatesFile(), 'utf8')) as { automatic?: unknown }).automatic === true
  } catch {
    return false
  }
}

function writeSettings(on: boolean): void {
  const file = appUpdatesFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ automatic: on }, null, 2))
  renameSync(tmp, file)
}

/** The bundle this copy would replace, or why it cannot. */
function target(): InstallTarget {
  const found = installTarget(app.getPath('exe'), app.isPackaged)
  if (!found.ok) return found
  return canReplace(found.bundle) ? found : { ok: false, reason: notWritable(found.bundle) }
}

/* --- requests -------------------------------------------------------------- */

interface Hop {
  url: string
  loopback: boolean
}

/**
 * Open a GET whose redirects are followed only to hosts the policy allows.
 * Resolves with the response once headers arrive; the caller reads the body.
 */
function open(start: Hop, accept: string, onAbort: (abort: () => void) => void): Promise<Electron.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (!allowedUpdateUrl(start.url, { loopback: start.loopback })) {
      reject(new Error('That address is not one updates come from.'))
      return
    }
    let hops = 0
    const request = net.request({
      url: start.url,
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store'
    })
    onAbort(() => request.abort())
    request.setHeader('Accept', accept)
    request.setHeader('User-Agent', `OpenCourse/${app.getVersion()} (macOS)`)
    request.on('redirect', (_status, _method, location) => {
      if (++hops > MAX_REDIRECTS || !allowedUpdateUrl(location, { loopback: start.loopback })) {
        request.abort()
        reject(new Error('The download was redirected somewhere updates do not come from.'))
        return
      }
      request.followRedirect()
    })
    request.on('response', resolve)
    request.on('error', reject)
    request.on('abort', () => reject(new Error('The request was stopped.')))
    request.end()
  })
}

async function fetchFeed(): Promise<{ status: number; body: unknown }> {
  const feed = testFeed()
  let abort = (): void => {}
  const timeout = setTimeout(() => abort(), FEED_TIMEOUT_MS)
  try {
    const response = await open(
      { url: feed ? feed.toString() : releaseFeedUrl(), loopback: Boolean(feed) },
      'application/vnd.github+json',
      (fn) => { abort = fn }
    )
    const chunks: Buffer[] = []
    let size = 0
    await new Promise<void>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > FEED_MAX_BYTES) { abort(); reject(new Error('The release feed was too large.')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve())
      response.on('error', reject)
    })
    if (response.statusCode !== 200) return { status: response.statusCode, body: null }
    try {
      return { status: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      return { status: 200, body: null }
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Stream the release's DMG to `file`, hashing as it goes. Throws unless what
 * arrived is exactly the published size and digest; the partial file is
 * removed either way.
 */
async function download(found: Release, file: string): Promise<void> {
  const part = `${file}.part`
  rmSync(part, { force: true })
  let abort = (): void => {}
  let idle: ReturnType<typeof setTimeout> | undefined
  const stall = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => abort(), DOWNLOAD_IDLE_MS)
  }
  stall()
  try {
    const response = await open({ url: found.asset.url, loopback: Boolean(testFeed()) }, 'application/octet-stream', (fn) => { abort = fn })
    if (response.statusCode !== 200) throw new Error(`GitHub answered ${response.statusCode}.`)
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    const stream = response as unknown as Readable
    let received = 0
    let reported = 0
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { abort(); out.destroy(); reject(error) }
      response.on('data', (chunk: Buffer) => {
        stall()
        received += chunk.length
        if (received > found.asset.size) { fail(new Error('The download is larger than the release says.')); return }
        hash.update(chunk)
        // Backpressure: the network is faster than the disk is willing to be told.
        if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()) }
        const now = Date.now()
        if (now - reported >= PROGRESS_EVERY_MS) {
          reported = now
          set({ state: 'downloading', version: found.version, received, total: found.asset.size })
        }
      })
      response.on('end', () => out.end(() => resolve()))
      response.on('error', fail)
      out.on('error', fail)
    })
    if (received !== found.asset.size) throw new Error('The download stopped before it was complete.')
    if (hash.digest('hex') !== found.asset.sha256) throw new Error('The download does not match the release it came from.')
    renameSync(part, file)
  } finally {
    clearTimeout(idle)
    rmSync(part, { force: true })
  }
}

/* --- checking -------------------------------------------------------------- */

function schedule(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!automatic || !updatesAllowed()) return
  timer = setTimeout(() => void checkForAppUpdate(false), delay)
  timer.unref?.()
}

function availableStatus(found: Release): AppUpdateStatus {
  const where = target()
  return {
    state: 'available',
    version: found.version,
    size: found.asset.size,
    notesUrl: found.notesUrl,
    installable: where.ok,
    ...(where.ok ? {} : { reason: installTargetMessage(where.reason) })
  }
}

/**
 * One check. `manual` is a press of "Check for updates": it reports a failure,
 * where an automatic check that cannot reach GitHub just tries again later.
 */
export async function checkForAppUpdate(manual: boolean): Promise<AppUpdateInfo> {
  if (simulated || !updatesAllowed()) return appUpdateInfo()
  // A download or install in progress is the answer already.
  if (inFlight || ['downloading', 'verifying', 'ready'].includes(status.state)) return appUpdateInfo()
  // What an automatic check that could not get an answer leaves on screen:
  // whatever was there, rather than an error nobody asked to see.
  const quiet: AppUpdateStatus = status.state === 'checking' || status.state === 'error' ? { state: 'idle' } : status
  set({ state: 'checking' })
  const t0 = Date.now()
  const feed = testFeed()
  if (feed) logger.warn('Checking a test update feed', { host: feed.host })
  try {
    const { status: code, body } = await fetchFeed()
    checkedAt = Date.now()
    if (code === 404) {
      // No release published yet.
      release = null
      set({ state: 'current' })
    } else if (code !== 200) {
      logger.info('Update check refused', { status: code, ms: Date.now() - t0 })
      set(manual ? { state: 'error', message: code === 403 || code === 429 ? 'GitHub asked to wait before checking again. Try later.' : `GitHub answered ${code}.` } : quiet)
    } else {
      const found = parseRelease(body, feed ? { feedOrigin: `${feed.origin}/` } : {})
      if (!found) {
        logger.warn('The latest release is not one this app can install', { ms: Date.now() - t0 })
        release = null
        set(manual ? { state: 'error', message: 'The latest release could not be read.' } : quiet)
      } else if (isNewer(app.getVersion(), found.version)) {
        release = found
        logger.info('Update available', { current: app.getVersion(), version: found.version, size: found.asset.size, ms: Date.now() - t0 })
        set(availableStatus(found))
      } else {
        release = null
        set({ state: 'current' })
      }
    }
  } catch (error) {
    checkedAt = Date.now()
    logger.info('Update check failed', { error: String((error as Error).message ?? error), ms: Date.now() - t0 })
    set(manual ? { state: 'error', message: 'Could not reach GitHub to check for updates.' } : quiet)
  }
  schedule(CHECK_INTERVAL_MS)
  return appUpdateInfo()
}

export function setAppUpdateAutomatic(on: boolean): AppUpdateInfo {
  automatic = on === true
  if (!isolatedRun) writeSettings(automatic)
  logger.info('Automatic update checks changed', { automatic })
  if (automatic && checkDue(checkedAt, Date.now())) void checkForAppUpdate(false)
  else schedule(CHECK_INTERVAL_MS)
  updateEvents.emit('changed')
  return appUpdateInfo()
}

/* --- installing ------------------------------------------------------------ */

/**
 * Download, check, stage, then quit so the helper can swap.
 *
 * Refused before anything is downloaded while quitting would lose something:
 * unsaved course edits, or a live Coach session. Every before-quit handler runs
 * even when a quit is then refused - shells are killed, answers stopped - so a
 * restart that a "Keep editing" dialog was going to cancel must not start.
 */
export async function installAppUpdate(): Promise<AppUpdateInfo> {
  if (simulated || !updatesAllowed()) return appUpdateInfo()
  if (pending) {
    // Already staged: this press is "Restart to update".
    pending.relaunch = true
    app.quit()
    return appUpdateInfo()
  }
  const found = release
  if (!found || inFlight) return appUpdateInfo()
  const where = target()
  if (!where.ok) {
    set(availableStatus(found))
    return appUpdateInfo()
  }
  const blocker = await whyNotNow()
  if (blocker) {
    set({ state: 'blocked', version: found.version, size: found.asset.size, notesUrl: found.notesUrl, reason: blocker })
    return appUpdateInfo()
  }

  const work = (async () => {
    const dir = appUpdatesDir()
    mkdirSync(dir, { recursive: true })
    const dmg = join(dir, `OpenCourse-${found.version}.dmg`)
    const t0 = Date.now()
    try {
      set({ state: 'downloading', version: found.version, received: 0, total: found.asset.size })
      await download(found, dmg)
      logger.info('Update downloaded', { version: found.version, size: found.asset.size, ms: Date.now() - t0 })
      set({ state: 'verifying', version: found.version })
      const self = await bundleIdentity(where.bundle)
      const staged = await stageUpdate(dmg, where.bundle, { bundleId: self.bundleId, version: found.version, teamId: self.teamId })
      pending = { target: where.bundle, staged, version: found.version, relaunch: true }
      logger.info('Update staged; restarting to install it', { version: found.version, signed: Boolean(self.teamId), ms: Date.now() - t0 })
      set({ state: 'ready', version: found.version })
    } catch (error) {
      const message = error instanceof UpdateInstallError || error instanceof Error ? error.message : String(error)
      logger.warn('Update failed', { version: found.version, code: error instanceof UpdateInstallError ? error.code : 'download', error: message })
      set({ state: 'error', message, version: found.version, notesUrl: found.notesUrl })
    } finally {
      rmSync(dmg, { force: true })
    }
  })()
  inFlight = work
  try {
    await work
  } finally {
    inFlight = null
  }
  // A last look before quitting: a Coach session may have started while it
  // downloaded. Then it waits as "Restart to update" for a better moment.
  const armed = armedInstall()
  if (armed) {
    const blocker = await whyNotNow()
    if (blocker) {
      armed.relaunch = false
      set({ state: 'ready', version: armed.version })
    } else app.quit()
  }
  return appUpdateInfo()
}

/** Read through a function: it is set inside the download's async work, which narrowing cannot see. */
function armedInstall(): typeof pending {
  return pending
}

async function whyNotNow(): Promise<string | null> {
  const [{ anySessionDirty }, { liveSessionCount }] = await Promise.all([import('./edit-sessions'), import('./coachsession')])
  if (anySessionDirty()) return 'A course has unsaved edits. Save or discard them, then install the update.'
  if (liveSessionCount() > 0) return 'A Coach session is live. End it, then install the update.'
  return null
}

/** The window's "Keep editing" refused the quit: install on the next ordinary quit, without reopening. */
export function quitVetoed(): void {
  if (!pending) return
  pending.relaunch = false
  logger.info('Restart refused; the update installs at the next quit', { version: pending.version })
}

/**
 * will-quit: the quit is certain. Hand the staged bundle to the helper, which
 * waits for this process to exit before touching anything.
 */
export function runPendingInstall(): void {
  if (!pending || !updatesAllowed()) return
  try {
    const dir = appUpdatesDir()
    mkdirSync(dir, { recursive: true })
    const script = writeHelper(dir)
    // Never reopened after an isolated run: that would be an ordinary launch,
    // on the learner's real profile.
    const relaunch = pending.relaunch && !isolatedRun
    const child = spawn('/bin/sh', helperArgs(script, {
      pid: process.pid,
      target: pending.target,
      staged: pending.staged,
      result: join(dir, 'result.json'),
      relaunch,
      version: pending.version
    }), { detached: true, stdio: 'ignore' })
    child.unref()
    logger.info('Update helper started', { version: pending.version, relaunch })
  } catch (error) {
    logger.error('Update helper did not start', { error: String((error as Error).message ?? error) })
  }
  pending = null
}

/* --- startup --------------------------------------------------------------- */

/** What the helper said last time, and the debris of anything that did not finish. */
function settleLastInstall(): void {
  const dir = appUpdatesDir()
  const resultFile = join(dir, 'result.json')
  const here = installTarget(app.getPath('exe'), app.isPackaged)
  if (existsSync(resultFile)) {
    let result: HelperResult | null = null
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) as HelperResult } catch { result = null }
    rmSync(resultFile, { force: true })
    if (result?.ok && result.version === app.getVersion()) {
      logger.info('Update installed', { version: result.version })
    } else if (result) {
      logger.warn('Update did not install', { version: result.version, reason: result.reason })
      status = {
        state: 'error',
        version: result.version,
        message: result.reason === 'move-refused'
          ? 'macOS did not let OpenCourse replace itself. Allow it under System Settings ▸ Privacy & Security ▸ App Management, or download the new version.'
          : 'The update did not finish installing. This is still the version you had.'
      }
    }
  }
  if (here.ok) {
    // The previous version kept by a swap, and any staged copy never swapped
    // in: a staged update that did not install is simply downloaded again.
    rmSync(backupPathFor(here.bundle), { recursive: true, force: true })
    try {
      for (const name of readdirSync(dirname(here.bundle))) {
        if (/^\.OpenCourse-\d+\.\d+\.\d+\.app$/.test(name)) rmSync(join(dirname(here.bundle), name), { recursive: true, force: true })
      }
    } catch { /* A directory we cannot list holds nothing of ours. */ }
  }
  try {
    for (const name of readdirSync(dir)) if (/\.dmg(\.part)?$/.test(name)) rmSync(join(dir, name), { force: true })
  } catch { /* No updates directory yet. */ }
}

export function startUpdates(): void {
  if (started || !updatesAllowed()) return
  started = true
  automatic = readSettings()
  settleLastInstall()
  if (status.state === 'error') updateEvents.emit('changed')
  schedule(FIRST_CHECK_MS)
  powerMonitor.on('resume', () => {
    if (automatic && checkDue(checkedAt, Date.now())) schedule(FIRST_CHECK_MS)
  })
}

/**
 * Smoke and shots: show a status without a network, a download or a disk -
 * the titlebar button and the Settings section are what they check. Null goes
 * back to nothing to report.
 */
export function simulateAppUpdate(next: AppUpdateStatus | null): void {
  simulated = next !== null
  set(next ?? { state: 'idle' })
}
