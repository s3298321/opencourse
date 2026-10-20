// `npm run dev` at the root: the app, the server and the website, each by its
// own `npm run dev`, with their output prefixed. Together they are one local
// world - the app signed in to the local server, the site's catalog links
// leading to the server's web app - and none of it touches the deployed one.
//
//   npm run dev                      all three
//   npm run dev -- --only app,server  some of them
//
// One of them stopping leaves the others running on purpose: an app whose
// server has gone away should say so and carry on, and this is where you see
// that it does. Ctrl-C stops them all.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ALL = ['server', 'site', 'app']
const COLOURS = { server: 36, site: 35, app: 33 }

const flag = process.argv.indexOf('--only')
const only = flag >= 0 ? (process.argv[flag + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : ALL
const unknown = only.filter((name) => !ALL.includes(name))
if (unknown.length || !only.length) {
  console.error(`--only takes a comma-separated list of ${ALL.join(', ')}; got ${unknown.join(', ') || 'nothing'}.`)
  process.exit(2)
}

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`OpenCourse needs Node 22 (this is ${process.versions.node}). With nvm: nvm use 22, or put ~/.nvm/versions/node/v22.22.0/bin first on PATH.`)
  process.exit(1)
}
const missing = only.filter((name) => !existsSync(resolve(root, name, 'node_modules')))
if (missing.length) {
  console.error(`Install dependencies first: ${missing.map((name) => `(cd ${name} && npm install)`).join(' ; ')}`)
  process.exit(1)
}

const children = new Map()
let stopping = false

function prefixed(name, stream, target) {
  const label = process.stdout.isTTY ? `\x1b[${COLOURS[name]}m${name.padEnd(6)}\x1b[0m│ ` : `${name.padEnd(6)}| `
  let rest = ''
  stream.on('data', (chunk) => {
    const lines = (rest + chunk.toString()).split('\n')
    rest = lines.pop()
    for (const line of lines) target.write(label + line + '\n')
  })
  stream.on('end', () => { if (rest) target.write(label + rest + '\n') })
}

for (const name of only) {
  // FORCE_COLOR keeps the children's own colours through the pipe.
  const child = spawn('npm', ['run', 'dev'], { cwd: resolve(root, name), env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.set(name, child)
  prefixed(name, child.stdout, process.stdout)
  prefixed(name, child.stderr, process.stderr)
  child.on('exit', (code, signal) => {
    children.delete(name)
    if (!stopping) console.log(`${name} stopped (${signal ?? `exit ${code}`}); the others keep running.`)
    if (!children.size) process.exit(0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    for (const child of children.values()) child.kill('SIGTERM')
  })
}
