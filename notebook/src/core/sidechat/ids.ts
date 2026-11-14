/**
 * Chat ids, shaped like the coach's so a stack trace never leaves you guessing
 * which of the three a `c*_` id is: `cp_` project, `cs_` session, `ch_` chat.
 *
 * Unlike the coach's, a chat id never becomes a directory name - a chat is a
 * database row and nothing else - but it is kept to SAFE_SEGMENT shape anyway,
 * so that stays true on purpose rather than by luck.
 */

function hex12(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function newChatId(): string {
  return `ch_${hex12()}`
}

const CHAT_ID_RE = /^ch_[a-f0-9]{6,32}$/

export function isChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RE.test(value)
}
