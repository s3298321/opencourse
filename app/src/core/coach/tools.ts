/**
 * The tools the coach is given, and the parser that stands between what it
 * asked for and what main will do.
 *
 * Pure, and deliberately strict. Every argument is validated here, before main
 * touches the filesystem - so a malformed call is a message the model can read
 * and retry from, not an exception that ends the conversation.
 */
import type { CoachProject } from '../types'
import { WRITABLE_EXTENSIONS } from './files'

/** A function tool as the Realtime API's `session.update` wants it. */
export interface RealtimeTool {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

export const MAX_TOOL_CALLS_PER_SESSION = 60
export const MAX_WEB_SEARCHES_PER_SESSION = 20
export const MAX_QUERY_LENGTH = 400

export type ParsedToolCall =
  | { name: 'write_file'; path: string; content: string }
  | { name: 'append_file'; path: string; content: string }
  | { name: 'read_file'; path: string }
  | { name: 'list_files' }
  | { name: 'delete_file'; path: string }
  | { name: 'web_search'; query: string; recencyDays?: number }

const pathArg = {
  type: 'string',
  description:
    'Path inside your workspace, like "learned.md" or "weeks/week-01.md". ASCII only: letters, digits, ' +
    'dot, dash and underscore. No spaces, no accents, no leading dot.'
}

const FILE_TOOLS: RealtimeTool[] = [
  {
    type: 'function',
    name: 'write_file',
    description:
      'Create a file in your workspace, or replace one entirely. Use this for a file you are rewriting; ' +
      'use append_file to add to one.',
    parameters: {
      type: 'object',
      properties: {
        path: pathArg,
        content: { type: 'string', description: `The whole file. Allowed types: ${WRITABLE_EXTENSIONS.join(' ')}.` }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'append_file',
    description:
      'Add to the end of a file, creating it if it does not exist. Prefer this when adding to a list you ' +
      'are keeping, so you do not have to read and rewrite the whole thing.',
    parameters: {
      type: 'object',
      properties: { path: pathArg, content: { type: 'string', description: 'The text to add.' } },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a file from your workspace. Read your notes at the start of a session.',
    parameters: { type: 'object', properties: { path: pathArg }, required: ['path'], additionalProperties: false }
  },
  {
    type: 'function',
    name: 'list_files',
    description: 'List everything in your workspace, with sizes and when each was last changed.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
  }
]

const DELETE_TOOL: RealtimeTool = {
  type: 'function',
  name: 'delete_file',
  description: 'Move a file in your workspace to the trash. The learner can still recover it.',
  parameters: { type: 'object', properties: { path: pathArg }, required: ['path'], additionalProperties: false }
}

const WEB_SEARCH_TOOL: RealtimeTool = {
  type: 'function',
  name: 'web_search',
  description:
    'Search the web and get a short written answer with sources. Use it when you need a fact you are not ' +
    'sure of, or something recent. Keep talking while you wait.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look up, in plain words.' },
      recency_days: {
        type: 'number',
        description: 'Only consider results from the last N days. Omit unless recency matters.'
      }
    },
    required: ['query'],
    additionalProperties: false
  }
}

/**
 * What this project's coach can do. `delete_file` is absent unless the project
 * turns it on - the requirement is that the *user* can delete, not the model.
 */
export function toolsFor(project: Pick<CoachProject, 'allowDelete'>): RealtimeTool[] {
  return [...FILE_TOOLS, ...(project.allowDelete ? [DELETE_TOOL] : []), WEB_SEARCH_TOOL]
}

/** Every tool that exists, for tests and for the prompt's own description. */
export const COACH_TOOLS: readonly RealtimeTool[] = [...FILE_TOOLS, DELETE_TOOL, WEB_SEARCH_TOOL]

export const TOOL_NAMES: readonly string[] = COACH_TOOLS.map((tool) => tool.name)

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Turns `(name, raw JSON)` into something main can act on, or into an error
 * written for the model.
 *
 * The Realtime API sends arguments as a JSON *string* assembled from deltas, so
 * a truncated or empty one is a normal thing to see, not a bug.
 */
export function parseToolCall(name: string, rawArgs: string): ParsedToolCall | { error: string } {
  let args: Record<string, unknown>
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'arguments must be a JSON object' }
    }
    args = parsed as Record<string, unknown>
  } catch {
    return { error: 'arguments were not valid JSON; send them again' }
  }

  switch (name) {
    case 'write_file':
    case 'append_file': {
      const path = str(args['path'])
      const content = str(args['content'])
      if (!path) return { error: 'missing "path"' }
      if (content === null) return { error: 'missing "content", which must be a string' }
      return { name, path, content }
    }
    case 'read_file':
    case 'delete_file': {
      const path = str(args['path'])
      if (!path) return { error: 'missing "path"' }
      return { name, path }
    }
    case 'list_files':
      return { name: 'list_files' }
    case 'web_search': {
      const query = str(args['query'])?.trim()
      if (!query) return { error: 'missing "query"' }
      if (query.length > MAX_QUERY_LENGTH) return { error: `the query is too long; keep it under ${MAX_QUERY_LENGTH} characters` }
      const recency = args['recency_days']
      const recencyDays =
        typeof recency === 'number' && Number.isFinite(recency) && recency > 0 ? Math.floor(recency) : undefined
      return { name: 'web_search', query, ...(recencyDays === undefined ? {} : { recencyDays }) }
    }
    default:
      return { error: `there is no tool called "${name}"` }
  }
}
