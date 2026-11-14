/**
 * node-pty 1.1.0 ships its prebuilt `spawn-helper` without the executable bit,
 * so every pty.fork() dies with "posix_spawnp failed" straight after a clean
 * install. npm does not restore the mode, so we do - idempotently, on every
 * install, and quietly when node-pty is not there at all.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode
    if (mode & 0o111) continue
    chmodSync(helper, 0o755)
    console.log(`fix-node-pty: made ${platform}/spawn-helper executable`)
  }
}
