/**
 * The tool schemas the coach is given, and the parser that sits between what it
 * asked for and what main does. Everything here runs before the filesystem is
 * touched, which is the point: a bad call should cost a message, not a write.
 */
import { describe, expect, it } from 'vitest'
import { COACH_TOOLS, MAX_QUERY_LENGTH, TOOL_NAMES, parseToolCall, toolsFor } from '@core/coach/tools'
import { buildInstructions, MAX_PROMPT_LENGTH, WRAPUP_FORCED_TEXT, WRAPUP_TEXT } from '@core/coach/prompt'
import { DEFAULT_INSTRUCTIONS } from '@core/coach/projects'
import type { CoachFileNode } from '@core/types'

const project = { name: 'French vocabulary', instructions: DEFAULT_INSTRUCTIONS, allowDelete: false }

const file = (path: string, bytes = 100): CoachFileNode => ({
  name: path.split('/').at(-1) as string,
  path,
  kind: 'text',
  bytes,
  modifiedAt: '2026-09-14T10:00:00.000Z'
})

describe('the tools a coach is given', () => {
  it('describes every one in the shape the Realtime API takes', () => {
    for (const tool of COACH_TOOLS) {
      expect(tool.type).toBe('function')
      expect(tool.name).toMatch(/^[a-z_]+$/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.additionalProperties).toBe(false)
      for (const required of tool.parameters.required) {
        expect(Object.keys(tool.parameters.properties)).toContain(required)
      }
    }
  })

  it('withholds delete unless the project turns it on', () => {
    expect(toolsFor({ allowDelete: false }).map((tool) => tool.name)).not.toContain('delete_file')
    expect(toolsFor({ allowDelete: true }).map((tool) => tool.name)).toContain('delete_file')
  })

  it('always offers the tools the memory protocol depends on', () => {
    const names = toolsFor({ allowDelete: false }).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['write_file', 'append_file', 'read_file', 'list_files', 'web_search']))
  })

  it('tells the model the filename rule where it will actually read it', () => {
    const write = COACH_TOOLS.find((tool) => tool.name === 'write_file')
    const path = write?.parameters.properties['path'] as { description: string }
    expect(path.description).toMatch(/no accents/i)
    expect(path.description).toMatch(/no spaces/i)
  })
})

describe('parsing what the model sent', () => {
  it('reads a well-formed write', () => {
    expect(parseToolCall('write_file', '{"path":"learned.md","content":"- le chien"}')).toEqual({
      name: 'write_file',
      path: 'learned.md',
      content: '- le chien'
    })
  })

  it('accepts an empty body for a tool that takes no arguments', () => {
    expect(parseToolCall('list_files', '')).toEqual({ name: 'list_files' })
    expect(parseToolCall('list_files', '{}')).toEqual({ name: 'list_files' })
  })

  it('accepts empty content, which is a legitimate way to blank a file', () => {
    expect(parseToolCall('write_file', '{"path":"review.md","content":""}')).toEqual({
      name: 'write_file',
      path: 'review.md',
      content: ''
    })
  })

  const refusals: readonly (readonly [string, string, string, RegExp])[] = [
    ['truncated JSON', 'write_file', '{"path":"a.m', /valid JSON/],
    ['an array instead of an object', 'write_file', '[]', /JSON object/],
    ['a bare string', 'write_file', '"learned.md"', /JSON object/],
    ['a missing path', 'write_file', '{"content":"x"}', /path/],
    ['a non-string path', 'write_file', '{"path":5,"content":"x"}', /path/],
    ['missing content', 'write_file', '{"path":"a.md"}', /content/],
    ['non-string content', 'append_file', '{"path":"a.md","content":{"a":1}}', /content/],
    ['a missing query', 'web_search', '{}', /query/],
    ['a blank query', 'web_search', '{"query":"   "}', /query/],
    ['a tool that does not exist', 'rm_rf', '{}', /no tool called/]
  ]

  for (const [what, name, args, expected] of refusals) {
    it(`refuses ${what}, with something the model can act on`, () => {
      const result = parseToolCall(name, args)
      expect('error' in result).toBe(true)
      expect('error' in result && result.error).toMatch(expected)
    })
  }

  it('refuses a query long enough to be a mistake', () => {
    const result = parseToolCall('web_search', JSON.stringify({ query: 'x'.repeat(MAX_QUERY_LENGTH + 1) }))
    expect('error' in result && result.error).toMatch(/too long/)
  })

  it('does not decide what a path means - that is main’s job', () => {
    // The parser's contract is shape only. Containment is checked where the
    // filesystem is, so there is one place to get it right rather than two.
    expect(parseToolCall('write_file', '{"path":"../../users.json","content":"x"}')).toEqual({
      name: 'write_file',
      path: '../../users.json',
      content: 'x'
    })
  })

  it('reads an optional recency window, and ignores a nonsensical one', () => {
    expect(parseToolCall('web_search', '{"query":"news","recency_days":7}')).toEqual({
      name: 'web_search',
      query: 'news',
      recencyDays: 7
    })
    expect(parseToolCall('web_search', '{"query":"news","recency_days":-3}')).toEqual({
      name: 'web_search',
      query: 'news'
    })
    expect(parseToolCall('web_search', '{"query":"news","recency_days":"soon"}')).toEqual({
      name: 'web_search',
      query: 'news'
    })
  })

  it('parses every tool it advertises', () => {
    const args: Record<string, string> = {
      write_file: '{"path":"a.md","content":"x"}',
      append_file: '{"path":"a.md","content":"x"}',
      read_file: '{"path":"a.md"}',
      delete_file: '{"path":"a.md"}',
      list_files: '{}',
      web_search: '{"query":"x"}'
    }
    for (const name of TOOL_NAMES) {
      expect('error' in parseToolCall(name, args[name] as string)).toBe(false)
    }
  })
})

