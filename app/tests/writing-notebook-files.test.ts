// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
const root = mkdtempSync(join(tmpdir(), 'opencourse-writing-files-'))
let directory = root
vi.mock('electron', () => ({ app: { getPath: () => directory, getAppPath: () => root, isPackaged: false, on: () => {} } }))
vi.mock('../src/main/courses', () => ({ getCourse: () => null }))
vi.mock('../src/main/documents', () => ({ getDocument: () => { throw new Error('Unavailable') } }))
vi.mock('../src/main/coach', () => ({ getProject: () => null }))
const { createUser } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const notes = await import('../src/main/writing-notebooks')
const tree = await import('../src/main/writing-notebook-tree')
const files = await import('../src/core/writing-notebooks/files')
const { MAX_WRITING_TEXT_BYTES } = await import('../src/core/writing-notebooks/types')
let n = 0
beforeEach(() => { closeDb(); directory = join(root, String(++n)); process.env['OPENCOURSE_RUN_PROFILE'] = directory; createUser('Writer') })
afterAll(() => { closeDb(); delete process.env['OPENCOURSE_RUN_PROFILE']; rmSync(root, { recursive: true, force: true }) })
const pages = (id: string) => join(notes.writingNotebookDirectory(id), 'pages')

describe('file classification (pure)', () => {
  it('sorts names into image, video, or try-as-text', () => {
    expect(files.mediaKind('photo.PNG')).toBe('image')
    expect(files.mediaKind('icon.svg')).toBe('image')
    expect(files.mediaKind('clip.MP4')).toBe('video')
    expect(files.mediaKind('movie.mov')).toBe('video')
    expect(files.mediaKind('notes.txt')).toBeNull()
    expect(files.mediaKind('data.bin')).toBeNull()
    expect(files.mediaKind('no-extension')).toBeNull()
  })
  it('maps extensions to editor mode keys', () => {
    expect(files.codeLanguageForFile('main.c')).toBe('c')
    expect(files.codeLanguageForFile('header.h')).toBe('c')
    expect(files.codeLanguageForFile('main.cpp')).toBe('cpp')
    expect(files.codeLanguageForFile('script.py')).toBe('python')
    expect(files.codeLanguageForFile('app.js')).toBe('javascript')
    expect(files.codeLanguageForFile('app.ts')).toBe('typescript')
    expect(files.codeLanguageForFile('view.tsx')).toBe('tsx')
    expect(files.codeLanguageForFile('view.jsx')).toBe('jsx')
    expect(files.codeLanguageForFile('data.json')).toBe('javascript')
    expect(files.codeLanguageForFile('page.html')).toBe('html')
    expect(files.codeLanguageForFile('site.CSS')).toBe('css')
    expect(files.codeLanguageForFile('README.md')).toBe('markdown')
    expect(files.codeLanguageForFile('notes.txt')).toBe('')
    expect(files.codeLanguageForFile('Makefile')).toBe('')
  })
  it('sniffs binary by NUL byte and refuses non-UTF-8', () => {
    expect(files.looksBinary(new TextEncoder().encode('plain text'))).toBe(false)
    expect(files.looksBinary(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true)
    // Only the first 8 KiB are sniffed.
    const late = new Uint8Array(9000).fill(0x61); late[8500] = 0
    expect(files.looksBinary(late)).toBe(false)
    expect(files.decodableAsUtf8(new TextEncoder().encode('héllo ✓'))).toBe(true)
    expect(files.decodableAsUtf8(new Uint8Array([0x63, 0x61, 0xe9, 0x66]))).toBe(false)
    expect(files.decodableAsUtf8(new Uint8Array([0x00]))).toBe(true) // NUL is valid UTF-8; looksBinary catches it
  })
  it('builds the asset-protocol URL with each path segment encoded', () => {
    const id = crypto.randomUUID()
    expect(files.writingTreeFileUrl(id, 'Research/my photo.png')).toBe(`opencourse://writing-notebooks/${id}/pages/Research/my%20photo.png`)
    expect(files.writingTreeFileUrl(id, 'a/b+c/d.mp4')).toBe(`opencourse://writing-notebooks/${id}/pages/a/b%2Bc/d.mp4`)
  })
})

describe('notebook file reading and saving (main)', () => {
  it('reads text files and refuses binary, invalid UTF-8, oversized, pages and unsafe paths', () => {
    const notebook = notes.createWritingNotebook('Files')
    const dir = pages(notebook.id)
    writeFileSync(join(dir, 'notes.txt'), 'hello notebook')
    writeFileSync(join(dir, 'data.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x03]))
    writeFileSync(join(dir, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(MAX_WRITING_TEXT_BYTES + 1))
    expect(notes.readWritingFile(notebook.id, 'notes.txt')).toEqual({ kind: 'text', text: 'hello notebook', bytes: 14 })
    expect(notes.readWritingFile(notebook.id, 'data.bin')).toEqual({ kind: 'binary', bytes: 4 })
    expect(notes.readWritingFile(notebook.id, 'latin.txt')).toEqual({ kind: 'binary', bytes: 4 })
    expect(notes.readWritingFile(notebook.id, 'big.txt')).toEqual({ kind: 'large', bytes: MAX_WRITING_TEXT_BYTES + 1 })
    expect(() => notes.readWritingFile(notebook.id, notebook.pages[0]!.path)).toThrow('page editor')
    expect(() => notes.readWritingFile(notebook.id, '../notebook.json')).toThrow()
    expect(() => notes.readWritingFile(notebook.id, '')).toThrow('not a file')
    expect(() => notes.readWritingFile(notebook.id, 'gone.txt')).toThrow('no longer exists')
    // A symlink inside the tree is refused even when addressed directly.
    symlinkSync(join(dir, 'notes.txt'), join(dir, 'alias.txt'))
    expect(() => notes.readWritingFile(notebook.id, 'alias.txt')).toThrow('Symbolic links')
  })
  it('saves edited text back atomically and refuses pages, oversized text and missing files', () => {
    const notebook = notes.createWritingNotebook('Editing')
    const dir = pages(notebook.id)
    writeFileSync(join(dir, 'code.c'), 'int main() { return 0; }\n')
    const saved = notes.saveWritingFile(notebook.id, 'code.c', 'int main() { return 1; }\n')
    expect(readFileSync(join(dir, 'code.c'), 'utf8')).toBe('int main() { return 1; }\n')
    expect(notes.readWritingFile(notebook.id, 'code.c')).toEqual({ kind: 'text', text: 'int main() { return 1; }\n', bytes: 25 })
    // The tree still shows the file after a save.
    expect(saved.tree?.some(node => node.kind === 'file' && node.name === 'code.c')).toBe(true)
    // No stray temp files leak into the tree scan.
    expect(saved.tree?.some(node => node.kind === 'file' && node.name.includes('.tmp'))).toBe(false)
    expect(() => notes.saveWritingFile(notebook.id, notebook.pages[0]!.path, '{}')).toThrow('page editor')
    expect(() => notes.saveWritingFile(notebook.id, 'code.c', 'x'.repeat(MAX_WRITING_TEXT_BYTES + 1))).toThrow('MiB')
    expect(() => notes.saveWritingFile(notebook.id, 'gone.txt', 'x')).toThrow('no longer exists')
    expect(() => notes.saveWritingFile(notebook.id, '../../etc/passwd', 'x')).toThrow()
    // Unicode round-trips exactly.
    notes.saveWritingFile(notebook.id, 'code.c', 'const s = "héllo ✓";\n')
    expect(readFileSync(join(dir, 'code.c'), 'utf8')).toBe('const s = "héllo ✓";\n')
  })
  it('resolves tree files for the asset protocol and refuses everything else', () => {
    const notebook = notes.createWritingNotebook('Protocol')
    const dir = pages(notebook.id)
    notes.createWritingFolder(notebook.id, '', 'Media')
    writeFileSync(join(dir, 'Media', 'shot.png'), 'png bytes')
    writeFileSync(join(dir, 'notes.txt'), 'text')
    symlinkSync(join(dir, 'Media', 'shot.png'), join(dir, 'Media', 'link.png'))
    expect(tree.writingNotebookTreeFile(notebook.id, 'Media/shot.png')).toBe(join(dir, 'Media', 'shot.png'))
    expect(tree.writingNotebookTreeFile(notebook.id, 'notes.txt')).toBe(join(dir, 'notes.txt'))
    expect(tree.writingNotebookTreeFile(notebook.id, 'Media')).toBeNull() // a folder is not served
    expect(tree.writingNotebookTreeFile(notebook.id, 'Media/link.png')).toBeNull() // symlink
    expect(tree.writingNotebookTreeFile(notebook.id, 'gone.png')).toBeNull()
    expect(tree.writingNotebookTreeFile(notebook.id, '../notebook.json')).toBeNull()
    expect(tree.writingNotebookTreeFile('not-a-uuid', 'notes.txt')).toBeNull()
  })
})
