/**
 * The disk half of an app update, against real disk images and real signed
 * bundles: staging an app out of a DMG beside the one it replaces, and the
 * helper that swaps them after the app quits. macOS only, and slow (hdiutil),
 * so opt-in:
 *
 *   OPENCOURSE_TEST_UPDATE=1 npx vitest run tests/update-install.test.ts
 *
 * The bundles here are small - a compiled main, an Info.plist, ad-hoc signed -
 * which proves the mechanics but not that Electron's nested frameworks verify.
 * For that, point OPENCOURSE_TEST_UPDATE_DMG at a DMG built the way a release
 * is (`npx electron-builder --mac --arm64 -c.mac.identity=-`) and the last test
 * stages the real app.
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_BUNDLE_NAME,
  backupPathFor,
  bundleIdentity,
  canReplace,
  helperArgs,
  stageUpdate,
  stagedPathFor,
  writeHelper
} from '../src/main/update-install'

const enabled = Boolean(process.env['OPENCOURSE_TEST_UPDATE'])
const BUNDLE_ID = 'dev.opencourse.app'

let root = ''
let main = ''

/** A minimal app bundle: Info.plist, a compiled main, ad-hoc signed like a release. */
function makeApp(dir: string, version: string, options: { bundleId?: string; name?: string; sign?: boolean } = {}): string {
  const app = join(dir, options.name ?? APP_BUNDLE_NAME)
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${options.bundleId ?? BUNDLE_ID}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>OpenCourse</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`)
  execFileSync('/bin/cp', [main, join(app, 'Contents', 'MacOS', 'OpenCourse')])
  writeFileSync(join(app, 'Contents', 'Resources', 'app.txt'), `version ${version}\n`)
  if (options.sign !== false) execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
  return app
}

/** A DMG laid out like a release's: the app and an Applications link. */
function makeDmg(name: string, fill: (dir: string) => void): string {
  const source = mkdtempSync(join(root, 'dmg-src-'))
  fill(source)
  symlinkSync('/Applications', join(source, 'Applications'))
  const dmg = join(root, `${name}.dmg`)
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-ov', '-format', 'UDZO', '-volname', 'OpenCourse', '-srcfolder', source, dmg])
  return dmg
}

/** An "Applications" folder holding the running copy, version 1.0.0. */
function install(): { apps: string; target: string } {
  const apps = mkdtempSync(join(root, 'Applications-'))
  return { apps, target: makeApp(apps, '1.0.0') }
}

function versionOf(app: string): string {
  return readFileSync(join(app, 'Contents', 'Resources', 'app.txt'), 'utf8').trim()
}

/** Run the helper the way main does, against a process that exits after `seconds`. */
async function runHelper(target: string, staged: string, options: { seconds?: number; tries?: number } = {}): Promise<{ ok: boolean; reason: string; version: string }> {
  const dir = mkdtempSync(join(root, 'updates-'))
  const script = writeHelper(dir)
  const result = join(dir, 'result.json')
  const app = spawn('/bin/sleep', [String(options.seconds ?? 0.5)])
  const helper = spawn('/bin/sh', helperArgs(script, { pid: app.pid!, target, staged, result, relaunch: false, version: '2.0.0', tries: options.tries ?? 50 }))
  await new Promise((resolve) => helper.on('exit', resolve))
  app.kill()
  return JSON.parse(readFileSync(result, 'utf8')) as { ok: boolean; reason: string; version: string }
}

describe.skipIf(!enabled)('staging an update', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'opencourse-update-test-'))
    const c = join(root, 'main.c')
    writeFileSync(c, 'int main(void) { return 0; }\n')
    main = join(root, 'main')
    execFileSync('cc', [c, '-o', main])
  })
  afterAll(() => {
    if (root) {
      execFileSync('/bin/chmod', ['-R', 'u+w', root])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('copies the app out of the DMG beside the running one, and checks it is the version expected', async () => {
    const { apps, target } = install()
    const dmg = makeDmg('good', (dir) => makeApp(dir, '2.0.0'))
    const staged = await stageUpdate(dmg, target, { bundleId: BUNDLE_ID, version: '2.0.0', teamId: null })
    expect(staged).toBe(stagedPathFor(target, '2.0.0'))
    expect(staged.startsWith(apps)).toBe(true)
    expect(versionOf(staged)).toBe('version 2.0.0')
    expect(await bundleIdentity(staged)).toEqual({ bundleId: BUNDLE_ID, version: '2.0.0', teamId: null })
    expect(versionOf(target)).toBe('version 1.0.0')
  }, 60_000)

  it('refuses another version, another app, a tampered app and a link, and leaves nothing behind', async () => {
    const { target } = install()
    const cases: Array<[string, string, RegExp]> = [
      [makeDmg('older', (dir) => makeApp(dir, '1.5.0')), 'version', /version 1\.5\.0/],
      [makeDmg('other', (dir) => makeApp(dir, '2.0.0', { bundleId: 'com.example.other' })), 'identity', /com\.example\.other/],
      [makeDmg('tampered', (dir) => {
        const app = makeApp(dir, '2.0.0')
        writeFileSync(join(app, 'Contents', 'Resources', 'app.txt'), 'something else\n')
      }), 'signature', /signature/],
      [makeDmg('unsigned', (dir) => makeApp(dir, '2.0.0', { sign: false })), 'signature', /signature/],
      [makeDmg('link', (dir) => {
        makeApp(dir, '2.0.0', { name: 'Elsewhere.app' })
        symlinkSync(join(dir, 'Elsewhere.app'), join(dir, APP_BUNDLE_NAME))
      }), 'contents', /no OpenCourse\.app/]
    ]
    for (const [dmg, code, message] of cases) {
      const failure = await stageUpdate(dmg, target, { bundleId: BUNDLE_ID, version: '2.0.0', teamId: null }).then(() => null, (error: unknown) => error as { code: string; message: string })
      expect(failure?.code, dmg).toBe(code)
      expect(failure?.message, dmg).toMatch(message)
      expect(existsSync(stagedPathFor(target, '2.0.0')), dmg).toBe(false)
    }
  }, 120_000)

  it('refuses an ad-hoc build in place of one signed by a team', async () => {
    const { target } = install()
    const dmg = makeDmg('adhoc', (dir) => makeApp(dir, '2.0.0'))
    await expect(stageUpdate(dmg, target, { bundleId: BUNDLE_ID, version: '2.0.0', teamId: 'ABCDE12345' })).rejects.toMatchObject({ code: 'team' })
  }, 60_000)

  it('swaps the new version in once the app has gone, keeping the old one until the next launch', async () => {
    const { target } = install()
    const staged = makeApp(join(target, '..'), '2.0.0', { name: '.OpenCourse-2.0.0.app' })
    const result = await runHelper(target, staged)
    expect(result).toEqual({ ok: true, reason: 'installed', version: '2.0.0' })
    expect(versionOf(target)).toBe('version 2.0.0')
    expect(versionOf(backupPathFor(target))).toBe('version 1.0.0')
    expect(existsSync(staged)).toBe(false)
  }, 30_000)

  it('puts the old version back when the new one cannot be moved in', async () => {
    const { target } = install()
    const result = await runHelper(target, join(target, '..', '.OpenCourse-2.0.0.app'))
    expect(result).toMatchObject({ ok: false, reason: 'move-refused' })
    expect(versionOf(target)).toBe('version 1.0.0')
  }, 30_000)

  it('changes nothing where it may not write, and says so up front', async () => {
    const { apps, target } = install()
    const staged = makeApp(apps, '2.0.0', { name: '.OpenCourse-2.0.0.app' })
    chmodSync(apps, 0o555)
    try {
      expect(canReplace(target)).toBe(false)
      const result = await runHelper(target, staged)
      expect(result).toMatchObject({ ok: false, reason: 'move-refused' })
      expect(versionOf(target)).toBe('version 1.0.0')
    } finally {
      chmodSync(apps, 0o755)
    }
    expect(canReplace(target)).toBe(true)
  }, 30_000)

  it('changes nothing if the app does not quit', async () => {
    const { target } = install()
    const staged = makeApp(join(target, '..'), '2.0.0', { name: '.OpenCourse-2.0.0.app' })
    const result = await runHelper(target, staged, { seconds: 5, tries: 3 })
    expect(result).toMatchObject({ ok: false, reason: 'still-running' })
    expect(versionOf(target)).toBe('version 1.0.0')
    expect(existsSync(staged)).toBe(true)
  }, 30_000)

  it.skipIf(!process.env['OPENCOURSE_TEST_UPDATE_DMG'])('stages a real release DMG, whose signature covers Electron and its helpers', async () => {
    const dmg = process.env['OPENCOURSE_TEST_UPDATE_DMG']!
    const mount = mkdtempSync(join(root, 'real-'))
    execFileSync('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount, '-quiet'])
    let identity
    try {
      identity = await bundleIdentity(join(mount, APP_BUNDLE_NAME))
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet'])
    }
    const { target } = install()
    const staged = await stageUpdate(dmg, target, identity)
    expect((await bundleIdentity(staged)).version).toBe(identity.version)
  }, 300_000)
})