describe('the prompt a session starts with', () => {
  it('names the project and keeps the brief the user wrote', () => {
    const prompt = buildInstructions({ ...project, instructions: 'Drill me on irregular verbs.' }, [])
    expect(prompt).toContain('French vocabulary')
    expect(prompt).toContain('Drill me on irregular verbs.')
  })

  it('states the filename rule, which is the one that bites first', () => {
    const prompt = buildInstructions(project, [])
    expect(prompt).toMatch(/no spaces and no accents/i)
    expect(prompt).toContain('mots-a-reviser.md')
  })

  it('lists the files that already exist, so it picks up rather than starts over', () => {
    const prompt = buildInstructions(project, [file('learned.md'), file('weeks/week-01.md')])
    expect(prompt).toContain('learned.md')
    expect(prompt).toContain('weeks/week-01.md')
    expect(prompt).toMatch(/read the ones that matter/i)
  })

  it('says so plainly when the workspace is empty', () => {
    const prompt = buildInstructions(project, [])
    expect(prompt).toMatch(/workspace is empty/i)
    expect(prompt).toMatch(/context\.md/)
  })

  it('tells it not to delete when it cannot', () => {
    expect(buildInstructions(project, [])).toMatch(/cannot delete files/i)
    expect(buildInstructions({ ...project, allowDelete: true }, [])).toMatch(/moves a file to the trash/i)
  })

  it('is deterministic, so two sessions of one project are comparable', () => {
    const tree = [file('learned.md'), file('review.md')]
    expect(buildInstructions(project, tree)).toBe(buildInstructions(project, tree))
  })

  it('stays under the cap even when the brief is enormous, and keeps the rules', () => {
    const prompt = buildInstructions({ ...project, instructions: 'verbs. '.repeat(4000) }, [file('learned.md')])
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH)
    // The rules are what keep the tools usable, so they are never what is cut.
    expect(prompt).toMatch(/no spaces and no accents/i)
    expect(prompt).toContain('learned.md')
  })

  it('does not list every file when there are hundreds of them', () => {
    const many = Array.from({ length: 200 }, (_, n) => file(`note-${n}.md`))
    const prompt = buildInstructions(project, many)
    expect(prompt).toMatch(/and \d+ more/)
    expect(prompt).toContain('list_files')
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH)
  })

  it('leaves the trash out of what it tells the coach about', () => {
    const prompt = buildInstructions(project, [
      file('learned.md'),
      { name: 'trash', path: 'trash', kind: 'dir', bytes: 0, modifiedAt: '', children: [file('trash/old.md')] }
    ])
    expect(prompt).not.toContain('trash/old.md')
  })
})

describe('the wrap-up', () => {
  it('asks for files and not for words', () => {
    expect(WRAPUP_TEXT).toMatch(/do not reply out loud/i)
    expect(WRAPUP_TEXT).toMatch(/file tools/i)
    expect(WRAPUP_FORCED_TEXT).toMatch(/write_file|append_file/)
    expect(WRAPUP_FORCED_TEXT).toMatch(/not reply with words/i)
  })
})
