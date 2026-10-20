// `npm run dev`: the API (tsx, :8787, restarting on change) and the web app
// (Vite, :5173, handing /api to the API). Open the address Vite prints; a
// `npm run dev` desktop app is already connected to :8787. Ctrl-C stops both.
//
// It is a local world of its own: its data is server/data (npm run dev:reset
// empties it), its links lead to the local website (site/, :4321) rather than
// opencourse.dev, and its name says it is not the public catalog. Each of
// those is only a default - an environment variable already set wins.
//
// Once the API answers, scripts/seed.ts fills it from docs/: accounts, the
// example course and the example document. It publishes nothing twice, so a
// restart costs a few logins. OPENCOURSE_DEV_SEED=0 starts empty instead.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const here = (path) => resolve(import.meta.dirname, '..', path)
const bin = (name) => here(`node_modules/.bin/${name}`)
const defaults = {
  OPENCOURSE_SERVER_DEV: '1',
  OPENCOURSE_SERVER_DATA: here('data'),
  OPENCOURSE_SERVER_NAME: 'OpenCourse (local dev)',
  OPENCOURSE_SERVER_PUBLIC_URL: 'http://localhost:5173',
  OPENCOURSE_SERVER_APP_URL: 'http://localhost:4321/download',
  OPENCOURSE_SERVER_SITE_URL: 'http://localhost:4321',
  OPENCOURSE_SEED_SAMPLES: '1'
}
const env = { ...defaults, ...process.env }
// Vite serves the web app with no server-written page, so it learns the same
// two links from these (web/src/lib/boot.ts).
env.VITE_OPENCOURSE_APP_URL ??= env.OPENCOURSE_SERVER_APP_URL
env.VITE_OPENCOURSE_SITE_URL ??= env.OPENCOURSE_SERVER_SITE_URL

console.log('Web app: http://localhost:5173 (live updates). Port 8787 serves the API and any previously built web app.')

const children = [
  spawn(bin('tsx'), ['watch', here('src/index.ts')], { stdio: 'inherit', env }),
  spawn(bin('vite'), ['--config', here('web/vite.config.ts')], { stdio: 'inherit', env })
]
let stopping = false
const stop = () => { stopping = true; for (const child of children) child.kill('SIGTERM') }
for (const child of children) child.on('exit', (code) => { stop(); process.exitCode = code ?? 0 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)

// Seeding is the only thing here that talks to the API, and it needs the
// development outbox, so a server started without OPENCOURSE_SERVER_DEV=1 is
// left alone. A failed seed is reported and the servers keep running.
if (env.OPENCOURSE_SERVER_DEV === '1' && env.OPENCOURSE_DEV_SEED !== '0') {
  const host = env.OPENCOURSE_SERVER_HOST ?? '127.0.0.1'
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${env.OPENCOURSE_SERVER_PORT ?? 8787}`
  const deadline = Date.now() + 60_000
  const ready = async () => {
    while (!stopping && Date.now() < deadline) {
      if (await fetch(`${url}/healthz`).then((r) => r.ok, () => false)) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }
  if (await ready()) {
    const seed = spawn(bin('tsx'), [here('scripts/seed.ts')], { stdio: 'inherit', env: { ...env, OPENCOURSE_SERVER_URL: url } })
    children.push(seed)
    seed.on('exit', (code) => {
      children.splice(children.indexOf(seed), 1)
      if (code && !stopping) console.error(`Seeding ${url} failed (exit ${code}); the servers are still running. Retry with npm run seed.`)
    })
  } else if (!stopping) console.error(`${url}/healthz did not answer within a minute; nothing was seeded.`)
}
