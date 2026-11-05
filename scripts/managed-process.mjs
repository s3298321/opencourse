import { spawn } from 'node:child_process'
import { constants } from 'node:os'

export const signalCode = signal => 128 + (constants.signals[signal] ?? 1)

// npm, electron-vite and Electron each add children. Give each launch its own
// process group, and keep owning that group even after its launcher exits.
export function startManaged(command, args, options = {}) {
  const { timeoutMs = 0, graceMs = 2000, ...spawnOptions } = options
  const child = spawn(command, args, { ...spawnOptions, detached: true })
  let result
  let exited = false
  let stopping = false
  let forced = false
  let poll, force, deadline
  let resolveFinished
  const finished = new Promise(resolve => { resolveFinished = resolve })

  function signalGroup(signal) {
    if (!child.pid) return false
    try { process.kill(-child.pid, signal); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }

  function finish() {
    clearInterval(poll)
    clearTimeout(force)
    clearTimeout(deadline)
    process.off('exit', emergencyCleanup)
    resolveFinished(result)
  }

  function check() {
    if (exited && (forced || !signalGroup(0))) finish()
  }

  function stop(code) {
    if (code !== undefined) result ??= code
    if (stopping) return
    stopping = true
    clearTimeout(deadline)
    signalGroup('SIGTERM')
    poll = setInterval(check, 25)
    force = setTimeout(() => {
      signalGroup('SIGKILL')
      forced = true
      // The launcher has usually exited already; its remaining helpers may
      // ignore TERM. Don't let them outlive the supervisor.
      if (exited) finish()
    }, graceMs)
    check()
  }

  function emergencyCleanup() { signalGroup('SIGKILL') }
  process.on('exit', emergencyCleanup)
  child.once('error', error => {
    console.error(`Could not launch ${command}: ${error.message}`)
    result ??= 1
    exited = true
    stop()
  })
  child.once('exit', (code, signal) => {
    result ??= code ?? signalCode(signal)
    exited = true
    stop()
    check()
  })
  if (timeoutMs > 0) deadline = setTimeout(() => {
    console.error(`${command} timed out after ${timeoutMs / 1000}s; stopping its process group.`)
    stop(124)
  }, timeoutMs)

  return { child, finished, stop }
}
