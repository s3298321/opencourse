/**
 * Administration from the server's machine - the way in before there is an
 * administrator, and a way back if every one of them is locked out:
 *
 *   npm run admin -- grant-admin <username>
 *   npm run admin -- revoke-admin <username>
 *   npm run admin -- disable-account <username>
 *   npm run admin -- enable-account <username>
 *   npm run admin -- unlist <courseId> [reason]
 *   npm run admin -- relist <courseId>
 *
 * The same rules and the same audit log as the admin console. Disabling an
 * account signs it out everywhere and refuses its logins; its courses stay as
 * they are until unlisted. Unlisting here is moderation: the owner cannot list
 * the course again, and publishing a new version does not either.
 */
import { join } from 'node:path'
import { loadConfig } from './config'
import { openDb } from './db'
import { ApiError } from './errors'
import { setDisabled, setModerated, setRole } from './admin/routes'

const [command, target, ...rest] = process.argv.slice(2)
const config = loadConfig()
const d = openDb(join(config.dataDir, 'server.db'))
const fail = (message: string): never => { console.error(message); process.exit(1) }
const accountId = (username: string | undefined): string => {
  const row = d.prepare('SELECT id FROM accounts WHERE username = ?').get(username ?? '') as { id: string } | undefined
  return row ? row.id : fail(`No account named ${username}`)
}

try {
  switch (command) {
    case 'grant-admin':
    case 'revoke-admin':
      setRole(d, null, accountId(target), command === 'grant-admin' ? 'admin' : 'member')
      console.log(`${target} is ${command === 'grant-admin' ? 'now an administrator' : 'no longer an administrator'}`)
      break
    case 'disable-account':
    case 'enable-account':
      setDisabled(d, null, accountId(target), command === 'disable-account')
      console.log(`${command === 'disable-account' ? 'Disabled' : 'Enabled'} ${target}`)
      break
    case 'unlist':
    case 'relist':
      setModerated(d, null, target ?? '', command === 'unlist' ? (rest.join(' ').trim() || 'Removed by the server\'s administrators.') : null)
      console.log(`${command === 'unlist' ? 'Unlisted' : 'Listed'} ${target}`)
      break
    default:
      fail('Usage: npm run admin -- grant-admin|revoke-admin|disable-account|enable-account <username> | unlist <courseId> [reason] | relist <courseId>')
  }
} catch (error) {
  fail(error instanceof ApiError ? error.message : String(error))
} finally {
  d.close()
}
