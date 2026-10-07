// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProjectFileTool } from '../src/main/projectfiles'
import { MAX_PROJECT_FILE_BYTES, MAX_PROJECT_TURN_BYTES } from '../src/core/projects/tools'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const namespace = mkdtempSync(join(tmpdir(), 'opencourse-project-files-')); roots.push(namespace)
  const root = join(namespace, 'course', 'project'); mkdirSync(root, { recursive: true })
  return { root, namespace }
}
async function tool(scope: ReturnType<typeof fixture>, name: string, args: unknown, budget = { bytes: 0 }) {
  return JSON.parse(await runProjectFileTool(scope, name, args, budget))
}
const read = (path: string) => ({ path, start_line: 1, max_lines: 100 })
describe('contained project reads', () => {
  it('reads Unicode/space filenames with line evidence and searches TSX and extensionless text', async () => {
    const scope = fixture()
    writeFileSync(join(scope.root, 'résumé file.tsx'), 'const summary = "hello";\nexport default summary;\n')
    writeFileSync(join(scope.root, 'LICENSE'), 'hello world')
    expect(await tool(scope, 'read_project_file', read('résumé file.tsx'))).toMatchObject({ ok: true, text: '1: const summary = "hello";\n2: export default summary;\n3: ', truncated: false })
    const found = await tool(scope, 'search_project_files', { path: '', query: 'hello', cursor: null })
    expect(found.matches.map((m: { path: string }) => m.path)).toEqual(['LICENSE', 'résumé file.tsx'])
  })
  it('rejects absolute/traversing paths, symlinks and excluded secrets for every tool', async () => {
    const scope = fixture()
    const outside = join(scope.namespace, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'SENSITIVE')
    symlinkSync(outside, join(scope.root, 'linked-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(scope.root, 'linked.txt'))
    writeFileSync(join(scope.root, '.env'), 'TOKEN=SENSITIVE')
    mkdirSync(join(scope.root, 'node_modules')); writeFileSync(join(scope.root, 'node_modules', 'hidden.txt'), 'SENSITIVE')
    for (const path of ['/etc/passwd', '../outside/secret.txt', 'a/../../x', 'linked.txt', 'linked-dir/secret.txt', '.env', 'node_modules/hidden.txt', 'a\0b', 'a\\b']) {
      expect(await tool(scope, 'read_project_file', read(path)), path).toMatchObject({ ok: false })
    }
    expect(await tool(scope, 'search_project_files', { path: '../outside', query: 'SENSITIVE', cursor: null })).toMatchObject({ ok: false })
    const listing = await tool(scope, 'list_project_files', { path: '', cursor: null })
    expect(listing.entries).toEqual([])
    const search = await tool(scope, 'search_project_files', { path: '', query: 'SENSITIVE', cursor: null })
    expect(search.matches).toEqual([])
    expect(await tool(scope, 'list_project_files', { path: 'linked-dir', cursor: null })).toMatchObject({ ok: false })
  })
  it('refuses symlinked root and ancestor directories', async () => {
    const scope = fixture()
    const other = join(scope.namespace, 'other'); mkdirSync(other); writeFileSync(join(other, 'file.txt'), 'outside')
    rmSync(scope.root, { recursive: true }); symlinkSync(other, scope.root)
    expect(await tool(scope, 'read_project_file', read('file.txt'))).toMatchObject({ ok: false })
    rmSync(scope.root); rmSync(join(scope.namespace, 'course'), { recursive: true }); symlinkSync(other, join(scope.namespace, 'course'))
    mkdirSync(join(other, 'project')); writeFileSync(join(other, 'project', 'file.txt'), 'outside')
    expect(await tool(scope, 'read_project_file', read('file.txt'))).toMatchObject({ ok: false })
  })
  it('rejects directories/binary/invalid encoding and rejects unexpected tools or arguments', async () => {
    const scope = fixture()
    writeFileSync(join(scope.root, 'picture.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(scope.root, 'bad.txt'), Buffer.from([0xff, 0xfe]))
    mkdirSync(join(scope.root, 'folder'))
    for (const path of ['picture.png', 'bad.txt', 'folder']) expect(await tool(scope, 'read_project_file', read(path))).toMatchObject({ ok: false })
    expect(await tool(scope, 'write_file', { path: 'new.txt', content: 'bad' })).toMatchObject({ ok: false })
    expect(await tool(scope, 'read_project_file', { ...read('bad.txt'), root: '/etc' })).toMatchObject({ ok: false })
  })
  it('caps bytes actually read and reports truncation, pagination and cancellation', async () => {
    const scope = fixture()
    writeFileSync(join(scope.root, 'large.txt'), 'content\n'.repeat(50000))
    const budget = { bytes: 0 }
    const result = await tool(scope, 'read_project_file', read('large.txt'), budget)
    expect(result.truncated).toBe(true)
    expect(budget.bytes).toBe(MAX_PROJECT_FILE_BYTES)
    expect(await tool(scope, 'read_project_file', read('large.txt'), { bytes: MAX_PROJECT_TURN_BYTES })).toMatchObject({ ok: false })
    for (let n = 0; n < 210; n++) writeFileSync(join(scope.root, `file-${n}.txt`), 'hello')
    const page = await tool(scope, 'list_project_files', { path: '', cursor: null })
    expect(page.entries).toHaveLength(200); expect(page.nextCursor).toBe(200)
    const next = await tool(scope, 'list_project_files', { path: '', cursor: page.nextCursor })
    expect(next.entries).toHaveLength(11); expect(next.nextCursor).toBeNull()
    const controller = new AbortController(); controller.abort()
    expect(JSON.parse(await runProjectFileTool(scope, 'read_project_file', read('large.txt'), { bytes: 0, signal: controller.signal }))).toMatchObject({ ok: false, error: 'Project review stopped.' })
  })
  it('detects replacement while a file is being read and never returns its contents', async () => {
    const scope = fixture()
    writeFileSync(join(scope.root, 'racing.txt'), 'safe\n'.repeat(14000))
    const result = runProjectFileTool(scope, 'read_project_file', read('racing.txt'), { bytes: 0 })
    rmSync(join(scope.root, 'racing.txt'))
    const outside = join(scope.namespace, 'outside.txt'); writeFileSync(outside, 'SENSITIVE')
    symlinkSync(outside, join(scope.root, 'racing.txt'))
    const returned = await result
    expect(JSON.parse(returned).ok).toBe(false)
    expect(returned).not.toContain('SENSITIVE')
  })
})
