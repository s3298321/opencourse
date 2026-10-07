#!/usr/bin/env node
/**
 * Prints the Electron dist directory to launch from, for ELECTRON_OVERRIDE_DIST_PATH.
 *
 * macOS refuses to start an ad-hoc-signed app bundle that lives inside a
 * TCC-protected folder (~/Documents, ~/Desktop, ~/Downloads) when the launch
 * comes from a terminal: the process wedges in dyld at 0% CPU, forever, with
 * no error and no prompt. Electron installs its binary into node_modules, so a
 * checkout in one of those folders cannot run `electron-vite dev` at all.
 *
 * When the repo sits somewhere unprotected this prints the local dist and
 * copies nothing. Otherwise it mirrors the binary into ~/Library/Caches once
 * per Electron version and prints that instead.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localDist = join(appDir, 'node_modules', 'electron', 'dist')
const home = homedir()
const PROTECTED = ['Documents', 'Desktop', 'Downloads'].map((d) => join(home, d))

function version() {
  return readFileSync(join(localDist, 'version'), 'utf8').trim()
}

if (!existsSync(localDist)) {
  console.error('electron is not installed yet — run npm install')
  process.exit(1)
}

if (!PROTECTED.some((dir) => appDir === dir || appDir.startsWith(dir + '/'))) {
  process.stdout.write(localDist)
  process.exit(0)
}

const staged = join(home, 'Library', 'Caches', 'opencourse-electron')
const stamp = join(staged, 'version')
const bundle = join(localDist, 'Electron.app')

if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== version()) {
  console.error(`staging electron ${version()} outside ~/Documents (macOS will not launch it from there)`)
  mkdirSync(staged, { recursive: true })
  rmSync(join(staged, 'Electron.app'), { recursive: true, force: true })
  // cp -R, not fs.cpSync: the framework is full of relative symlinks
  // (Versions/Current -> A) that cpSync refuses to follow.
  execFileSync('cp', ['-R', realpathSync(bundle), staged])
  cpSync(join(appDir, 'node_modules', 'electron', 'path.txt'), join(staged, 'path.txt'))
  writeFileSync(stamp, version())
}

// ELECTRON_OVERRIDE_DIST_PATH only helps launchers that go through the electron
// npm wrapper; electron-vite spawns node_modules/electron/dist directly. So
// leave a symlink there pointing at the staged bundle - then every launcher
// ends up executing a binary that lives outside the protected folder.
if (!lstatSync(bundle, { throwIfNoEntry: false })?.isSymbolicLink() || readlinkSync(bundle) !== join(staged, 'Electron.app')) {
  rmSync(bundle, { recursive: true, force: true })
  symlinkSync(join(staged, 'Electron.app'), bundle)
}

process.stdout.write(staged)
