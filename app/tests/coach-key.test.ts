/**
 * The first secret this app has ever stored.
 *
 * The tests that matter are the negative ones: that a key is never written in
 * plaintext, never survives into another user's session, and never appears in
 * anything main hands back to the renderer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-coachkey-'))
let dataDir = join(root, 'data')
let encryptionAvailable = true

/**
 * A stand-in for the Keychain: reversible, and obviously not the plaintext, so
 * a test asserting "the key is not on disk" cannot pass by accident.
 */
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer: Buffer) => [...buffer.toString().replace(/^enc:/, '')].reverse().join('')
  }
}))

const { createUser, deleteUser, listUsers, switchUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { createProject, listProjects } = await import('../src/main/coach')
const { clearKey, forgetVolatileKeys, hasKey, readKey, setKey, storedKeyHint } = await import('../src/main/coachkey')
const { coachKeyFile } = await import('../src/main/paths')
const { isPlausibleKey, scrubSecrets } = await import('../src/core/coach/key')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const GOOD = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
const accept = async (): Promise<{ ok: true }> => ({ ok: true })
const reject = async (): Promise<{ ok: false; message: string }> => ({ ok: false, message: 'OpenAI rejected that key.' })

let n = 0
beforeEach(() => {
  closeDb()
  forgetVolatileKeys()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  encryptionAvailable = true
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
})

describe('what counts as a key', () => {
  it('accepts the shapes OpenAI actually issues', () => {
    expect(isPlausibleKey(GOOD)).toBe(true)
    expect(isPlausibleKey('sk-svcacct-abcdefghijklmnopqrstuvwxyz01')).toBe(true)
    expect(isPlausibleKey(`  ${GOOD}  `)).toBe(true)
  })

  it('refuses something pasted by mistake, before any network call', async () => {
    createUser('Ada')
    let asked = false
    const watch = async (): Promise<{ ok: true }> => {
      asked = true
      return { ok: true }
    }
    for (const bad of ['', 'hunter2', 'sk-short', 'Bearer sk-abcdefghijklmnopqrstuvwxyz', null, 42]) {
      const result = await setKey(bad, watch)
      expect(result.status).toBe('invalid')
    }
    expect(asked).toBe(false)
  })
})

describe('storing a key', () => {
  it('round-trips it through the keychain', async () => {
    createUser('Ada')
    expect(await setKey(GOOD, accept)).toEqual({ status: 'ok' })
    expect(readKey()).toBe(GOOD)
    expect(hasKey()).toBe(true)
  })

  it('never writes the key itself to disk', async () => {
    const user = createUser('Ada')
    await setKey(GOOD, accept)

    const onDisk = readFileSync(coachKeyFile(user.id), 'utf8')
    expect(onDisk).not.toContain(GOOD)
    expect(onDisk).not.toContain('sk-')
    expect(JSON.parse(onDisk).encrypted).toBe(true)
  })

  it('does not store a key OpenAI would not accept', async () => {
    const user = createUser('Ada')
    const result = await setKey(GOOD, reject)
    expect(result).toEqual({ status: 'invalid', message: 'OpenAI rejected that key.' })
    expect(existsSync(coachKeyFile(user.id))).toBe(false)
    expect(hasKey()).toBe(false)
  })

  it('shows which key is stored without showing the key', async () => {
    createUser('Ada')
    await setKey(GOOD, accept)
    const hint = storedKeyHint() as string
    expect(hint).toBe('…6789')
    expect(GOOD).not.toContain(hint.replace('…', '') + 'x')
    expect(hint.length).toBeLessThan(8)
  })

  it('forgets it on request', async () => {
    createUser('Ada')
    await setKey(GOOD, accept)
    clearKey()
    expect(hasKey()).toBe(false)
    expect(readKey()).toBe('')
  })
})

describe('a machine with no keychain', () => {
  it('refuses to persist rather than falling back to plaintext', async () => {
    const user = createUser('Ada')
    encryptionAvailable = false

    expect(await setKey(GOOD, accept)).toEqual({ status: 'unavailable' })
    expect(existsSync(coachKeyFile(user.id))).toBe(false)
    // Usable for this launch, which is what `unavailable` promises.
    expect(readKey()).toBe(GOOD)
    expect(hasKey()).toBe(true)
  })

  it('leaves nothing behind for the next launch to find', async () => {
    const user = createUser('Ada')
    encryptionAvailable = false
    await setKey(GOOD, accept)

    const coachDir = join(dataDir, 'users', user.id, 'coach')
    const files = existsSync(coachDir) ? readdirSync(coachDir) : []
    for (const file of files) {
      expect(readFileSync(join(coachDir, file), 'utf8')).not.toContain('sk-')
    }
  })

  it('cannot read a key stored earlier once the keychain is gone', async () => {
    createUser('Ada')
    await setKey(GOOD, accept)
    encryptionAvailable = false
    expect(readKey()).toBe('')
  })
})

describe('one key per user', () => {
  it('does not hand one user another user’s key', async () => {
    const ada = createUser('Ada')
    await setKey(GOOD, accept)
    expect(hasKey()).toBe(true)

    createUser('Bob')
    expect(hasKey()).toBe(false)
    expect(readKey()).toBe('')

    switchUser(ada.id)
    expect(readKey()).toBe(GOOD)
  })

  it('keeps volatile keys apart too', async () => {
    encryptionAvailable = false
    const ada = createUser('Ada')
    await setKey(GOOD, accept)

    createUser('Bob')
    expect(readKey()).toBe('')

    switchUser(ada.id)
    expect(readKey()).toBe(GOOD)
  })

  it('takes the key with a deleted user', async () => {
    const ada = createUser('Ada')
    await setKey(GOOD, accept)
    const file = coachKeyFile(ada.id)
    expect(existsSync(file)).toBe(true)

    deleteUser(ada.id)
    expect(existsSync(file)).toBe(false)
  })
})

describe('the key never reaches the renderer', () => {
  it('appears in nothing main hands back', async () => {
    createUser('Ada')
    await setKey(GOOD, accept)
    createProject({ name: 'French' })

    // Everything the coach IPC surface can return, as the renderer would see it.
    const returned = JSON.stringify({
      projects: listProjects(),
      hasKey: hasKey(),
      hint: storedKeyHint(),
      setResult: await setKey(GOOD, accept)
    })

    expect(returned).not.toContain(GOOD)
    expect(returned).not.toContain('sk-')
  })

  it('scrubs a key out of an error message on its way out', () => {
    const quoted = `Incorrect API key provided: ${GOOD}. You can find your key at ...`
    expect(scrubSecrets(quoted)).not.toContain(GOOD)
    expect(scrubSecrets(quoted)).toContain('[redacted]')
  })

  it('scrubs ephemeral realtime secrets too', () => {
    const leaked = 'failed with Authorization: Bearer ek_abc123def456ghi789'
    expect(scrubSecrets(leaked)).not.toContain('ek_abc123def456')
    expect(scrubSecrets(leaked)).toContain('[redacted]')
  })
})
