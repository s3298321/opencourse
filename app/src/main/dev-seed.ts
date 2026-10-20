/**
 * A `npm run dev` profile starts as a small local world rather than empty:
 * two users, the committed fixture courses in each library, and a connection
 * to the local server (dev-env.ts) - an author signed in as the server's
 * `ada`, and a learner signed in as `sam` with the server's example course
 * and document already added (server/scripts/seed.ts publishes them; the
 * accounts are core/dev-seed.ts, shared with it).
 *
 * Two phases, because the server may not be running:
 *  - local, once per profile (a marker file): users, courses, and a signed-out
 *    connection to the local server, so the app is wired to it from the first
 *    launch and says "can't reach" rather than "no server" when it is down;
 *  - server, whenever the server answers: sign in where there is no working
 *    token (a reset server answers 401 to the old one), and add the learner's
 *    content. At launch that covers every seeded user, before the window opens
 *    and so before anyone is selected; later - the server started after the
 *    app - only the user who is selected, because the session is global and
 *    the seed must never move it under an open window.
 *
 * Nothing here runs outside a dev run (index.ts calls it only then).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeServerUrl } from '../core/catalog/url'
import { DEV_AUTHOR, DEV_LEARNER, DEV_PASSWORD, DEV_SAMPLE_COURSES } from '../core/dev-seed'
import { closeDb } from './db'
import { devEnvironment } from './dev-env'
import { fixtureCoursesDir } from './fixture-identities'
import { importCourseZip } from './import'
import { log } from './log'
import { dataRoot } from './paths'
import { healthEvents } from './server-health'
import { addUnsignedConnection, serverAccessForUrl, signIn } from './servers'
import { callServer, ServerError } from './serverclient'
import { clearSession, createUser, currentUserId, listUsers, switchUser } from './users'

const logger = log.child('dev-seed')
const SEED_VERSION = 1
const PROBE_MS = 2_000

interface SeedUser { name: string; account: string; learner: boolean }
const USERS: SeedUser[] = [
  { name: 'Ada (author)', account: DEV_AUTHOR, learner: false },
  { name: 'Sam (learner)', account: DEV_LEARNER, learner: true }
]

interface Marker { version: number; users: Record<string, string> }
const markerFile = (): string => join(dataRoot(), 'dev-seed.json')

function readMarker(): Marker | null {
  try {
    const marker = JSON.parse(readFileSync(markerFile(), 'utf8')) as Marker
    return marker.version === SEED_VERSION && marker.users ? marker : null
  } catch { return null }
}

/** Seeded user id → which account it signs in as. */
function seededUsers(): Map<string, SeedUser> {
  const marker = readMarker()
  const out = new Map<string, SeedUser>()
  for (const [id, account] of Object.entries(marker?.users ?? {})) {
    const user = USERS.find((u) => u.account === account)
    if (user && listUsers().some((u) => u.id === id)) out.set(id, user)
  }
  return out
}

function zipFolder(folder: string, zip: string): void {
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', folder, zip])
}

