import { UUID } from '../course-document'
/**
 * The two decisions a side chat makes on every send, both pure.
 *
 * `needsContext` answers "does this chat already know which lesson we are in?".
 * `buildInput` turns stored rows into what the Responses API is given.
 *
 * Both live here rather than in main so that the whole context-injection rule -
 * the thing the feature is actually about - can be tested with no database, no
 * key and no network, the way core/coach/events.ts tests a session with no
 * socket.
 */
import type { ChatLessonRef, ChatMessage, QuoteSource } from '../types'

/** The model's input, in the Responses API's shape. */
export interface ChatInputItem {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * The history budget. Generous, because a tutoring conversation is worth little
 * with amnesia, but finite: an afternoon in one chat would otherwise re-send
 * every lesson it has visited on every turn.
 */
export const MAX_INPUT_CHARS = 120_000

/** The learner's own text, per message. Long enough to paste a traceback into. */
export const MAX_MESSAGE_CHARS = 4_000

/** A highlighted passage. A lesson's longest paragraph fits several times over. */
export const MAX_QUOTE_CHARS = 2_000

export function sameLesson(a: ChatLessonRef | undefined, b: ChatLessonRef): boolean {
  return a !== undefined && a.lessonId === b.lessonId && (UUID.test(b.lessonId) || a.moduleId === b.moduleId)
}

/**
 * True unless the most recent lesson context in this chat is already this
 * lesson.
 *
 * Note it is the *most recent* context that counts, not any of them: going
 * lesson 3 -> lesson 7 -> lesson 3 re-injects lesson 3, because by then the
 * model has a whole other lesson between it and the first copy. The older copy
 * stays in the thread regardless - that is what "the previous context is kept"
 * means here.
 */
export function needsContext(messages: readonly ChatMessage[], lesson: ChatLessonRef, fingerprint?: string): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'context') return !sameLesson(message.lesson, lesson) || (fingerprint !== undefined && message.contextFingerprint !== fingerprint)
  }
  return true
}

/**
 * Where a passage was highlighted, in the learner's voice. "One of your earlier
 * answers" rather than "your last answer" because neither the last one nor
 * this chat is guaranteed: a passage stays attached when you switch tabs, which
 * is how you take one answer's loose end into a fresh chat.
 */
const QUOTED_FROM: Record<QuoteSource, string> = {
  lesson: 'From the lesson',
  preview: 'From the course preview',
  answer: 'From one of your earlier answers'
}

/** A quoted passage rides with the question it was attached to, as a quotation. */
function withQuote(message: ChatMessage): string {
  if (!message.quote) return message.text
  const quoted = message.quote.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${QUOTED_FROM[message.quote.from]}, I have highlighted this:\n\n${quoted}\n\nMy question about it:\n\n${message.text}`
}

function itemFor(message: ChatMessage): ChatInputItem {
  if (message.role === 'assistant') return { role: 'assistant', content: message.text }
  // A context message is not something the learner said, but the Responses API
  // has no third voice for it and a second `system` item would read as a second
  // set of instructions. A user-voiced, clearly-labelled block is the honest
  // shape - and it is what the system prompt tells the model to expect.
  if (message.role === 'context') {
    return { role: 'user', content: `[lesson context]\n\n${message.text}` }
  }
  return { role: 'user', content: withQuote(message) }
}

/**
 * Instructions first, then as much of the conversation as the budget allows,
 * dropping from the oldest.
 *
 * Three things are never dropped, because without any of them the request is
 * incoherent rather than merely shorter: the instructions, the newest lesson
 * context, and the message being answered. If those three alone exceed the
 * budget it is the lesson context that is already capped (MAX_CONTEXT_CHARS),
 * so the request still goes out.
 */
export function buildInput(
  messages: readonly ChatMessage[],
  instructions: string
): ChatInputItem[] {
  const head: ChatInputItem = { role: 'system', content: instructions }
  if (!messages.length) return [head]

  const lastContext = messages.reduce<number>((found, m, i) => (m.role === 'context' ? i : found), -1)
  const required = new Set<number>([messages.length - 1])
  if (lastContext >= 0) required.add(lastContext)

  let budget = MAX_INPUT_CHARS - instructions.length
  for (const i of required) budget -= messages[i]!.text.length

  const keep = new Set(required)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (keep.has(i)) continue
    const cost = messages[i]!.text.length + (messages[i]!.quote?.text.length ?? 0)
    if (cost > budget) break
    budget -= cost
    keep.add(i)
  }

  const body = messages.filter((_, i) => keep.has(i)).map(itemFor)
  return [head, ...body]
}
