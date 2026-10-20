import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { openDb } from '../src/db'
import { readAIKey, sealKey } from '../src/learning/credentials'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'opencourse-dev-encryption-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function config(extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({ OPENCOURSE_SERVER_DEV: '1', OPENCOURSE_SERVER_DATA: dir, ...extra })
}

describe('dev AI encryption', () => {
  it('decrypts a saved credential after reopening the database and reloading configuration', () => {
    const first = config()
    const file = join(dir, 'server.db')
    const db = openDb(file)
    const secret = 'sk-test-persisted-credential'
    try {
      db.prepare('INSERT INTO accounts (id,email,username,password_hash,created_at) VALUES (?,?,?,?,?)')
        .run('ada', 'ada@example.org', 'ada', 'unused', new Date().toISOString())
      db.prepare('INSERT INTO learning_ai (account_id,secret) VALUES (?,?)')
        .run('ada', sealKey({ db, config: first }, 'ada', secret))
    } finally { db.close() }

    const restarted = config()
    const reopened = openDb(file)
    try {
      expect(readAIKey({ db: reopened, config: restarted }, 'ada')).toBe(secret)
      expect(restarted.aiEncryptionKeys).toBe(first.aiEncryptionKeys)
      expect(String(reopened.prepare('SELECT secret FROM learning_ai').get()!.secret)).not.toContain(secret)
    } finally { reopened.close() }
    expect(statSync(join(dir, 'ai-encryption.key')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('honors explicit encryption configuration without generating a key', () => {
    const keys = JSON.stringify({ custom: 'ab'.repeat(32) })
    expect(config({ OPENCOURSE_AI_ENCRYPTION_KEYS: keys, OPENCOURSE_AI_ACTIVE_KEY: 'custom' }))
      .toMatchObject({ aiEncryptionKeys: keys, aiActiveKey: 'custom' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not auto-configure encryption outside dev mode', () => {
    expect(config({ OPENCOURSE_SERVER_DEV: '0' }).aiEncryptionKeys).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('creates separate keys for separate data directories', () => {
    expect(config().aiEncryptionKeys).not.toBe(config({ OPENCOURSE_SERVER_DATA: join(dir, 'other') }).aiEncryptionKeys)
  })

  it('fails without overwriting a damaged key', () => {
    const file = join(dir, 'ai-encryption.key')
    writeFileSync(file, 'damaged')
    expect(() => config()).toThrow('Invalid dev AI encryption key')
    expect(readFileSync(file, 'utf8')).toBe('damaged')
  })
})
