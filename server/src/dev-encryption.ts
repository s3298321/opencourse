import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Keep the dev credential key beside the database, including across watcher restarts. */
export function devEncryptionKeys(dataDir: string): string {
  const file = join(dataDir, 'ai-encryption.key')
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
      // Publish a complete file without replacing another process's key.
      try { linkSync(temporary, file) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  const key = readFileSync(file, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error(`Invalid dev AI encryption key at ${file}. Restore the original key to keep saved credentials readable.`)
  }
  return JSON.stringify({ dev: key })
}
