/**
 * A live coaching session, from main's side.
 *
 * Main holds three things the renderer must not: the API key, the configuration
 * snapshot, and the record of what is running. The renderer owns the peer
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
import { buildLiveInstructions, buildBackendInstructions } from '../core/coach/prompt'
import { MAX_TOOL_CALLS_PER_SESSION, MAX_WEB_SEARCHES_PER_SESSION, toolsFor } from '../core/coach/tools'
import type { CoachSessionSummary, CoachStartResult, TranscriptTurn } from '../core/types'
import { requireProject } from './coach'
import { finishSession, insertSession, saveTurns, saveFragments, updateSessionMetadata, recordToolCall, selectSessionRow, selectSessionSummary } from './coachdb'
import { listFiles } from './coachfiles'
import { readKey } from './coachkey'
import { holdMic } from './mic'
import { createLiveSession, type LiveSessionConfig } from './openai'
import { isLiveModelId } from '../core/coach/models'
import type { CoachTranscriptFragment, CoachSessionMetadata, CoachEndOutcome } from '../core/types'
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
  config: LiveSessionConfig
  connection?: Promise<{ answerSdp: string; remoteSessionId: string }>
  calls: Map<string, { name: string; args: string; result: Promise<CoachToolResult> }>
  sender: WebContents
  toolCalls: number
  searches: number
  started: number
  releaseMic: () => void
  releaseProject: () => void
  owner: string
}

const live = new Map<string, Live>()
const owners = new Map<string, { owner: string; senderId: number }>()
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
    if (selectSessionSummary(entry.sessionId)?.metadata?.finalization === 'pending') updateSessionMetadata(entry.sessionId, { finalization: 'unconfirmed' })
    finishSession(entry.sessionId, status, error)
  } catch {
    // The database may already be closed on the way out of the app. The sweep
    // on the next open is what covers this.
  }
}

function notifyShutdown(entry: Live): void {
  try { if (!entry.sender.isDestroyed?.()) entry.sender.send?.('coach:shutdown', entry.sessionId) } catch { /* A destroyed renderer cannot receive shutdown. */ }
}

export function endForSender(senderId: number, reason: string): void {
  for (const entry of [...live.values()]) {
    if (entry.senderId === senderId) { notifyShutdown(entry); close(entry, 'failed', reason) }
  }
}

export function endAllSessions(): void {
  for (const entry of [...live.values()]) { notifyShutdown(entry); close(entry, 'failed', 'OpenCourse quit') }
}

app.on('before-quit', endAllSessions)

export function liveSessionCount(): number {
  return live.size
}

/**
 * Starts a session, in the order that wastes the least.
 *
 * OS permission is checked here; the renderer acquires and validates the actual
 * microphone before connectSession creates a remote, billable session.
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
    if (!isLiveModelId(project.model)) throw new Error('Choose a supported GPT-Live model in this coach’s settings.')
    if (sender.isDestroyed?.()) throw new Error('The window closed while connecting.')
    const instructions = buildLiveInstructions(effectiveProject)
    const backendInstructions = buildBackendInstructions(effectiveProject, listFiles(projectId))
    const tools = toolsFor(effectiveProject)

    const config: LiveSessionConfig = { model: project.model, voice: project.voice, instructions, backendModel: project.backendModel, backendInstructions, tools }

    if (currentUserId() !== owner) { releaseMic(); throw new Error('The user changed while connecting.') }
    const sessionId = newSessionId()
    const startedAt = new Date().toISOString()
    // The model and the brief are snapshotted: an old transcript should show the
    // coach that actually produced it, not today's settings.
    insertSession({ id: sessionId, projectId, startedAt, model: project.model, instructions })
    updateSessionMetadata(sessionId, { backendModel: project.backendModel, backendInstructions, backendSettings: { reasoning: 'default', toolChoice: 'auto', parallelToolCalls: false, tools: tools.map(tool => tool.name) }, voice: project.voice, finalization: 'pending' })
    owners.set(sessionId, { owner, senderId: sender.id })

    live.set(sessionId, {
      sessionId,
      projectId,
      model: project.model,
      senderId: sender.id,
      config, calls: new Map(), sender,
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
      backendModel: project.backendModel, backendInstructions,
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

/** Freeze config at start and reuse the same promise, including failures. */
export async function connectSession(sessionId: string, offerSdp: string, senderId?: number): Promise<{ answerSdp: string; remoteSessionId: string }> {
  const entry = requireLive(sessionId)
  assertCoachSender(sessionId, senderId ?? entry.senderId)
  if (typeof offerSdp !== 'string' || offerSdp.length > 131072 || !offerSdp.includes('v=0')) throw new Error('Invalid connection offer.')
  if (!entry.connection) {
    const key = readKey()
    if (!key) throw new Error('no OpenAI key')
    entry.connection = createLiveSession(key, entry.config, offerSdp).then(result => {
      // Return even after stop so the renderer can finish the handshake and close it.
      if (currentUserId() === entry.owner) updateSessionMetadata(sessionId, { remoteSessionId: result.remoteSessionId })
      return result
    })
  }
  return entry.connection
}

