/**
 * The app's databases: their files, their pragmas, their migrations.
 *
 * Courses, progress and users stay JSON files, and that split is deliberate:
 * JSON for small documents a human might hand-edit, which must degrade to
 * "what I can still read"; SQLite for the things with a relational shape and
 * unbounded growth - a coach project's sessions and their turns, and a course's
 * side chats and their messages.
 *
 * There are two files. `db()` is the user's, one per user, holding everything
 * above. `logDb()` is the app's log, and it is app-wide because some lines
 * belong to nobody - startup, a crash, anything before the picker; each row
 * names the user it was written under instead (main/logdb.ts).
 *
 * It uses Node's built-in `node:sqlite`, NOT better-sqlite3, and that is not an
 * accident: electron-builder.yml sets `npmRebuild: false` because node-pty is a
 * Node-API addon whose prebuilts load in Electron unchanged, and adding a
 * dependency that needs node-gyp would break packaging for everyone. Electron
 * 44 bundles Node 24, which has `node:sqlite` (with FTS5, should transcript
 * search ever want it); so does the repo's pinned Node 22, which is what
 * vitest runs on. Zero new dependencies. Do not "fix" this back.
 *
 * `node:sqlite` is still marked experimental, which is why its *lifecycle* API
 * - DatabaseSync itself, the pragmas, user_version - is confined to this file.
 * If it shifts in a Node major, this is the file that changes; coachdb.ts and
 * chatdb.ts only ever prepare statements against the handle it hands them.
 *
 * DatabaseSync is synchronous and blocks the main process, so every query in
 * those files is bounded and filtered by project, session, chat or course. No
 * unbounded SELECT.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { logDbFile, userDbFile } from './paths'
import { requireUser } from './users'
import { log } from './log'

/** Bumped by every migration step below; tests pin against it rather than a literal. */
export const SCHEMA_VERSION = 12

/** Coach: a project, its sessions, and what was said and done in them. */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  voice        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  allow_delete INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  status       TEXT NOT NULL,
  model        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  call_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  arguments  TEXT NOT NULL,
  result     TEXT,
  ok         INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_by_session ON tool_calls(session_id, seq);
`

/**
 * Side chat: a conversation about a course, and its messages.
 *
 * Additive, so a v1 database keeps every coach row. There is no user_id column
 * for the same reason the v1 tables have none - the file itself is per user, so
 * no query can forget a `WHERE user_id = ?`. The course slug *is* a column,
 * because a course is not a directory here.
 *
 * `role = 'context'` rows hold a lesson snapshot the app injected rather than
 * anything a person typed. Keeping them as ordinary rows is what makes "has
 * this chat already been told about this lesson?" a question about the
 * transcript instead of hidden state.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  course_slug TEXT NOT NULL,
  model       TEXT NOT NULL,
  module_slug TEXT NOT NULL,
  lesson_slug TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_by_course ON chats(course_slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  quote       TEXT,
  module_slug TEXT,
  lesson_slug TEXT,
  at          TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
`

/**
 * Adds a nullable column, unless it is already there.
 *
 * Checked rather than assumed, because unlike the CREATE steps above an ALTER
 * is not idempotent: a launch killed between it and the user_version bump would
 * otherwise fail the next open with "duplicate column", and a failed open
 * quarantines the file - every transcript in it - over a column it already has.
 * The table and column are this file's own literals, never input.
 */
function addColumn(d: DatabaseSync, table: string, column: string): void {
  const columns = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
}

let handle: { file: string; db: DatabaseSync } | null = null

function applyPragmas(d: DatabaseSync): void {
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA foreign_keys = ON')
  d.exec('PRAGMA busy_timeout = 5000')
  d.exec('PRAGMA synchronous = FULL')
}

