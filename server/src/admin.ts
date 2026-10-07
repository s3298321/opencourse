/**
 * Moderation without a web UI, run on the server's machine:
 *
 *   npm run admin -- disable-account <username>
 *   npm run admin -- enable-account <username>
 *   npm run admin -- unlist <courseId>
 *   npm run admin -- relist <courseId>
 *
 * Disabling an account signs it out everywhere and refuses its logins; its
 * courses stay as they are until unlisted.
 */
import { join } from 'node:path'
import { loadConfig } from './config'
import { nowIso, openDb } from './db'
import { refreshListing } from './catalog/catalog'

const [command, target] = process.argv.slice(2)
const config = loadConfig()
const d = openDb(join(config.dataDir, 'server.db'))
const fail = (message: string): never => { console.error(message); process.exit(1) }

switch (command) {
  case 'disable-account':
  case 'enable-account': {
    const row = d.prepare('SELECT id FROM accounts WHERE username = ?').get(target ?? '') as { id: string } | undefined
    if (!row) fail(`No account named ${target}`)
    d.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').run(command === 'disable-account' ? nowIso() : null, row!.id)
    if (command === 'disable-account') d.prepare('DELETE FROM sessions WHERE account_id = ?').run(row!.id)
    console.log(`${command === 'disable-account' ? 'Disabled' : 'Enabled'} ${target}`)
    break
  }
  case 'unlist':
  case 'relist': {
    const changed = d.prepare('UPDATE courses SET unlisted_at = ? WHERE id = ?').run(command === 'unlist' ? nowIso() : null, target ?? '')
    if (!changed.changes) fail(`No course ${target}`)
    refreshListing(d, target!)
    console.log(`${command === 'unlist' ? 'Unlisted' : 'Listed'} ${target}`)
    break
  }
  default:
    fail('Usage: npm run admin -- disable-account|enable-account <username> | unlist|relist <courseId>')
}
d.close()
