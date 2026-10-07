// `npm run dev`: the API (tsx, :8787, restarting on change) and the web app
// (Vite, :5173, handing /api to the API). Open the address Vite prints; the
// desktop app connects to :8787 as before. Ctrl-C stops both.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const here = (path) => resolve(import.meta.dirname, '..', path)
const bin = (name) => here(`node_modules/.bin/${name}`)
const env = { ...process.env, OPENCOURSE_SERVER_DEV: process.env.OPENCOURSE_SERVER_DEV ?? '1' }

const children = [
  spawn(bin('tsx'), ['watch', here('src/index.ts')], { stdio: 'inherit', env }),
  spawn(bin('vite'), ['--config', here('web/vite.config.ts')], { stdio: 'inherit', env })
]
const stop = () => { for (const child of children) child.kill('SIGTERM') }
for (const child of children) child.on('exit', (code) => { stop(); process.exitCode = code ?? 0 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
