/**
 * The side chat's rules, without a database, a key or a network.
 *
 * Two things are specified here and nowhere else: when a lesson gets re-sent to
 * a chat that has moved between lessons, and what a lesson looks like once
 * flattened for a model. The second half is mostly negative - what must *not*
 * be in there - because a tutor holding the quiz answers is a bug you only
 * notice by reading a transcript.
 */
import { describe, expect, it } from 'vitest'
import { findLesson } from '@core/manifest'
import { MAX_CONTEXT_CHARS, lessonContextText } from '@core/sidechat/context'
import {
  DEFAULT_CHAT_MODEL,
  defaultChatModel,
  filterChatModels,
  isChatModelId,
  offeredModels,
  reasoningEffortsFor
} from '@core/sidechat/models'
import { newChatDefaults, normalizePreferences } from '@core/preferences'
import { SIDE_CHAT_INSTRUCTIONS } from '@core/sidechat/prompt'
import { MAX_INPUT_CHARS, buildInput, needsContext } from '@core/sidechat/thread'
import { isChatId, newChatId } from '@core/sidechat/ids'
import { committedCourseDirs, fixtureCourseDir, loadCourse } from './helpers/courses'
import type { ChatMessage, ChatQuote, Lesson } from '@core/types'

const course = loadCourse(fixtureCourseDir('python-asyncio'))

const AT = '2026-09-14T10:00:00.000Z'
let seq = 0
const msg = (role: ChatMessage['role'], text: string, lesson?: [string, string], quote?: ChatQuote): ChatMessage => ({
  seq: (seq += 1),
  role,
  text,
  ...(quote ? { quote } : {}),
  ...(lesson ? { lesson: { moduleId: lesson[0], lessonId: lesson[1] } } : {}),
  at: AT
})

const L1: [string, string] = ['foundations', 'event-loop']
const L2: [string, string] = ['foundations', 'coroutines-and-tasks']

describe('when a lesson is sent to the model', () => {
  it('is sent to a chat that has never been told anything', () => {
    expect(needsContext([], { moduleId: L1[0], lessonId: L1[1] })).toBe(true)
  })

  it('is not sent again while the learner stays in the same lesson', () => {
    const messages = [msg('context', 'lesson one', L1), msg('user', 'why?', L1), msg('assistant', 'because', L1)]
    expect(needsContext(messages, { moduleId: L1[0], lessonId: L1[1] })).toBe(false)
  })

  it('is sent again the first time they ask from a different lesson', () => {
    const messages = [msg('context', 'lesson one', L1), msg('user', 'why?', L1)]
    expect(needsContext(messages, { moduleId: L2[0], lessonId: L2[1] })).toBe(true)
  })

  it('is sent again on coming back, because another lesson now sits in between', () => {
    const messages = [
      msg('context', 'lesson one', L1),
      msg('user', 'why?', L1),
      msg('context', 'lesson two', L2),
      msg('user', 'and this?', L2)
    ]
    expect(needsContext(messages, { moduleId: L1[0], lessonId: L1[1] })).toBe(true)
  })

  it('ignores user messages when deciding - only the last context counts', () => {
    const messages = [msg('context', 'lesson one', L1), msg('user', 'asked from elsewhere', L2)]
    expect(needsContext(messages, { moduleId: L1[0], lessonId: L1[1] })).toBe(false)
  })
})

