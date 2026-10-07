// @vitest-environment node
/** Opt-in real Responses function calling: OPENCOURSE_TEST_OPENAI=1 OPENAI_API_KEY=… */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProjectAgent } from '../src/core/projects/agent'
import { PROJECT_TOOLS } from '../src/core/projects/tools'
import { runProjectFileTool } from '../src/main/projectfiles'
import { DEFAULT_CHAT_MODEL, reasoningEffortsFor } from '../src/core/sidechat/models'
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) } }))
const { streamChat, listChatModels } = await import('../src/main/openai')
const key = process.env['OPENAI_API_KEY'] ?? ''
describe.skipIf(!process.env['OPENCOURSE_TEST_OPENAI'] || !key)('project file review with the real OpenAI API', () => {
  it('reads a live project file and continues the response on selectable models', async () => {
    const available = await listChatModels(key)
    expect(available.source).toBe('api')
    expect(available.models.some(m => m.id === DEFAULT_CHAT_MODEL)).toBe(true)
    const alternative = available.models.find(m => m.id !== DEFAULT_CHAT_MODEL && reasoningEffortsFor(m.id).length)
    const models = [DEFAULT_CHAT_MODEL, ...(alternative ? [alternative.id] : [])]
    const namespace = mkdtempSync(join(tmpdir(), 'opencourse-project-live-'))
    const root = join(namespace, 'course', 'project'); mkdirSync(root, { recursive: true })
    // Only the file tool knows this value: a correct answer requires a live read.
    const phrase = `project-evidence-${Date.now()}`
    writeFileSync(join(root, 'artifact.txt'), phrase)
    try {
      for (const model of models) {
        let answer = ''
        const calls: string[] = []
        const budget = { bytes: 0 }
        const result = await runProjectAgent({
          signal: new AbortController().signal,
          input: [{ role: 'system', content: 'You review project deliverables using read-only file tools. Read artifact.txt using read_project_file, then reply with its exact contents. Do not guess.' }, { role: 'user', content: 'Review the artifact deliverable now.' }],
          stream: input => streamChat({ key, model, input, tools: PROJECT_TOOLS, onDelta: chunk => { answer += chunk } }),
          tool: async (name, args) => {
            calls.push(name)
            return runProjectFileTool({ root, namespace }, name, args, budget)
          }
        })
        expect(result.stopped).toBe(false)
        expect(calls).toContain('read_project_file')
        expect(answer).toContain(phrase)
      }
    } finally { rmSync(namespace, { recursive: true, force: true }) }
  }, 180_000)
})
