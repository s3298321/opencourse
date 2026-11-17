// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-notebook-sketch-'))
let directory = root
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
const { createUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
let n = 0
beforeEach(() => { closeDb(); directory = join(root, String(++n)); process.env['OPENCOURSE_RUN_PROFILE'] = directory; createUser('Writer') })
afterAll(() => { closeDb(); delete process.env['OPENCOURSE_RUN_PROFILE']; rmSync(root, { recursive: true, force: true }) })
const write = (id: string, text: string) => { const notebook = notes.getWritingNotebook(id), page = notes.getWritingPage(id, notebook.selectedPageId); return notes.saveWritingPage(id, page.id, page.revision, text) }
describe('notebook sketches', () => {
  it('saves immutable versions and prunes the ones no saved page references, once past the grace period', async () => {
    const { pruneNotebookSketches, readNotebookSketch, saveNotebookSketch } = await import('../src/main/writing-notebook-sketch')
    const { darkSketchColors } = await import('../src/core/writing-notebooks/sketch')
    const notebook = notes.createWritingNotebook('Pruning'), id = notebook.id
    pruneNotebookSketches(id) // No assets directory yet.
    const model = { version: 1, width: 450, height: 300, marks: [{ kind: 'brush', width: 2, points: [[10, 10], [100, 100]] }] }
    const asset = () => `assets/${crypto.randomUUID()}.sketch.svg`
    const kept = asset(), dropped = asset(), fresh = asset(), otherPage = asset()
    for (const ref of [kept, dropped, fresh, otherPage]) saveNotebookSketch(id, ref, model, darkSketchColors)
    expect(readNotebookSketch(id, kept)).toEqual(model)
    expect(() => saveNotebookSketch(id, kept, { ...model, width: 400 }, darkSketchColors)).toThrow('already exists')
    write(id, `![Sketch](${kept})`)
    const second = notes.addWritingPage(id, 'Second')
    expect(notes.saveWritingPage(id, second.selectedPageId, 0, `![Sketch](${otherPage})`).ok).toBe(true)
    const assets = join(notes.writingNotebookDirectory(id), 'assets')
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const age = (name: string) => utimesSync(join(assets, name), aged, aged)
    age(kept.slice(7)); age(dropped.slice(7)); age(otherPage.slice(7))
    const temp = `${dropped.slice(7)}.${crypto.randomUUID()}.tmp`
    writeFileSync(join(assets, temp), 'partial write'); age(temp)
    const photo = `${crypto.randomUUID()}.png`
    writeFileSync(join(assets, photo), Buffer.from([137, 80, 78, 71])); age(photo)
    pruneNotebookSketches(id)
    expect(existsSync(join(assets, kept.slice(7)))).toBe(true) // Referenced by the first page.
    expect(existsSync(join(assets, otherPage.slice(7)))).toBe(true) // Referenced by another page.
    expect(existsSync(join(assets, fresh.slice(7)))).toBe(true) // Unreferenced, but inside the grace period.
    expect(existsSync(join(assets, photo))).toBe(true) // Not a sketch.
    expect(existsSync(join(assets, dropped.slice(7)))).toBe(false)
    expect(existsSync(join(assets, temp))).toBe(false)
  })
})