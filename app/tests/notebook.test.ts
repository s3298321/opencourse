// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { validateManifest } from '../src/core/schema'
import { identifyManifest, portableManifest } from '../src/core/course-document'
import { buildCourse } from '../src/core/manifest'
import { lessonContextText } from '../src/core/sidechat/context'
import { buildInput } from '../src/core/sidechat/thread'
import { declaresNotebook, notebookContextText } from '../src/core/notebook/context'
import { MAX_CELL_BYTES, type NotebookDocument, type CellExecution } from '../src/core/notebook/types'
import { initializeNotebook, readNotebook, recordCellExecution, saveNotebookCells } from '../src/main/notebook-store'
import { runCourseReadingTool } from '../src/main/course-reading'
import { searchCourse } from '../src/core/search'
import type { CourseManifest } from '../src/core/types'
const course = (): CourseManifest => ({ schema_version: '1.7', version: '0.1.0', slug: 'cells', title: 'Cells', modules: [{ slug: 'm', title: 'Module', lessons: [{ slug: 'l', title: 'Lesson', blocks: [{ type: 'python-cell', slug: 'code', content: 'x = 6 * 7\nx' }] }] }] })
const roots: string[] = []
const file = (): string => { const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-')); roots.push(root); return join(root, 'notebook.json') }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('Python course format', () => {
  it('gates new declarations and blocks at 1.7 while retaining older formats', () => {
    expect(validateManifest(course())).toEqual([])
    for (const schema_version of ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6']) {
      expect(validateManifest({ ...course(), schema_version }).join(' ')).toContain('1.7')
      const old = course(); old.schema_version = schema_version
      if (old.modules[0]!.type !== 'project') old.modules[0]!.lessons[0]!.blocks = [{ type: 'markdown', slug: 'text', content: 'text' }]
      expect(validateManifest(old)).toEqual([])
      expect(validateManifest({ ...old, notebook: {} }).join(' ')).toContain('1.7')
    }
  })
  it('rejects runtime and requirements fields, but accepts an empty notebook and empty cells', () => {
    expect(validateManifest({ ...course(), notebook: { cells: [{ content: '' }] } })).toEqual([])
    for (const field of ['runtime', 'requirements', 'packages']) {
      expect(validateManifest({ ...course(), notebook: { [field]: [] } }).length).toBeGreaterThan(0)
      const value = course(); if (value.modules[0]!.type !== 'project') Object.assign(value.modules[0]!.lessons[0]!.blocks[0]!, { [field]: [] })
      expect(validateManifest(value).length).toBeGreaterThan(0)
    }
    const copy = identifyManifest({ ...course(), notebook: { cells: [{ content: 'seed' }] } }, randomUUID)
    expect(copy.notebook!.cells![0]).toEqual({ content: 'seed' })
    expect(portableManifest(copy)).toEqual({ ...course(), notebook: { cells: [{ content: 'seed' }] } })
    expect(declaresNotebook(course())).toBe(true)
  })
  it('includes Python cells in lesson context and bounded course retrieval', () => {
    const manifest = course(), module = manifest.modules[0]!
    if (module.type === 'project') throw new Error('Expected lesson')
    expect(lessonContextText(manifest.title, module.title, module.lessons[0]!)).toContain('x = 6 * 7')
    const result = JSON.parse(runCourseReadingTool(buildCourse(manifest, '/unused'), 'search_course', { query: '6 * 7', cursor: 0 }, { chars: 0, signal: new AbortController().signal }, []))
    expect(result.hits).toHaveLength(1)
    expect(searchCourse(buildCourse(manifest, '/unused'), '6 * 7')).toHaveLength(1)
  })
  it('applies the source byte limit to Unicode code', () => {
    const value = course()
    if (value.modules[0]!.type !== 'project') {
      const cell = value.modules[0]!.lessons[0]!.blocks[0]!
      if (cell.type === 'python-cell') cell.content = '🌍'.repeat(300_000)
    }
    expect(validateManifest(value).join(' ')).toContain('1 MiB')
    expect(validateManifest({ ...course(), notebook: { cells: [{ content: '🌍'.repeat(300_000) }] } }).join(' ')).toContain('1 MiB')
  })
})
describe('persistent learner notebook', () => {
  it('seeds once and never restores deleted cells or applies updated defaults', () => {
    const path = file(), first = initializeNotebook(path, { cells: [{ content: 'seed' }] })
    expect(first.cells[0]!.content).toBe('seed')
    expect(saveNotebookCells(path, first.revision, [])).toMatchObject({ ok: true })
    expect(initializeNotebook(path, { cells: [{ content: 'new seed' }] }).cells).toEqual([])
    expect(initializeNotebook(file(), {}).cells).toHaveLength(1)
  })
  it('preserves code and outputs with optimistic revisions, and ignores renderer-supplied executions', () => {
    const path = file(), first = initializeNotebook(path), id = first.cells[0]!.id
    const execution: CellExecution = { runId: randomUUID(), generation: randomUUID(), count: 1, code: '1+1', status: 'complete', outputs: [{ kind: 'stdout', text: '2\n' }], at: new Date().toISOString() }
    const recorded = recordCellExecution(path, id, execution)
    expect(saveNotebookCells(path, 0, [{ id, content: 'stale' }])).toMatchObject({ ok: false })
    expect(saveNotebookCells(path, recorded.revision, [{ id, content: '3+3' }])).toMatchObject({ ok: true })
    expect(readNotebook(path).cells[0]).toMatchObject({ content: '3+3', execution })
    recordCellExecution(path, id)
    expect(readNotebook(path).cells[0]!.execution).toBeUndefined()
  })
  it('retains corrupt state and refuses oversized or duplicate cells', () => {
    const path = file(); writeFileSync(path, 'broken')
    expect(() => initializeNotebook(path)).toThrow('preserved')
    expect(readFileSync(path, 'utf8')).toBe('broken')
    const valid = file(), initial = initializeNotebook(valid), id = initial.cells[0]!.id
    expect(() => saveNotebookCells(valid, 0, [{ id, content: 'x'.repeat(MAX_CELL_BYTES + 1) }])).toThrow('1 MiB')
    expect(() => saveNotebookCells(valid, 0, [{ id, content: '' }, { id, content: '' }])).toThrow('duplicate')
  })
  it('does not recreate a deleted cell when a late result arrives', () => {
    const path = file(), initial = initializeNotebook(path)
    saveNotebookCells(path, initial.revision, [])
    expect(recordCellExecution(path, initial.cells[0]!.id).cells).toEqual([])
  })
  it('bounds notebook chat snapshots and labels notebook quotes accurately', () => {
    const document: NotebookDocument = { version: 1, revision: 0, cells: [{ id: randomUUID(), content: 'secret = 42' }] }
    const text = notebookContextText(course(), document)
    expect(text).toContain('secret = 42'); expect(text).toContain('cannot inspect live variables')
    expect(notebookContextText(course(), { ...document, cells: [{ id: randomUUID(), content: 'x'.repeat(100_000) }] }).length).toBeLessThanOrEqual(24_000)
    const input = buildInput([{ seq: 0, role: 'context', text, notebook: true, at: '' }, { seq: 1, role: 'user', text: 'Explain', notebook: true, quote: { from: 'notebook', text: 'secret = 42' }, at: '' }], 'system')
    expect(input[1]!.content).toContain('[notebook context]')
    expect(input[2]!.content).toContain('From the course notebook')
  })
})
