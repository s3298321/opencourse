/**
 * The server's one database: accounts, sessions, codes, and the catalog's
 * relational half - which courses exist, who owns them, which versions were
 * published, which element uid belongs to which course, and who added what.
 *
 * The archives themselves are files under <data>/archives (publish/store.ts);
 * a row only says where. `node:sqlite`, as in the app: Node 22 has it, it has
 * FTS5 for catalog search, and it needs no native build.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA_VERSION = 1

const SCHEMA_V1 = `
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'reset')),
  code_hmac   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);
CREATE INDEX email_codes_by_email ON email_codes(email, purpose, created_at DESC);

CREATE TABLE registration_tickets (
  ticket_hash TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX sessions_by_account ON sessions(account_id);

-- A course is its uid. current_version is what adding or updating installs;
-- NULL when every version was deleted. max_version is the highest ever
-- published, deleted ones included - the floor for the next publish.
CREATE TABLE courses (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES accounts(id),
  slug            TEXT NOT NULL,
  current_version TEXT,
  max_version     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  unlisted_at     TEXT
);
CREATE INDEX courses_by_owner ON courses(owner_id);

-- A deleted version keeps its row: its number stays taken.
CREATE TABLE course_versions (
  course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  major        INTEGER NOT NULL,
  minor        INTEGER NOT NULL,
  patch        INTEGER NOT NULL,
  archive_path TEXT,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  cover_path   TEXT,
  cover_type   TEXT,
  overview     TEXT NOT NULL,
  release_note TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  deleted_at   TEXT,
  PRIMARY KEY (course_id, version)
);

-- Every element uid belongs to exactly one course, and its kind never changes.
-- parent is where the element was last published; a flashcard may never move.
CREATE TABLE elements (
  uid       TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  parent    TEXT
);
CREATE INDEX elements_by_course ON elements(course_id);

CREATE TABLE acquisitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('add', 'update')),
  at         TEXT NOT NULL
);
CREATE INDEX acquisitions_by_course ON acquisitions(course_id, kind, account_id);

CREATE TABLE course_tags (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (course_id, tag)
);
CREATE INDEX course_tags_by_tag ON course_tags(tag);

-- The current version's searchable text, one row per listed course.
CREATE VIRTUAL TABLE course_search USING fts5(
  course_id UNINDEXED, title, description, subject, author, publisher, tags, outline,
  tokenize = 'unicode61 remove_diacritics 2'
);
`

export type Db = DatabaseSync

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true })
  const d = new DatabaseSync(file)
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  migrate(d)
  return d
}

function migrate(d: Db): void {
  const row = d.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const from = Number(row?.user_version ?? 0)
  if (from > SCHEMA_VERSION) throw new Error(`server.db is from a newer version of the server (${from})`)
  if (from < 1) d.exec(SCHEMA_V1)
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** One transaction; rolled back if `body` throws. */
export function tx<T>(d: Db, body: () => T): T {
  d.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    d.exec('COMMIT')
    return result
  } catch (error) {
    d.exec('ROLLBACK')
    throw error
  }
}

export const nowIso = (): string => new Date().toISOString()
