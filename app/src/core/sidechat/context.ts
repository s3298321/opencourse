/**
 * A lesson, flattened to something a model can read.
 *
 * Two rules govern what goes in.
 *
 * The first is that **answers stay out**. A tutor that has been handed the
 * `correct` flags will give a quiz away on the first ambiguous question, and an
 * exercise's `solution` is the one thing the learner is there to write. So this
 * takes quiz *questions* and option *texts* but never `correct` or
 * `explanation`, and exercise prompts but never `solution`, `tests` or
 * `expected_output`. It is the same instinct as `stripBlock` in main/ipc.ts,
 * which keeps those fields from reaching the renderer - except that here it
 * matters even more, because the model will happily paraphrase.
 *
 * The second is that **it says what it cannot see**. A visualization is a
 * sandboxed iframe: its contents are unreachable from the app, let alone from
 * here. Naming it and saying so is what stops a model inventing what the
 * animation showed.
 */
import type { Block, Lesson } from '../types'

/** Big enough for any lesson in practice; small enough to bound the bill. */
export const MAX_CONTEXT_CHARS = 24_000

const ELIDED = '\n\n[…the rest of this lesson was too long to include…]'

function blockText(block: Block): string | null {
  switch (block.type) {
    case 'markdown':
      return block.content
    case 'image':
      return block.caption || block.alt ? `[Image: ${block.caption ?? block.alt}]` : '[Image]'
    case 'video':
      return block.caption ? `[Video: ${block.caption}]` : '[Video]'
    case 'visualization':
      // Deliberately not "here is what it shows": nothing in the app can read
      // inside the sandbox, so neither can this.
      return `[Interactive visualization${block.title ? `: ${block.title}` : ''} - the learner can see it running; you cannot.]`
    case 'quiz': {
      const options = (block.options ?? []).map((o) => `- ${o.text}`)
      return [`[Quiz question] ${block.question}`, ...options].join('\n')
    }
    case 'exercise': {
      const parts = [`[Exercise: ${block.title}]`, block.prompt]
      if (block.starter_code) parts.push(`Starter code the learner is given:\n\`\`\`\n${block.starter_code}\n\`\`\``)
      parts.push(`What counts as done: ${block.verification_instructions}`)
      if (block.hints?.length) parts.push(`Hints the lesson offers:\n${block.hints.map((h) => `- ${h}`).join('\n')}`)
      return parts.join('\n\n')
    }
  }
}

/**
 * The text injected as a `context` message. `courseTitle` and the module title
 * are included because a chat can span lessons, and "which lesson is this?" has
 * to be answerable from the message alone once several are in the thread.
 */
export function lessonContextText(
  courseTitle: string,
  moduleTitle: string,
  lesson: Omit<Lesson, 'flashcards'>,
  subject?: string
): string {
  const head = [
    `The learner is now reading this lesson.`,
    ``,
    `Course: ${courseTitle}${subject ? ` (${subject})` : ''}`,
    `Module: ${moduleTitle}`,
    `Lesson: ${lesson.title}`
  ]
  if (lesson.objectives?.length) {
    head.push(``, `By the end of it they should be able to:`, ...lesson.objectives.map((o) => `- ${o}`))
  }

  const body = lesson.blocks
    .map(blockText)
    .filter((t): t is string => t !== null && t.trim() !== '')
    .join('\n\n')

  const full = `${head.join('\n')}\n\n--- the lesson itself ---\n\n${body}`
  if (full.length <= MAX_CONTEXT_CHARS) return full
  // Trim the tail rather than the head: the heading says which lesson this is,
  // and losing that would make every later message ambiguous.
  return full.slice(0, MAX_CONTEXT_CHARS - ELIDED.length) + ELIDED
}
