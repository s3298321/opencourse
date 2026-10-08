/**
 * The half of an app update that touches the disk: open the downloaded DMG,
 * copy the app out of it next to the one that is running, check the copy is
 * this app at the expected version with an intact signature, and the script
 * that swaps the two once the app has quit.
 *
 * No Electron imports, like unzip.ts, so tests/update-install.test.ts can drive
 * it against real disk images. Every tool is named by its absolute path: a
 * Finder-launched app inherits launchd's PATH, and the stub `cc` it finds there
 * is a lesson in what a bare name can resolve to.
 *
 * Why not Squirrel.Mac (Electron's autoUpdater) or electron-updater: both
 * require a Developer ID signature and refuse an ad-hoc one, which is what the
 * releases are until the repository has the Apple secrets. And a file this app
 * downloads itself carries no quarantine attribute, so the new copy opens
 * without Gatekeeper's "Open Anyway" - the one thing a manual update needs.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The bundle inside every release DMG, whatever the running copy was renamed to. */
export const APP_BUNDLE_NAME = 'OpenCourse.app'

export interface BundleIdentity {
  bundleId: string
  version: string
  /** The Developer ID team that signed it; null for an ad-hoc signature. */
  teamId: string | null
}

export class UpdateInstallError extends Error {
  constructor(readonly code: 'mount' | 'contents' | 'identity' | 'version' | 'signature' | 'team' | 'copy', message: string) {
    super(message)
  }
}

/** Where an update is staged: hidden, beside the bundle it replaces, so the swap is two renames on one volume. */
export function stagedPathFor(target: string, version: string): string {
  return join(dirname(target), `.OpenCourse-${version}.app`)
}

/** Where the running bundle goes during the swap, until the next launch shows the new one started. */
export function backupPathFor(target: string): string {
  return join(dirname(target), '.OpenCourse-previous.app')
}

/**
 * Whether this process may replace `bundle`. Moving a directory to a new name
 * needs write access to its parent and to the directory itself (its `..`
 * changes), so a copy installed by another user, or by root, is refused here
 * rather than half-way through the swap.
 */
export function canReplace(bundle: string): boolean {
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function plistValue(bundle: string, key: string): Promise<string> {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  return stdout.trim()
}

/** Who a bundle says it is, and who signed it. */
export async function bundleIdentity(bundle: string): Promise<BundleIdentity> {
  const [bundleId, version] = await Promise.all([plistValue(bundle, 'CFBundleIdentifier'), plistValue(bundle, 'CFBundleShortVersionString')])
  let teamId: string | null = null
  try {
    // codesign describes a signature on stderr.
    const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle])
    const found = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim()
    teamId = found && found !== 'not set' ? found : null
  } catch {
    teamId = null
  }
  return { bundleId, version, teamId }
}

async function detach(mountpoint: string): Promise<void> {
  try {
    await run('/usr/bin/hdiutil', ['detach', mountpoint, '-quiet'])
  } catch {
    // Spotlight or Finder can still be looking at a volume a moment after it is
    // mounted; a forced detach is fine for a read-only image we are done with.
    await run('/usr/bin/hdiutil', ['detach', mountpoint, '-force', '-quiet']).catch(() => undefined)
  }
}

/**
 * Copy the app out of `dmg` beside `target`, and check it. Returns the staged
 * bundle's path; on any failure nothing is left behind.
 */
export async function stageUpdate(dmg: string, target: string, expect: BundleIdentity): Promise<string> {
  const staged = stagedPathFor(target, expect.version)
  rmSync(staged, { recursive: true, force: true })
  const mountpoint = mkdtempSync(join(tmpdir(), 'opencourse-update-'))
  try {
    try {
      await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, '-quiet'])
    } catch (error) {
      throw new UpdateInstallError('mount', `The downloaded disk image would not open: ${(error as Error).message.split('\n')[0]}`)
    }
    try {
      const source = join(mountpoint, APP_BUNDLE_NAME)
      // lstat, not stat: the image's root also holds an Applications symlink,
      // and an OpenCourse.app that is a link is not the app.
      if (!existsSync(source) || !lstatSync(source).isDirectory()) {
        throw new UpdateInstallError('contents', `The disk image has no ${APP_BUNDLE_NAME}.`)
      }
      try {
        await run('/usr/bin/ditto', [source, staged])
      } catch (error) {
        throw new UpdateInstallError('copy', `The new version could not be copied next to this one: ${(error as Error).message.split('\n')[0]}`)
      }
    } finally {
      await detach(mountpoint)
    }

    const found = await bundleIdentity(staged)
    if (found.bundleId !== expect.bundleId) throw new UpdateInstallError('identity', `The download is ${found.bundleId}, not ${expect.bundleId}.`)
    if (found.version !== expect.version) throw new UpdateInstallError('version', `The download is version ${found.version}, not ${expect.version}.`)
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
    } catch {
      throw new UpdateInstallError('signature', 'The new version\'s signature does not cover what was downloaded.')
    }
    // Once a release is signed by a team, an update must be signed by the same
    // one: an ad-hoc build cannot replace it.
    if (expect.teamId && found.teamId !== expect.teamId) {
      throw new UpdateInstallError('team', 'The new version is not signed by the developer who signed this one.')
    }
    return staged
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(mountpoint, { recursive: true, force: true })
  }
}

/**
 * Run once by /bin/sh after the app has quit, with: the app's pid, the bundle
 * to replace, the staged bundle, where the old one goes, the result file, 1 to
 * open the app again afterwards, the new version, and how long to wait.
 *
 * It waits for the app to be gone (a minute at most, and then it changes
 * nothing), moves the running bundle aside and the new one into its place,
 * and puts the old one back if the second move fails - so the app is always
 * either the old version or the new one, never neither. The old one is not
 * deleted here: the next launch does that, once it is the new version.
 */
export const HELPER_SCRIPT = `#!/bin/sh
# OpenCourse update helper. Written by the app, run once after it quits.
pid="$1"; target="$2"; staged="$3"; backup="$4"; result="$5"; relaunch="$6"; version="$7"; tries="\${8:-300}"
report() { printf '{"ok":%s,"reason":"%s","version":"%s"}\\n' "$1" "$2" "$version" > "$result"; }
reopen() { if [ "$relaunch" = 1 ]; then /usr/bin/open "$target"; fi; }
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt "$tries" ]; then report false still-running; exit 1; fi
  /bin/sleep 0.2
done
/bin/rm -rf "$backup"
if ! /bin/mv "$target" "$backup" 2>/dev/null; then
  report false move-refused; reopen; exit 1
fi
if ! /bin/mv "$staged" "$target" 2>/dev/null; then
  /bin/mv "$backup" "$target"
  report false move-refused; reopen; exit 1
fi
report true installed
reopen
exit 0
`

export interface HelperResult {
  ok: boolean
  reason: 'installed' | 'still-running' | 'move-refused' | string
  version: string
}

/** Writes the helper into `dir` and returns its path. */
export function writeHelper(dir: string): string {
  const path = join(dir, 'install.sh')
  writeFileSync(path, HELPER_SCRIPT, { mode: 0o700 })
  return path
}

/** The arguments the helper takes, in its order. `tries` is how many fifths of a second it waits; a test waits less. */
export function helperArgs(script: string, options: { pid: number; target: string; staged: string; result: string; relaunch: boolean; version: string; tries?: number }): string[] {
  return [script, String(options.pid), options.target, options.staged, backupPathFor(options.target), options.result, options.relaunch ? '1' : '0', options.version, String(options.tries ?? 300)]
}