describe('the input sent to the model', () => {
  it('leads with the instructions, and with nothing else when the chat is empty', () => {
    const input = buildInput([], SIDE_CHAT_INSTRUCTIONS)
    expect(input).toEqual([{ role: 'system', content: SIDE_CHAT_INSTRUCTIONS }])
  })

  it('keeps the whole conversation in order', () => {
    const messages = [msg('context', 'lesson one', L1), msg('user', 'why?', L1), msg('assistant', 'because', L1)]
    const input = buildInput(messages, 'be a tutor')
    expect(input.map((i) => i.role)).toEqual(['system', 'user', 'user', 'assistant'])
    expect(input[1]!.content).toContain('[lesson context]')
    expect(input[2]!.content).toBe('why?')
  })

  it('carries a highlighted passage with the question it was attached to', () => {
    const input = buildInput(
      [msg('user', 'what does this mean?', L1, { text: 'await yields to the loop', from: 'lesson' })],
      'x'
    )
    const asked = input[1]!.content
    expect(asked).toContain('From the lesson')
    expect(asked).toContain('> await yields to the loop')
    expect(asked).toContain('what does this mean?')
  })

  it('says a passage of an answer came from an answer, not from the lesson', () => {
    // Told "from the lesson", the model goes looking for its own words in a
    // lesson that never said them, and explains the discrepancy instead.
    const messages = [
      msg('user', 'why?', L1),
      msg('assistant', 'Because the loop only regains control at an await.', L1),
      msg('user', 'only there?', L1, { text: 'only regains control at an await', from: 'answer' })
    ]
    const asked = buildInput(messages, 'x').at(-1)!.content
    expect(asked).toContain('From one of your earlier answers')
    expect(asked).not.toContain('From the lesson')
    expect(asked).toContain('> only regains control at an await')
    expect(asked).toContain('only there?')
  })

  it('leaves an unquoted message exactly as it was typed', () => {
    const input = buildInput([msg('user', 'plain question', L1)], 'x')
    expect(input[1]!.content).toBe('plain question')
  })

  it('drops the oldest messages when the conversation outgrows the budget', () => {
    const big = 'x'.repeat(30_000)
    const messages = [
      msg('user', `oldest ${big}`, L1),
      msg('assistant', `middle ${big}`, L1),
      msg('user', `newer ${big}`, L1),
      msg('assistant', `newest ${big}`, L1),
      msg('user', 'the question', L1)
    ]
    const input = buildInput(messages, 'x')
    const all = input.map((i) => i.content).join('\n')
    expect(all.length).toBeLessThanOrEqual(MAX_INPUT_CHARS)
    expect(all).not.toContain('oldest')
    expect(all).toContain('the question')
  })

  it('never drops the instructions, the newest lesson or the question being asked', () => {
    const big = 'x'.repeat(60_000)
    const messages = [
      msg('context', `old lesson ${big}`, L1),
      msg('user', `chatter ${big}`, L1),
      msg('context', 'the lesson they are actually reading', L2),
      msg('user', `more chatter ${big}`, L2),
      msg('user', 'the question', L2)
    ]
    const input = buildInput(messages, SIDE_CHAT_INSTRUCTIONS)
    const all = input.map((i) => i.content).join('\n')
    expect(input[0]!.content).toBe(SIDE_CHAT_INSTRUCTIONS)
    expect(all).toContain('the lesson they are actually reading')
    expect(all).toContain('the question')
    expect(all).not.toContain('old lesson')
  })
})

