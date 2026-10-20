export const LEARNING_SCHEMA = `
CREATE TABLE server_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO server_metadata VALUES ('id', lower(hex(randomblob(16))));
CREATE TABLE enrollments (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('course','document')), content_id TEXT NOT NULL,
 version TEXT NOT NULL, generation TEXT NOT NULL, active INTEGER NOT NULL,
 title TEXT NOT NULL, updated_at TEXT NOT NULL, epoch TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(account_id,kind,content_id)
);
CREATE TABLE learning_fields (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, content_id TEXT NOT NULL, scope TEXT NOT NULL, field TEXT NOT NULL,
 value TEXT NOT NULL, at REAL NOT NULL, operation TEXT NOT NULL, epoch TEXT NOT NULL,
 PRIMARY KEY(account_id,kind,content_id,scope,field)
);
CREATE TABLE learning_events (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 operation TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id,operation)
);
CREATE TABLE learning_changes (
 cursor INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 type TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL
);
CREATE INDEX learning_changes_account ON learning_changes(account_id,cursor);
CREATE TABLE published_documents (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 current_version TEXT NOT NULL, max_version TEXT NOT NULL, unlisted_at TEXT, moderated_at TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE document_versions (
 document_id TEXT NOT NULL REFERENCES published_documents(id) ON DELETE CASCADE,
 version TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, tags TEXT NOT NULL,
 pdf_path TEXT, cover_path TEXT, cover_type TEXT, bytes INTEGER NOT NULL, fingerprint TEXT NOT NULL,
 pages INTEGER NOT NULL DEFAULT 0, sections TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'indexing', error TEXT,
 published_at TEXT NOT NULL, release_note TEXT NOT NULL, deleted_at TEXT,
 PRIMARY KEY(document_id,version)
);
CREATE TABLE document_text (
 document_id TEXT NOT NULL, version TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL,
 PRIMARY KEY(document_id,version,page),
 FOREIGN KEY(document_id,version) REFERENCES document_versions(document_id,version) ON DELETE CASCADE
);
CREATE TABLE learning_ai (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 secret TEXT, hint TEXT, model TEXT NOT NULL DEFAULT 'gpt-4.1-mini', web_search INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE learning_chats (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, content_id TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE learning_messages (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES learning_chats(id) ON DELETE CASCADE,
 role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL,
 citations TEXT NOT NULL DEFAULT '[]', request_id TEXT,
 UNIQUE(chat_id,request_id,role)
);
CREATE TABLE learning_stream (
 id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES learning_messages(id) ON DELETE CASCADE,
 event TEXT NOT NULL
);
`
/**
 * v4: a reasoning level for study chat, a model and level for naming its
 * conversations (NULL model: the chat's own), and the name a chat was given.
 */
export const LEARNING_AI_DEFAULTS = `
ALTER TABLE learning_ai ADD COLUMN reasoning TEXT;
ALTER TABLE learning_ai ADD COLUMN title_model TEXT;
ALTER TABLE learning_ai ADD COLUMN title_reasoning TEXT;
ALTER TABLE learning_chats ADD COLUMN generated_title TEXT;
`

/** v5: composer preferences and structured transcript details. */
export const LEARNING_CHAT_PRESENTATION = `
ALTER TABLE learning_ai ADD COLUMN enabled_models TEXT;
ALTER TABLE learning_messages ADD COLUMN quote TEXT;
ALTER TABLE learning_messages ADD COLUMN model TEXT;
ALTER TABLE learning_messages ADD COLUMN reasoning TEXT;
ALTER TABLE learning_messages ADD COLUMN activity TEXT;
`
