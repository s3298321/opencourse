/** Fetch pinned, verified resources at build time; never runs in the installed app. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(appDir, 'python-runtime.lock.json'), 'utf8'))
const identity = `${lock.version}+${lock.release}:${lock.sha256}:${lock.licenses.sha256}`
const resources = join(appDir, 'resources')
const destination = join(resources, 'python')
const stamp = join(destination, '.opencourse-runtime')
const cache = join(appDir, '.cache', 'python')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The bundled runtime requires macOS Apple silicon.')

function runtimeVersion(directory) {
  const env = { ...process.env }
  for (const name of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete env[name]
  env.PYTHONNOUSERSITE = '1'
  return execFileSync(join(directory, 'bin', 'python3'), ['-I', '-B', '-c', 'import sys, ssl, sqlite3, ctypes, venv, ensurepip; print("%d.%d.%d" % sys.version_info[:3])'], { env, encoding: 'utf8' }).trim()
}
function ready() {
  try {
    return readFileSync(stamp, 'utf8') === identity && existsSync(join(destination, 'PYTHON.json')) && runtimeVersion(destination) === lock.version
  } catch { return false }
}
function verifiedArchive(artifact, suffix) {
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, `${artifact.sha256}.${suffix}`)
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  if (!existsSync(archive) || digest(archive) !== artifact.sha256) {
    const partial = `${archive}.${process.pid}.partial`
    try {
      execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '300', '--output', partial, artifact.url], { stdio: 'inherit' })
      if (digest(partial) !== artifact.sha256) throw new Error('Python archive checksum mismatch')
      renameSync(partial, archive)
    } finally { rmSync(partial, { force: true }) }
  }
  return archive
}

if (ready()) {
  console.log(`Bundled Python ${lock.version} is ready`)
} else {
  const archive = verifiedArchive(lock, 'tar.gz')
  // install_only omits full distribution metadata. Get its license texts from
  // the matching full archive, without shipping object files or build tools.
  const full = verifiedArchive(lock.licenses, 'tar.zst')
  mkdirSync(resources, { recursive: true })
  const staging = mkdtempSync(join(resources, '.python-'))
  try {
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging])
    const members = execFileSync('/usr/bin/tar', ['-tf', full], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(name => name === 'python/PYTHON.json' || /^python\/(?:licenses\/|LICENSE)/.test(name))
    if (!members.includes('python/PYTHON.json') || members.length < 2) throw new Error('Python distribution license metadata is missing')
    execFileSync('/usr/bin/tar', ['-xf', full, '-C', staging, ...members])
    const runtime = join(staging, 'python')
    const version = runtimeVersion(runtime)
    if (version !== lock.version) throw new Error(`Expected Python ${lock.version}, got ${version}`)
    writeFileSync(join(runtime, '.opencourse-runtime'), identity)
    writeFileSync(join(runtime, 'opencourse-runtime.json'), JSON.stringify(lock, null, 2) + '\n')
    rmSync(destination, { recursive: true, force: true })
    renameSync(runtime, destination)
    console.log(`Prepared bundled Python ${version} and distribution licenses`)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