/** Late final flushes belong to the same window and user as the original session. */
export function assertCoachOwner(sessionId: string, senderId: number): void {
  const owner = owners.get(sessionId)
  if (!owner || owner.senderId !== senderId || owner.owner !== requireUser()) throw new Error('This coach session belongs to another window or user.')
}

export function flushFragments(sessionId: string, fragments: readonly CoachTranscriptFragment[], metadata?: CoachSessionMetadata): void {
  saveFragments(sessionId, fragments)
  if (metadata) updateSessionMetadata(sessionId, validatedMetadata(metadata))
}

function validatedMetadata(raw: CoachSessionMetadata): CoachSessionMetadata {
  const result: CoachSessionMetadata = {}
  if (typeof raw.voiceSeconds === 'number' && Number.isFinite(raw.voiceSeconds) && raw.voiceSeconds >= 0) result.voiceSeconds = raw.voiceSeconds
  if (['pending', 'confirmed', 'unconfirmed'].includes(raw.finalization ?? '')) result.finalization = raw.finalization
  if (typeof raw.closeReason === 'string' && /^[a-z_]{1,60}$/.test(raw.closeReason)) result.closeReason = raw.closeReason
  if (raw.backendUsage && Object.values(raw.backendUsage).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
    result.backendUsage = { inputTokens: raw.backendUsage.inputTokens, outputTokens: raw.backendUsage.outputTokens, totalTokens: raw.backendUsage.totalTokens }
  }
  return result
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
  outcome: CoachEndOutcome
): CoachSessionSummary | null {
  if (outcome.fragments?.length) saveFragments(sessionId, outcome.fragments)
  if (outcome.metadata) updateSessionMetadata(sessionId, validatedMetadata(outcome.metadata))
  if (outcome.turns?.length) {
    try {
      saveTurns(sessionId, outcome.turns)
    } catch {
      // A last flush that cannot land must not stop the session from closing.
    }
  }
  const entry = live.get(sessionId)
  if (entry) close(entry, outcome.status, outcome.error)
  else if (selectSessionRow(sessionId)?.status === 'live') finishSession(sessionId, outcome.status, outcome.error)
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
  if (!raw || !['response.started', 'response.done', 'speech.started', 'wrapup.started', 'session.error'].includes(raw.event)) throw new Error('Invalid coach diagnostic.')
  const entry = requireLive(sessionId)
  const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined
  const fields = {
    sessionId, projectId: entry.projectId, event: raw.event,
    responseId: identifier(raw.responseId), status: identifier(raw.status), reason: identifier(raw.reason),
    clientEventId: identifier(raw.clientEventId),
    errorCode: identifier(raw.errorCode), errorType: identifier(raw.errorType),
    expected: raw.expected === true, wrappingUp: raw.wrappingUp === true,
    pendingTools: Number.isInteger(raw.pendingTools) ? Math.max(0, Math.min(60, raw.pendingTools!)) : 0
  }
  const logger = log.child('coach', { userId: entry.owner })
  if (raw.event === 'session.error') logger.warn('Coach session request failed', fields)
  else if (raw.event === 'response.done' && ['cancelled', 'failed', 'incomplete'].includes(fields.status ?? '') && !fields.expected) logger.warn('Coach response interrupted', fields)
  else logger.info('Coach response lifecycle', fields)
}

/** Reserve the budget before awaiting, and hold the project through late tools. */
export async function executeCoachTool(sessionId: string, senderId: number, name: string, args: string, callId?: string): Promise<CoachToolResult> {
  assertCoachSender(sessionId, senderId)
  const entry = requireLive(sessionId)
  const id = callId ?? `local_${entry.toolCalls}`
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) throw new Error('Invalid tool call identity.')
  const existing = entry.calls.get(id)
  if (existing) {
    if (existing.name !== name || existing.args !== args) throw new Error('Tool call identity was reused with different arguments.')
    return existing.result
  }
  const release = holdCoachProject(entry.projectId)
  const logger = log.child('coach', { userId: entry.owner })
  const started = Date.now()
  const caps = toolCaps(sessionId)
  countToolCall(sessionId, name)
  const seq = entry.toolCalls
  // Reserve identity before entering asynchronous tool execution.
  const result = Promise.resolve().then(async () => {
    if (currentUserId() !== entry.owner) return { ok: false, output: '{"ok":false,"error":"The user changed."}', summary: 'Tool cancelled because the user changed.' }
    return runCoachTool(sessionId, name, args, caps)
  }).then(result => {
    if (currentUserId() === entry.owner) recordToolCall(sessionId, { seq, callId: id, name, arguments: args, result: result.output, ok: result.ok, at: new Date().toISOString() })
    const fields = { sessionId, projectId: entry.projectId, tool: /^[a-z_]{1,40}$/.test(name) ? name : 'unknown', ok: result.ok, durationMs: Date.now() - started }
    if (result.ok) logger.info('Coach tool completed', fields)
    else logger.warn('Coach tool failed', fields)
    return result
  }).finally(release)
  entry.calls.set(id, { name, args, result })
  return result
}
