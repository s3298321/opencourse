/**
 * Interactive terminals for the workbench.
 *
 * A pty is bound to the renderer that asked for it and to the mount that owns
 * it: there is no reattach. The renderer can be destroyed by a reload (Cmd-R is
 * in the View menu), by navigating to another lesson, or by quitting, and in
 * every one of those cases the shell must die with it rather than write into a
 * dead frame.
 */
import { app, type WebContents } from 'electron'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { childEnv } from '../core/runner'
import { resolve, sep } from 'node:path'
import { getToolchain } from '../core/toolchains'
import { resolveLoginPath } from './toolchain'

/** Chunks are coalesced: `find /` in a terminal will otherwise flood the IPC. */
const FLUSH_MS = 12
const MAX_PENDING_BYTES = 256 * 1024
const HIGH_WATER = 1024 * 1024

interface Session {
  pty: IPty
  cwd: string
  sender: WebContents
  pending: string[]
  pendingBytes: number
  timer: NodeJS.Timeout | null
  paused: boolean
  disposed: boolean
}

const sessions = new Map<string, Session>()
const watched = new WeakSet<WebContents>()

function key(sender: WebContents, sessionId: string): string {
  return `${sender.id}:${sessionId}`
}

function flush(id: string, session: Session): void {
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  if (!session.pending.length) return
  const data = session.pending.join('')
  session.pending = []
  session.pendingBytes = 0
  if (!session.sender.isDestroyed()) session.sender.send('pty:data', id.split(':')[1], data)
  if (session.paused) {
    session.paused = false
    session.pty.resume()
  }
}

/**
 * Everything that can kill a renderer out from under a live shell. Registered
 * once per WebContents; `window-all-closed` is deliberately not one of them,
 * because on macOS it never fires.
 */
function watchSender(sender: WebContents): void {
  if (watched.has(sender)) return
  watched.add(sender)
  const killAll = (): void => disposeForSender(sender)
  sender.once('destroyed', killAll)
  sender.on('render-process-gone', killAll)
  sender.on('did-start-navigation', (event) => {
    if (event.isMainFrame && event.isSameDocument === false) killAll()
  })
}

export interface CreatePtyOptions {
  sessionId: string
  cwd: string
  /** Absent for a toolchain with nothing to activate, such as C. */
  envDir?: string
  /** Which toolchain's environment this is, so its env vars come along. */
  language?: string
  cols: number
  rows: number
}

export async function createPty(sender: WebContents, options: CreatePtyOptions): Promise<{ ok: boolean; error?: string }> {
  killPty(sender, options.sessionId)
  watchSender(sender)

  const shell = process.env['SHELL'] || '/bin/zsh'
  // The environment leads PATH rather than going through a generated ZDOTDIR:
  // redirecting ZDOTDIR would also lose the user's own startup files. The
  // toolchain's own vars (VIRTUAL_ENV and friends) make the prompt and `which
  // python` agree.
  const toolchain = getToolchain(options.language)
  const envDir = options.envDir
  const binDir = envDir && toolchain.provision ? [toolchain.provision.binDir(envDir)] : []
  const env = childEnv({
    base: process.env,
    pathDirs: [...binDir, await resolveLoginPath()],
    term: 'xterm-256color',
    extra: toolchain.extraEnv({ envDir })
  })

  let pty: IPty
  try {
    pty = spawnPty(shell, ['-i'], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: Math.max(2, options.cols),
      rows: Math.max(1, options.rows),
      env
    })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const id = key(sender, options.sessionId)
  const session: Session = { pty, cwd: options.cwd, sender, pending: [], pendingBytes: 0, timer: null, paused: false, disposed: false }
  sessions.set(id, session)

  pty.onData((chunk) => {
    session.pending.push(chunk)
    session.pendingBytes += chunk.length
    if (session.pendingBytes > HIGH_WATER && !session.paused) {
      session.paused = true
      pty.pause()
    }
    if (session.pendingBytes >= MAX_PENDING_BYTES) flush(id, session)
    else session.timer ??= setTimeout(() => flush(id, session), FLUSH_MS)
  })

  pty.onExit(({ exitCode }) => {
    flush(id, session)
    sessions.delete(id)
    if (!session.sender.isDestroyed()) session.sender.send('pty:exit', options.sessionId, exitCode)
  })

  return { ok: true }
}

export function writePty(sender: WebContents, sessionId: string, data: string): void {
  sessions.get(key(sender, sessionId))?.pty.write(data)
}

export function resizePty(sender: WebContents, sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(key(sender, sessionId))
  if (!session) return
  try {
    session.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  } catch {
    /* the shell exited between the resize and here */
  }
}

export function killPty(sender: WebContents, sessionId: string): void {
  const id = key(sender, sessionId)
  const session = sessions.get(id)
  if (!session || session.disposed) return
  session.disposed = true
  if (session.timer) clearTimeout(session.timer)
  sessions.delete(id)
  try {
    session.pty.kill()
  } catch {
    /* already gone */
  }
}

export function disposeForSender(sender: WebContents): void {
  for (const [id, session] of [...sessions]) {
    if (session.sender !== sender) continue
    sessions.delete(id)
    if (session.timer) clearTimeout(session.timer)
    try {
      session.pty.kill()
    } catch {
      /* already gone */
    }
  }
}

export function disposeAllPtys(): void {
  for (const [id, session] of [...sessions]) {
    sessions.delete(id)
    if (session.timer) clearTimeout(session.timer)
    try {
      session.pty.kill()
    } catch {
      /* already gone */
    }
  }
}

export function disposePtysInDirectory(directory: string): void {
  const root = resolve(directory)
  for (const [id, session] of [...sessions]) {
    const cwd = resolve(session.cwd)
    if (cwd === root || cwd.startsWith(root + sep)) killPty(session.sender, id.split(':')[1]!)
  }
}

/** Test seam: how many shells are still alive. */
export function ptySessionCount(): number {
  return sessions.size
}

app.on('before-quit', disposeAllPtys)
