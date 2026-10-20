// `npm run dev`: the website against the local world, not the deployed one.
// Catalog links and "From the catalog" come from the server's `npm run dev`
// (its web app on :5173), and the site's own address is this one. Either is
// only a default - an environment variable already set wins - and
// `npm run build` keeps the public addresses.
//
// The catalog may not be running yet. The page then has no catalog section,
// as it would if the public one were down, and this script looks again every
// ten seconds, refreshing the generated data once it answers - Astro reloads
// the page by itself.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const here = (path) => resolve(import.meta.dirname, '..', path)
const port = process.env.OPENCOURSE_SITE_PORT ?? '4321'
const env = {
  PUBLIC_CATALOG_URL: 'http://localhost:5173',
  PUBLIC_SITE_URL: `http://localhost:${port}`,
  ...process.env
}
const catalog = env.PUBLIC_CATALOG_URL.replace(/\/+$/, '')

const resources = () => new Promise((done) => {
  const child = spawn(process.execPath, [here('scripts/build-resources.mjs')], { stdio: 'inherit', env })
  child.on('exit', (code) => done(code === 0))
})
const reachable = () => fetch(`${catalog}/api/v1/server`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)

if (!(await resources())) process.exit(1)
const astro = spawn(here('node_modules/.bin/astro'), ['dev', '--port', port, ...process.argv.slice(2)], { stdio: 'inherit', env })
astro.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => astro.kill(signal))

if (!(await reachable())) {
  console.log(`  The catalog at ${catalog} is not running; the site shows no courses until it is (npm run dev in server/).`)
  const timer = setInterval(async () => {
    if (!(await reachable())) return
    clearInterval(timer)
    console.log(`  The catalog at ${catalog} answers now; fetching its courses.`)
    await resources()
  }, 10_000)
  timer.unref()
}