function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const from = Number(row?.user_version ?? 0)
  if (from > SCHEMA_VERSION) throw new Error(`coach.db is from a newer version of OpenCourse (${from})`)
  if (from < 1) d.exec(SCHEMA_V1)
  if (from < 2) d.exec(SCHEMA_V2)
  // v3: where a quoted passage came from, 'lesson' or 'answer'. NULL on every
  // row written before an answer could be quoted - and those were all from the
  // lesson, which is what NULL is read as.
  if (from < 3) addColumn(d, 'chat_messages', 'quote_from')
  // v4: a chat's reasoning level. NULL is the model's own default, which is
  // what every chat had before there was a choice.
  if (from < 4) addColumn(d, 'chats', 'reasoning')
  if (from < 5) d.exec(`
    CREATE TABLE IF NOT EXISTS course_project_chats (
      id TEXT PRIMARY KEY, course_slug TEXT NOT NULL, module_slug TEXT NOT NULL,
      model TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS course_project_chats_by_scope ON course_project_chats(course_slug, module_slug, updated_at DESC);
    CREATE TABLE IF NOT EXISTS course_project_messages (
      chat_id TEXT NOT NULL REFERENCES course_project_chats(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(chat_id, seq)
    );
    CREATE TABLE IF NOT EXISTS course_project_tool_calls (
      chat_id TEXT NOT NULL REFERENCES course_project_chats(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL,
      arguments TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY(chat_id, message_seq, call_id)
    );
  `)
  // v6: the pages an answer cited from a web search, as JSON. NULL on every
  // answer that did not search - which was every answer before it could.
  if (from < 6) addColumn(d, 'chat_messages', 'sources')
  if (from < 7) {
    addColumn(d, 'chats', 'provider')
    addColumn(d, 'course_project_chats', 'provider')
    addColumn(d, 'chat_messages', 'status')
    d.exec("UPDATE chats SET provider = 'apiKey' WHERE provider IS NULL; UPDATE course_project_chats SET provider = 'apiKey' WHERE provider IS NULL")
  }
  // v8: optional AI titles; the first prompt remains the fallback while naming.
  if (from < 8) {
    addColumn(d, 'chats', 'generated_title')
    addColumn(d, 'course_project_chats', 'generated_title')
  }
  // v9: preserve the actual model, reasoning and connection for each lesson response.
  // Project messages already store their full payload as JSON.
  if (from < 9) addColumn(d, 'chat_messages', 'generation')
  if (from < 10) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS library_courses (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS course_elements (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES library_courses(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES course_elements(id) ON DELETE CASCADE, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS course_elements_by_course ON course_elements(course_id);
      CREATE TABLE IF NOT EXISTS course_operations (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, revision INTEGER NOT NULL);
    `)
    const add = (table: string, column: string, declaration: string): void => {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
    }
    add('chats', 'course_id', 'TEXT REFERENCES library_courses(id) ON DELETE CASCADE')
    add('chats', 'start_lesson_id', 'TEXT REFERENCES course_elements(id) ON DELETE SET NULL')
    add('chats', 'next_seq', 'INTEGER NOT NULL DEFAULT 0')
    add('chat_messages', 'lesson_id', 'TEXT REFERENCES course_elements(id) ON DELETE CASCADE')
    add('chat_messages', 'context_fingerprint', 'TEXT')
    add('course_project_chats', 'course_id', 'TEXT REFERENCES library_courses(id) ON DELETE CASCADE')
    add('course_project_chats', 'module_id', 'TEXT REFERENCES course_elements(id) ON DELETE CASCADE')
    d.exec(`UPDATE chats SET next_seq = COALESCE((SELECT MAX(seq)+1 FROM chat_messages WHERE chat_id=chats.id), 0)`)
  }
  if (from < 11) d.exec(`
    CREATE TABLE IF NOT EXISTS authoring_chats (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES library_courses(id) ON DELETE CASCADE,
      model TEXT NOT NULL, reasoning TEXT, provider TEXT NOT NULL, generated_title TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS authoring_chats_by_course ON authoring_chats(course_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS authoring_messages (
      chat_id TEXT NOT NULL REFERENCES authoring_chats(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(chat_id, seq)
    );
    CREATE TABLE IF NOT EXISTS authoring_tool_calls (
      chat_id TEXT NOT NULL REFERENCES authoring_chats(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL,
      arguments TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY(chat_id, message_seq, call_id)
    );
  `)
  if (from < 12) d.exec(`
    CREATE TABLE IF NOT EXISTS flashcard_states (
      card_id TEXT PRIMARY KEY REFERENCES course_elements(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES library_courses(id) ON DELETE CASCADE,
      due TEXT NOT NULL, state TEXT NOT NULL, configuration TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS flashcard_states_by_due ON flashcard_states(course_id, due);
    CREATE TABLE IF NOT EXISTS flashcard_reviews (
      session_id TEXT NOT NULL, card_id TEXT NOT NULL REFERENCES flashcard_states(card_id) ON DELETE CASCADE,
      rating TEXT NOT NULL CHECK(rating IN ('again', 'hard', 'good', 'easy')),
      at TEXT NOT NULL, log TEXT NOT NULL,
      PRIMARY KEY(session_id, card_id)
    );
    CREATE INDEX IF NOT EXISTS flashcard_reviews_by_card ON flashcard_reviews(card_id, at);
  `)
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * A session left `live` means the app went away mid-conversation - a force
 * quit, a crash, a lost renderer. Nothing can resume it (the Realtime API has
 * no resume), so no session may survive a launch still claiming to be running.
 */
function sweepLiveSessions(d: DatabaseSync): void {
  d.prepare(`UPDATE sessions SET status = 'ended', ended_at = ?, error = ? WHERE status = 'live'`).run(
    new Date().toISOString(),
    'interrupted'
  )
}

/** A corrupt database costs transcripts, never the app. Projects come back from their mirrors. */
function quarantine(file: string): string {
  const stamp = Date.now()
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${file}${suffix}`
    if (existsSync(from)) {
      try {
        renameSync(from, `${file}.broken-${stamp}${suffix}`)
      } catch {
        /* best effort: a fresh open is what matters */
      }
    }
  }
  return `${file}.broken-${stamp}`
}

export class DatabaseMigrationError extends Error {}

function open(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true })
  const d = new DatabaseSync(file)
  applyPragmas(d)
  try { migrate(d) } catch (err) {
    d.close()
    throw new DatabaseMigrationError(`Database migration failed: ${(err as Error).message}`)
  }
  sweepLiveSessions(d)
  return d
}

/**
 * Opens lazily, cached on the resolved file path rather than the user id:
 * courses.ts caches on the id, which is right for it, but a test that points
 * userData somewhere new while keeping ids would be served a stale handle.
 *
 * Only IPC handlers reach this - never app.whenReady() - so even a pathological
 * failure shows up as an error on the screen that asked rather than a window
 * that never paints.
 */
export function db(): DatabaseSync {
  const file = userDbFile(requireUser())
  if (handle?.file === file) return handle.db

  if (handle) {
    try {
      handle.db.close()
    } catch {
      /* already gone */
    }
    handle = null
  }

  let d: DatabaseSync
  try {
    d = open(file)
  } catch (err) {
    if (err instanceof DatabaseMigrationError) {
      log.child('db').error('The database could not be migrated', { error: err })
      throw err
    }
    const moved = quarantine(file)
    log.child('db').error('The database was unreadable and has been set aside', { file, movedTo: moved, error: err })
    d = open(file)
  }
  handle = { file, db: d }
  return d
}

/** Test seam, switchUser, and before-quit. Reopening is cheap. */
export function closeDb(): void {
  if (!handle) return
  try {
    handle.db.close()
  } catch {
    /* already gone */
  }
  handle = null
}

/* --- the log ---------------------------------------------------------------- */

/** The log's own ladder: a different file, so a different user_version. */
export const LOG_SCHEMA_VERSION = 1

/**
 * One table, one row per line. `level` is a number (core/logging LEVEL_RANK) so
 * sorting by it sorts by severity; `at` is epoch ms so a range is two integer
 * comparisons. `user_id` is NULL for a line that belongs to nobody.
 */
const LOG_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  level   INTEGER NOT NULL,
  scope   TEXT NOT NULL,
  message TEXT NOT NULL,
  user_id TEXT,
  data    TEXT
);
CREATE INDEX IF NOT EXISTS logs_by_at ON logs(at);
CREATE INDEX IF NOT EXISTS logs_by_user ON logs(user_id, at);
`

let logHandle: { file: string; db: DatabaseSync } | null = null

function openLog(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true })
  const d = new DatabaseSync(file)
  try {
    d.exec('PRAGMA journal_mode = WAL')
    d.exec('PRAGMA busy_timeout = 5000')
    // A log line lost to a power cut is not worth an fsync per batch.
    d.exec('PRAGMA synchronous = NORMAL')
    const row = d.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const from = Number(row?.user_version ?? 0)
    if (from > LOG_SCHEMA_VERSION) throw new Error(`logs.db is from a newer version of OpenCourse (${from})`)
    if (from < 1) d.exec(LOG_SCHEMA_V1)
    d.exec(`PRAGMA user_version = ${LOG_SCHEMA_VERSION}`)
    return d
  } catch (err) {
    d.close()
    throw err
  }
}

/**
 * The log's handle, opened lazily like `db()`. A log that cannot be opened is
 * set aside and started again - losing old lines is always better than losing
 * the next ones. It reports through stderr rather than `log`, because the log
 * is the thing that is broken.
 */
export function logDb(): DatabaseSync {
  const file = logDbFile()
  if (logHandle?.file === file) return logHandle.db
  closeLogDb()
  let d: DatabaseSync
  try {
    d = openLog(file)
  } catch (err) {
    process.stderr.write(`[log] ${file} is unreadable, setting it aside: ${(err as Error).message}\n`)
    quarantine(file)
    d = openLog(file)
  }
  logHandle = { file, db: d }
  return d
}

export function closeLogDb(): void {
  if (!logHandle) return
  try {
    logHandle.db.close()
  } catch {
    /* already gone */
  }
  logHandle = null
}

/** BEGIN IMMEDIATE, so a write transaction does not start as a reader and upgrade. */
export function tx<T>(fn: (d: DatabaseSync) => T): T {
  const d = db()
  d.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(d)
    d.exec('COMMIT')
    return result
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* the transaction is already gone */
    }
    throw err
  }
}
