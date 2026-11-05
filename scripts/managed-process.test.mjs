import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const runner = fileURLToPath(new URL('./run-managed.mjs', import.meta.url))
const helper = `
  process.on('SIGTERM', () => {});
  process.send(process.pid);
  setInterval(() => {}, 1000);
`

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

async function gone(pid) {
  for (let n = 0; n < 100 && alive(pid); n++) await delay(25)
  assert.equal(alive(pid), false, `process ${pid} was left behind`)
}

async function launch(t, { exitCode, timeout = false, rootDev = false } = {}) {
  const source = `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    helper.once('message', pid => {
      console.log(JSON.stringify({ launcher: process.pid, helper: pid }));
      ${exitCode === undefined ? '' : `process.exit(${exitCode});`}
    });
    setInterval(() => {}, 1000);
  `
  let args = [runner, ...(timeout ? ['--timeout-ms', '1000'] : []), '--', process.execPath, '-e', source]
  let env = process.env
  if (rootDev) {
    // Exercise the actual root launcher without starting the app or servers.
    // npm's stand-in still creates the nested supervisor used by app/package.json.
    const bin = mkdtempSync(join(tmpdir(), 'opencourse-process-test-'))
    t.after(() => rmSync(bin, { recursive: true, force: true }))
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node\nrequire('node:child_process').spawn(process.execPath, ${JSON.stringify(args)}, { stdio: 'inherit' });\n`, { mode: 0o755 })
    env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }
    args = [fileURLToPath(new URL('./dev.mjs', import.meta.url)), '--only', 'app']
  }
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let pids
  t.after(() => {
    child.kill('SIGKILL')
    if (pids) for (const pid of Object.values(pids)) {
      try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  })
  let output = ''
  for await (const chunk of child.stdout) {
    output += chunk
    if (output.includes('\n')) {
      const line = output.split('\n')[0]
      pids = JSON.parse(line.slice(line.indexOf('{')))
      break
    }
  }
  assert.ok(pids, 'fixture should start both launcher and helper')
  return { child, exited, pids }
}

for (const exitCode of [0, 7]) {
  test(`launcher exit ${exitCode} cleans up a helper that ignores SIGTERM`, { timeout: 10000 }, async t => {
    const { exited, pids } = await launch(t, { exitCode })
    assert.deepEqual(await exited, [exitCode, null])
    await Promise.all(Object.values(pids).map(gone))
  })
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${signal} stops the launcher's descendants`, { timeout: 10000 }, async t => {
    const { child, exited, pids } = await launch(t)
    child.kill(signal)
    assert.deepEqual(await exited, [code, null])
    await Promise.all(Object.values(pids).map(gone))
  })
}

test('external timeout kills a hung run without touching an unrelated process', { timeout: 10000 }, async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const unrelatedExited = once(unrelated, 'exit')
  t.after(async () => { unrelated.kill('SIGKILL'); await unrelatedExited })
  const { exited, pids } = await launch(t, { timeout: true })
  assert.deepEqual(await exited, [124, null])
  await Promise.all(Object.values(pids).map(gone))
  assert.equal(alive(unrelated.pid), true)
})

test('a failed spawn returns failure and does not hang', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [runner, '--', '/does-not-exist/opencourse-test'], { stdio: 'ignore' })
  assert.deepEqual(await once(child, 'exit'), [1, null])
})

test('root dev shutdown waits for the nested app supervisor to clean up', { timeout: 10000 }, async t => {
  const { child, exited, pids } = await launch(t, { rootDev: true })
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [143, null])
  await Promise.all(Object.values(pids).map(gone))
})