async function seedLocal(server: string): Promise<void> {
  if (readMarker()) return
  if (listUsers().length) {
    // A dev profile someone already set up by hand: leave it as it is.
    writeFileSync(markerFile(), JSON.stringify({ version: SEED_VERSION, users: {} }, null, 2))
    return
  }
  const work = mkdtempSync(join(tmpdir(), 'opencourse-dev-seed-'))
  const users: Record<string, string> = {}
  try {
    const zips = DEV_SAMPLE_COURSES.map((name) => {
      const zip = join(work, `${name}.zip`)
      zipFolder(join(fixtureCoursesDir(), name), zip)
      return zip
    })
    for (const seed of USERS) {
      const user = createUser(seed.name)
      users[user.id] = seed.account
      for (const zip of zips) {
        const result = await importCourseZip(zip)
        if (result.status !== 'ok') logger.warn('A sample course was not imported', { data: { status: result.status } })
      }
      addUnsignedConnection(server, 'OpenCourse (local dev)', 'The server from npm run dev in server/.')
      closeDb()
    }
  } finally {
    clearSession()
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(markerFile(), JSON.stringify({ version: SEED_VERSION, users }, null, 2))
  logger.info('Seeded a dev profile', { data: { users: USERS.length, courses: DEV_SAMPLE_COURSES.length } })
}

async function answers(server: string): Promise<boolean> {
  try {
    await callServer(server, '/server', (raw) => raw ?? {}, { route: '/server', timeoutMs: PROBE_MS })
    return true
  } catch { return false }
}

/** Signed in with a token the server still takes; signs in again when it does not. */
async function ensureSignedIn(server: string, seed: SeedUser): Promise<string | null> {
  const access = serverAccessForUrl(server)
  if (access?.token) {
    try {
      await callServer(server, '/me', (raw) => raw ?? {}, { token: access.token, route: '/me' })
      return access.id
    } catch (error) {
      if (!(error instanceof ServerError) || error.status !== 401) return access.id
    }
  }
  return (await signIn(server, seed.account, DEV_PASSWORD)).id
}

/** The learner's server content: the example course and document, added like a person would. */
async function addLearnerContent(connectionId: string, owner: string): Promise<void> {
  const [{ searchCatalog }, { addFromServer }, { searchDocuments, addDocument }] = await Promise.all([
    import('./catalog'), import('./server-courses'), import('./document-catalog')
  ])
  const courses = await searchCatalog(connectionId, { sort: 'title' })
  const example = courses.courses.find((c) => c.slug === 'opencourse-example')
  if (example && currentUserId() === owner) await addFromServer(connectionId, example.id).catch(() => undefined)
  const documents = await searchDocuments(connectionId, {}).catch(() => null)
  const document = documents?.documents.find((d) => d.title === 'The OpenCourse example document')
  if (document && currentUserId() === owner) await addDocument(connectionId, document.id).catch(() => undefined)
}

/** The server phase for whoever is selected now. */
async function seedServerFor(server: string, seed: SeedUser): Promise<void> {
  const owner = currentUserId()
  if (!owner) return
  const connectionId = await ensureSignedIn(server, seed)
  if (!connectionId || currentUserId() !== owner) return
  if (seed.learner) await addLearnerContent(connectionId, owner)
}

let running: Promise<void> | null = null

/** Launch: the local phase, then - if the server answers - the server phase for every seeded user. */
export async function seedDevProfile(): Promise<void> {
  const env = devEnvironment()
  if (!env) return
  // The address as a connection stores it, which is what requests report by.
  const normalized = normalizeServerUrl(env.server)
  if (!normalized.ok) { logger.warn('OPENCOURSE_DEV_SERVER is not a server address'); return }
  const dev = { server: normalized.url }
  try {
    await seedLocal(dev.server)
    const users = seededUsers()
    if (!users.size) return
    if (!(await answers(dev.server))) {
      logger.info('The local server is not running; the dev profile signs in once it is', { data: { server: dev.server } })
    } else {
      for (const [id, seed] of users) {
        try { switchUser(id); await seedServerFor(dev.server, seed) } catch (error) {
          logger.warn('Could not finish seeding a dev user from the server', { data: { code: error instanceof ServerError ? error.code : 'error' }, error })
        } finally { closeDb() }
      }
      clearSession()
    }
  } catch (error) {
    logger.warn('Could not seed the dev profile', { error })
    clearSession()
  }

  // The server came up after the app: catch up the user who is selected.
  healthEvents.on('changed', (url: string, status: string) => {
    if (url !== dev.server || status !== 'online' || running) return
    const owner = currentUserId()
    const seed = owner ? seededUsers().get(owner) : undefined
    if (!seed) return
    running = seedServerFor(dev.server, seed)
      .catch((error: unknown) => logger.warn('Could not finish seeding the selected dev user', { data: { code: error instanceof ServerError ? error.code : 'error' } }))
      .finally(() => { running = null })
  })
}