describe('a lesson flattened for the model', () => {
  const found = findLesson(course, 'foundations', 'event-loop')!
  const text = lessonContextText(course.title, found.module.title, found.lesson, course.subject)

  it('says which course, module and lesson it is', () => {
    expect(text).toContain(course.title)
    expect(text).toContain(found.module.title)
    expect(text).toContain(found.lesson.title)
  })

  it('includes the objectives and the prose the learner is reading', () => {
    for (const objective of found.lesson.objectives ?? []) expect(text).toContain(objective)
    const firstMarkdown = found.lesson.blocks.find((b) => b.type === 'markdown')
    expect(firstMarkdown).toBeDefined()
    if (firstMarkdown?.type === 'markdown') {
      expect(text).toContain(firstMarkdown.content.split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 20))
    }
  })

  it('names a visualization but never claims to see inside it', () => {
    const lesson: Lesson = {
      slug: 'l',
      title: 'L',
      blocks: [{ type: 'visualization', slug: 'the-loop-turning', src: 'assets/viz/x/index.html', title: 'The loop, turning' }]
    }
    const out = lessonContextText('C', 'M', lesson)
    expect(out).toContain('The loop, turning')
    expect(out).toContain('you cannot')
  })

  it('gives the model the quiz question and the options, and never which is right', () => {
    const lesson: Lesson = {
      slug: 'l',
      title: 'L',
      blocks: [
        {
          type: 'quiz', slug: 'q1',
          id: 'q1',
          kind: 'single',
          question: 'What does await do?',
          options: [
            { id: 'a', text: 'Blocks the thread', correct: false },
            { id: 'b', text: 'Yields to the event loop', correct: true }
          ],
          explanation: 'THE GIVEAWAY EXPLANATION'
        }
      ]
    }
    const out = lessonContextText('C', 'M', lesson)
    expect(out).toContain('What does await do?')
    expect(out).toContain('Yields to the event loop')
    expect(out).not.toContain('correct')
    expect(out).not.toContain('THE GIVEAWAY EXPLANATION')
  })

  it('gives the model the exercise prompt, and never the solution or the tests', () => {
    const lesson: Lesson = {
      slug: 'l',
      title: 'L',
      blocks: [
        {
          type: 'exercise', slug: 'e1',
          id: 'e1',
          title: 'Gather two coroutines',
          prompt: 'Write a function that gathers them.',
          starter_code: 'async def main():\n    ...\n',
          solution: 'THE WHOLE ANSWER',
          tests: 'THE TEST FILE',
          expected_output: 'THE EXPECTED STDOUT',
          verification_instructions: 'both results come back in order',
          hints: ['asyncio.gather takes *coros']
        }
      ]
    }
    const out = lessonContextText('C', 'M', lesson)
    expect(out).toContain('Gather two coroutines')
    expect(out).toContain('Write a function that gathers them.')
    expect(out).toContain('async def main()')
    expect(out).toContain('asyncio.gather takes *coros')
    expect(out).not.toContain('THE WHOLE ANSWER')
    expect(out).not.toContain('THE TEST FILE')
    expect(out).not.toContain('THE EXPECTED STDOUT')
  })

  it('keeps no answer from any course shipped with the repo', () => {
    for (const dir of committedCourseDirs()) {
      const each = loadCourse(dir)
      for (const ref of each.flatLessons) {
        const at = findLesson(each, ref.moduleId, ref.lessonId)!
        const out = lessonContextText(each.title, at.module.title, at.lesson, each.subject)
        for (const block of at.lesson.blocks) {
          if (block.type === 'quiz' && block.explanation) expect(out).not.toContain(block.explanation)
          if (block.type === 'exercise' && block.solution) expect(out).not.toContain(block.solution)
          if (block.type === 'exercise' && block.tests) expect(out).not.toContain(block.tests)
        }
      }
    }
  })

  it('is capped, so one enormous lesson cannot run up a bill on its own', () => {
    const lesson: Lesson = {
      slug: 'l',
      title: 'L',
      blocks: [{ type: 'markdown', slug: 'markdown', content: 'y'.repeat(MAX_CONTEXT_CHARS * 2) }]
    }
    const out = lessonContextText('C', 'M', lesson)
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(out).toContain('too long to include')
    // The heading survives: every later message depends on knowing which lesson.
    expect(out).toContain('Lesson: L')
  })
})

describe('models and ids', () => {
  it('mints ids it recognises, and recognises nothing else', () => {
    expect(isChatId(newChatId())).toBe(true)
    expect(isChatId('cp_abc123abc123')).toBe(false)
    expect(isChatId('../etc')).toBe(false)
  })

  it('keeps chat models and drops everything else a key can reach', () => {
    expect(isChatModelId(DEFAULT_CHAT_MODEL)).toBe(true)
    expect(isChatModelId('gpt-realtime-2.1')).toBe(false)
    expect(isChatModelId('gpt-4o-mini-transcribe')).toBe(false)
    expect(isChatModelId('text-embedding-3-large')).toBe(false)
    expect(isChatModelId('dall-e-3')).toBe(false)
    expect(isChatModelId('whisper-1')).toBe(false)
  })

  it('puts the default first and a dated snapshot after its plain id', () => {
    const models = filterChatModels(['gpt-5.1-2026-01-01', 'gpt-5.1', DEFAULT_CHAT_MODEL, 'whisper-1'])
    expect(models.map((m) => m.id)).toEqual([DEFAULT_CHAT_MODEL, 'gpt-5.1', 'gpt-5.1-2026-01-01'])
  })
})

