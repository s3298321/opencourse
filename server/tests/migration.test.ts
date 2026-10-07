import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, SCHEMA_V1, SCHEMA_VERSION } from '../src/db'
import { sessionAccount } from '../src/auth/sessions'
import { sha256 } from '../src/auth/secrets'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the database migration', () => {
  it('upgrades a v1 database in place, keeping every account, session and code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencourse-migrate-'))
    dirs.push(dir)
    const file = join(dir, 'server.db')
    const v1 = new DatabaseSync(file)
    v1.exec(SCHEMA_V1)
    v1.exec('PRAGMA user_version = 1')
    const at = new Date().toISOString(), later = new Date(Date.now() + 86_400_000).toISOString()
    v1.prepare('INSERT INTO accounts(id, email, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run('a1', 'ada@example.org', 'ada', 'scrypt$x', at)
    v1.prepare('INSERT INTO sessions(token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256('ocs_old-token'), 'a1', at, at, later)
    v1.prepare('INSERT INTO email_codes(id, email, purpose, code_hmac, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run('c1', 'ada@example.org', 'reset', 'ff', at, later)
    v1.prepare('INSERT INTO courses(id, owner_id, slug, current_version, max_version, created_at, updated_at, unlisted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('k1', 'a1', 'x', '0.1.0', '0.1.0', at, at, at)
    v1.close()

    const d = openDb(file)
    expect((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    expect(d.prepare('SELECT username, role FROM accounts').all()).toEqual([{ username: 'ada', role: 'member' }])
    // A token issued before the upgrade still signs in, now with a public id.
    const viewer = sessionAccount(d, 'ocs_old-token')
    expect(viewer).toMatchObject({ account: { username: 'ada' }, role: 'member', kind: 'app' })
    expect(viewer!.sessionId).toMatch(/^[0-9a-f]{24}$/)
    expect(d.prepare('SELECT id, purpose, account_id FROM email_codes').all()).toEqual([{ id: 'c1', purpose: 'reset', account_id: null }])
    expect(d.prepare('SELECT unlisted_at IS NOT NULL AS unlisted, moderated_at FROM courses').get()).toEqual({ unlisted: 1, moderated_at: null })
    // The rebuilt table accepts the new purpose.
    d.prepare('INSERT INTO email_codes(id, email, purpose, code_hmac, created_at, expires_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run('c2', 'new@example.org', 'email', 'ee', at, later, 'a1')
    d.close()

    // Opening again is a no-op.
    const again = openDb(file)
    expect((again.prepare('SELECT COUNT(*) AS n FROM email_codes').get() as { n: number }).n).toBe(2)
    again.close()
  })
})
