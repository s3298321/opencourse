/**
 * Running a coach's tool call.
 *
 * The one rule that shapes this whole file: **the project is derived from the
 * session row, never from an argument.** The renderer hands over a session id
 * and whatever the model said; main looks up which project that session belongs
 * to and which user owns it. A compromised renderer cannot aim a write at
 * another project, let alone another user - the same structural containment
 * workspace.ts gets from manifest ids.
 *
 * The second rule: every refusal comes back as a *result*, not an exception.
 * The caller is a language model. An error it can read is an error it can
 * recover from; one that rejects the IPC call just stops the conversation.
 */
import { describeTree } from '../core/coach/files'
import { parseToolCall, type ParsedToolCall } from '../core/coach/tools'
import { readKey } from './coachkey'
import { listFiles, readTextFile, trashFile, writeWorkspaceFile } from './coachfiles'
import { requireProject } from './coach'
import { selectSessionRow } from './coachdb'
import { webSearch } from './openai'

export interface CoachToolResult {
  ok: boolean
  /** What goes back to the model as the function_call_output. */
  output: string
  /** One line for the activity strip, written for a person. */
  summary: string
}

function refuse(message: string, summary: string): CoachToolResult {
  return { ok: false, output: JSON.stringify({ ok: false, error: message }), summary }
}

function succeed(payload: Record<string, unknown>, summary: string): CoachToolResult {
  return { ok: true, output: JSON.stringify({ ok: true, ...payload }), summary }
}

/** Which project this session is for. The renderer does not get a say. */
function projectOf(sessionId: string): string {
  const row = selectSessionRow(sessionId)
  if (!row) throw new Error('that session does not exist')
  return row.project_id
}

async function execute(projectId: string, call: ParsedToolCall): Promise<CoachToolResult> {
  switch (call.name) {
    case 'write_file':
    case 'append_file': {
      const mode = call.name === 'append_file' ? 'append' : 'write'
      const result = writeWorkspaceFile(projectId, call.path, call.content, mode)
      if (!result.ok) return refuse(result.error, `could not write ${call.path}`)
      return succeed({ path: call.path, bytes: result.bytes }, `wrote ${call.path}`)
    }

    case 'read_file': {
      try {
        const file = readTextFile(projectId, call.path)
        return succeed({ path: call.path, content: file.content, truncated: file.truncated }, `read ${call.path}`)
      } catch {
        // Not there, or not a file. Either way the model should list and retry.
        return refuse(`cannot read "${call.path}" - it may not exist. Use list_files to see what does.`, `could not read ${call.path}`)
      }
    }

    case 'list_files': {
      const files = describeTree(listFiles(projectId))
      return succeed({ files }, `listed ${files.length} file${files.length === 1 ? '' : 's'}`)
    }

    case 'delete_file': {
      // The tool is not offered unless the project allows it, but a model can
      // call a tool it was never given.
      if (!requireProject(projectId).allowDelete) {
        return refuse('you cannot delete files in this project', 'refused a delete')
      }
      const result = trashFile(projectId, call.path)
      if (result.status === 'ok') return succeed({ path: call.path }, `moved ${call.path} to the trash`)
      if (result.status === 'missing') return refuse(`"${call.path}" is not there`, `could not delete ${call.path}`)
      return refuse(result.status === 'invalid' ? result.message : 'that could not be deleted', `could not delete ${call.path}`)
    }

    case 'web_search': {
      const key = readKey()
      if (!key) return refuse('web search is unavailable right now', 'search unavailable')
      try {
        const found = await webSearch(key, call.query, call.recencyDays === undefined ? {} : { recencyDays: call.recencyDays })
        return succeed({ answer: found.answer, citations: found.citations }, `searched for “${call.query}”`)
      } catch (err) {
        // Already scrubbed of anything key-shaped by openai.ts.
        return refuse(`the search failed: ${(err as Error).message}`, 'search failed')
      }
    }
  }
}

/**
 * The entry point the IPC handler calls.
 *
 * `caps` is checked here rather than in the renderer: a runaway model should
 * stop costing money even if the window has stopped counting.
 */
export async function runCoachTool(
  sessionId: string,
  name: string,
  rawArgs: string,
  caps: { toolCalls: number; searches: number; maxToolCalls: number; maxSearches: number }
): Promise<CoachToolResult> {
  const parsed = parseToolCall(name, rawArgs)
  if ('error' in parsed) return refuse(parsed.error, `could not run ${name}`)

  if (caps.toolCalls >= caps.maxToolCalls) {
    return refuse('you have used all the tool calls this session allows; finish in conversation', 'tool limit reached')
  }
  if (parsed.name === 'web_search' && caps.searches >= caps.maxSearches) {
    return refuse('you have used all the web searches this session allows', 'search limit reached')
  }

  try {
    return await execute(projectOf(sessionId), parsed)
  } catch (err) {
    return refuse((err as Error).message, `could not run ${name}`)
  }
}