describe('which reasoning levels a model is offered', () => {
  it('follows the generation, because the sets changed between them', () => {
    expect(reasoningEffortsFor('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(reasoningEffortsFor('gpt-5-mini-2025-08-07')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(reasoningEffortsFor('gpt-5.1')).toEqual(['none', 'low', 'medium', 'high'])
    expect(reasoningEffortsFor('gpt-5.2')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(reasoningEffortsFor('o4-mini')).toEqual(['low', 'medium', 'high'])
  })

  it('offers the default model the newest set', () => {
    expect(reasoningEffortsFor(DEFAULT_CHAT_MODEL)).toContain('xhigh')
  })

  it('offers nothing it cannot be sure of, so the request never carries a level that breaks it', () => {
    for (const id of ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-5-pro', 'o3-pro', 'o1-mini', 'gpt-oss-120b']) {
      expect(reasoningEffortsFor(id), id).toEqual([])
    }
  })
})

describe('which models the picker offers', () => {
  const available = filterChatModels([DEFAULT_CHAT_MODEL, 'gpt-5.1', 'gpt-5-mini'])

  it('offers everything until a choice is made', () => {
    expect(offeredModels(available, null)).toEqual(available)
  })

  it('offers the chosen ones, in the order the key lists them', () => {
    expect(offeredModels(available, ['gpt-5.1', 'gpt-5-mini']).map((m) => m.id)).toEqual(
      available.filter((m) => m.id !== DEFAULT_CHAT_MODEL).map((m) => m.id)
    )
  })

  it('never leaves the picker empty', () => {
    expect(offeredModels(available, ['gpt-5.2'])).toEqual(available)
  })

  it('starts a new chat on the default, unless it was switched off', () => {
    expect(defaultChatModel(null)).toBe(DEFAULT_CHAT_MODEL)
    expect(defaultChatModel(['gpt-5.1', DEFAULT_CHAT_MODEL])).toBe(DEFAULT_CHAT_MODEL)
    expect(defaultChatModel(['gpt-5.1', 'gpt-5-mini'])).toBe('gpt-5.1')
  })
})

describe('preferences.json', () => {
  it('keeps valid defaults and discards unsupported model or reasoning choices', () => {
    expect(normalizePreferences({ defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high', defaultCoachModel: 'gpt-realtime' }))
      .toEqual({ defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high', defaultCoachModel: 'gpt-realtime' })
    expect(normalizePreferences({ defaultChatModel: 'gpt-4.1', defaultChatReasoning: 'high', defaultCoachModel: 'whisper-1' }))
      .toEqual({ defaultChatModel: 'gpt-4.1' })
    expect(normalizePreferences({ defaultChatModel: 42, defaultChatReasoning: 'unknown', defaultCoachModel: 'gpt-realtime-transcribe' }))
      .toEqual({})
  })

  it('falls back when the chosen model is disabled and never carries incompatible reasoning to an override', () => {
    const preferences = normalizePreferences({ chatModels: ['gpt-4.1'], defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high' })
    expect(newChatDefaults(preferences)).toEqual({ model: 'gpt-4.1', reasoning: null })
    expect(newChatDefaults({ defaultChatModel: 'gpt-5.1', defaultChatReasoning: 'high' }, 'gpt-4.1'))
      .toEqual({ model: 'gpt-4.1', reasoning: null })
  })
  it('keeps chat models, once each, and nothing that cannot chat', () => {
    expect(normalizePreferences({ chatModels: ['gpt-5.1', 'whisper-1', 'gpt-5.1', 42, 'gpt-5-mini'] })).toEqual({
      chatModels: ['gpt-5.1', 'gpt-5-mini']
    })
  })

  it('reads an empty choice, or a broken file, as no choice at all', () => {
    expect(normalizePreferences({ chatModels: [] })).toEqual({})
    expect(normalizePreferences({ chatModels: ['whisper-1'] })).toEqual({})
    expect(normalizePreferences({ chatModels: 'gpt-5.1' })).toEqual({})
    expect(normalizePreferences(null)).toEqual({})
    expect(normalizePreferences('nonsense')).toEqual({})
  })
})
