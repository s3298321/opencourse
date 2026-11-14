import { db } from './db'
import { readPreferences } from './preferences'
import { validateChatTools, type ChatToolScope, type ChatTools } from '../core/chat-tools'
export function defaultChatTools(scope: ChatToolScope): ChatTools {
  const p = readPreferences()
  return { webSearch: scope === 'authoring' ? p.authoringWebSearch !== false : p.webSearch === true, ...(scope === 'authoring' ? { plan: p.authoringPlan !== false } : {}) }
}
export function initializeChatTools(scope: ChatToolScope, id: string): void {
  db().prepare('INSERT OR IGNORE INTO chat_tools VALUES(?,?,?)').run(scope, id, JSON.stringify(defaultChatTools(scope)))
}
export function getChatTools(scope: ChatToolScope, id: string): ChatTools {
  const row = db().prepare('SELECT payload FROM chat_tools WHERE scope=? AND chat_id=?').get(scope, id) as { payload: string } | undefined
  return row ? JSON.parse(row.payload) : { webSearch: false, ...(scope === 'authoring' ? { plan: false } : {}) }
}
/** Caller must validate chat ownership and hold the runtime's idle/turn guard. */
export function storeChatTools(scope: ChatToolScope, id: string, value: unknown): ChatTools {
  const options = validateChatTools(value, scope === 'authoring')
  db().prepare('INSERT INTO chat_tools VALUES(?,?,?) ON CONFLICT(scope,chat_id) DO UPDATE SET payload=excluded.payload').run(scope, id, JSON.stringify(options))
  return options
}
