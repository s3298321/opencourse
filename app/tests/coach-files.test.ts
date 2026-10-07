/**
 * A coach project's workspace. This is the one place in the app where a
 * language model names a file, so the interesting tests are the refusals - and
 * that each refusal says something the model could act on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-coachfs-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  }
}))

const { createUser, deleteUser, listUsers } = await import('../src/main/users')
const { closeDb } = await import('../src/main/db')
const { createProject, workspaceDir } = await import('../src/main/coach')
const { createFolder, listFiles, moveFile, purgeFile, readTextFile, trashFile, writeWorkspaceFile } = await import(
  '../src/main/coachfiles'
)
const { MAX_COACH_FILE_BYTES, TRASH_DIR, countFiles, folderPaths } = await import('../src/core/coach/files')

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
let project = ''
beforeEach(() => {
  closeDb()
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
  createUser('Ada')
  project = createProject({ name: 'French' }).id
})

describe('paths a coach might ask for', () => {
  const NUL = String.fromCharCode(0)
  const refused: readonly (readonly [string, string])[] = [
    ['traversal out of the project', '../../users.json'],
    ['traversal through a subdirectory', 'notes/../../../users.json'],
    ['an absolute path', '/etc/passwd'],
    ['a percent-encoded traversal', '%2e%2e%2fusers.json'],
    ['a NUL byte', `notes${NUL}.md`],
    ['something macOS runs on double-click', 'run.command'],
    ['a dotfile', '.zshrc'],
    ['an empty path', '']
  ]

  for (const [what, path] of refused) {
    it(`refuses ${what}`, () => {
      expect(writeWorkspaceFile(project, path, 'x').ok).toBe(false)
      expect(existsSync(join(dataDir, 'stolen.md'))).toBe(false)
    })
  }

  it('refuses an accented or spaced name, and says how to fix it', () => {
    for (const name of ['revisions-é.md', 'mots a reviser.md']) {
      const result = writeWorkspaceFile(project, name, 'x')
      expect(result.ok).toBe(false)
      // Written for the model to recover from, not for a log.
      expect(result.ok === false && result.error).toMatch(/letters, digits, dot, dash and underscore/)
    }
  })

  it('never escapes through a symlinked directory inside the project', () => {
    const outside = join(root, `escape-${n}`)
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(workspaceDir(project), 'away'))

    expect(writeWorkspaceFile(project, 'away/loot.md', 'x').ok).toBe(false)
    expect(readdirSync(outside)).toHaveLength(0)
  })

  it('accepts the names the coach is actually told to use', () => {
    for (const name of ['context.md', 'learned.md', 'review.md', 'notes/mots-a-reviser.md']) {
      expect(writeWorkspaceFile(project, name, '# ok').ok).toBe(true)
    }
  })

  it('refuses a file type the app could never show', () => {
    const result = writeWorkspaceFile(project, 'notes.exe', 'x')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/\.md/)
  })

  it('refuses to let the coach overwrite the project mirror', () => {
    const result = writeWorkspaceFile(project, 'project.json', '{"id":"cp_evil"}')
    expect(result.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(workspaceDir(project), 'project.json'), 'utf8')).id).toBe(project)
  })
})

describe('writing', () => {
  it('appends rather than rewriting, which is what a growing word list needs', () => {
    writeWorkspaceFile(project, 'learned.md', 'le chien\n')
    writeWorkspaceFile(project, 'learned.md', 'le chat\n', 'append')
    expect(readFileSync(join(workspaceDir(project), 'learned.md'), 'utf8')).toBe('le chien\nle chat\n')
  })

  it('keeps accents in the content even though it refuses them in the name', () => {
    writeWorkspaceFile(project, 'learned.md', 'révisions : être, avoir')
    expect(readFileSync(join(workspaceDir(project), 'learned.md'), 'utf8')).toContain('révisions : être')
  })

  it('refuses a file over the size cap and says what the cap is', () => {
    const result = writeWorkspaceFile(project, 'big.md', 'x'.repeat(MAX_COACH_FILE_BYTES + 1))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(String(MAX_COACH_FILE_BYTES))
    expect(existsSync(join(workspaceDir(project), 'big.md'))).toBe(false)
  })

  it('creates the folder a nested note needs', () => {
    expect(writeWorkspaceFile(project, 'weeks/one/mots.md', 'x').ok).toBe(true)
    expect(existsSync(join(workspaceDir(project), 'weeks', 'one', 'mots.md'))).toBe(true)
  })
})

describe('the tree', () => {
  it('shows text and binary differently, and hides the mirror the app owns', () => {
    writeWorkspaceFile(project, 'learned.md', '# mots')
    writeFileSync(join(workspaceDir(project), 'audio.mp3'), Buffer.from([0xff, 0xfb, 0x00, 0x00]))

    const tree = listFiles(project)
    expect(tree.map((node) => node.name)).not.toContain('project.json')
    expect(tree.find((node) => node.name === 'learned.md')?.kind).toBe('text')
    expect(tree.find((node) => node.name === 'audio.mp3')?.kind).toBe('binary')
  })

  it('calls a .md full of NUL bytes binary rather than rendering it', () => {
    writeFileSync(join(workspaceDir(project), 'odd.md'), Buffer.from([0x23, 0x20, 0x00, 0x41]))
    expect(listFiles(project).find((node) => node.name === 'odd.md')?.kind).toBe('binary')
  })

  it('reads an extensionless file by its bytes', () => {
    writeFileSync(join(workspaceDir(project), 'NOTES'), 'plain text, no extension')
    writeFileSync(join(workspaceDir(project), 'BLOB'), Buffer.from([0x00, 0x01, 0x02]))
    const tree = listFiles(project)
    expect(tree.find((node) => node.name === 'NOTES')?.kind).toBe('text')
    expect(tree.find((node) => node.name === 'BLOB')?.kind).toBe('binary')
  })

  it('nests folders and sorts them before files', () => {
    writeWorkspaceFile(project, 'zebra.md', 'x')
    writeWorkspaceFile(project, 'weeks/one.md', 'x')

    const tree = listFiles(project)
    expect(tree[0]?.name).toBe('weeks')
    expect(tree[0]?.kind).toBe('dir')
    expect(tree[0]?.children?.map((child) => child.name)).toEqual(['one.md'])
    expect(countFiles(tree)).toBe(2)
  })

  it('sorts the trash last, whatever else is there', () => {
    writeWorkspaceFile(project, 'aaa.md', 'x')
    writeWorkspaceFile(project, 'zzz.md', 'x')
    trashFile(project, 'aaa.md')
    expect(listFiles(project).at(-1)?.name).toBe(TRASH_DIR)
  })

  it('offers every folder as a move target, root included', () => {
    writeWorkspaceFile(project, 'weeks/one.md', 'x')
    expect(folderPaths(listFiles(project))).toEqual(['', 'weeks'])
  })

  it('does not follow a symlink out of the project when listing', () => {
    const outside = join(root, `listed-${n}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.md'), 'not yours')
    symlinkSync(outside, join(workspaceDir(project), 'away'))

    expect(JSON.stringify(listFiles(project))).not.toContain('secret.md')
  })
})

describe('reading', () => {
  it('returns the text of a file the coach wrote', () => {
    writeWorkspaceFile(project, 'learned.md', '# mots\n- le chien')
    expect(readTextFile(project, 'learned.md').content).toContain('le chien')
  })

  it('refuses to read its way out of the project', () => {
    expect(() => readTextFile(project, '../../users.json')).toThrow()
  })
})

describe('deleting and moving', () => {
  it('moves a deleted file to the trash rather than destroying it', () => {
    writeWorkspaceFile(project, 'learned.md', '# mots')
    expect(trashFile(project, 'learned.md')).toEqual({ status: 'ok' })

    expect(existsSync(join(workspaceDir(project), 'learned.md'))).toBe(false)
    const trashed = readdirSync(join(workspaceDir(project), TRASH_DIR))
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/learned\.md$/)
  })

  it('purges only from inside the trash', () => {
    writeWorkspaceFile(project, 'learned.md', '# mots')
    expect(purgeFile(project, 'learned.md').status).toBe('invalid')
    expect(existsSync(join(workspaceDir(project), 'learned.md'))).toBe(true)

    trashFile(project, 'learned.md')
    const name = readdirSync(join(workspaceDir(project), TRASH_DIR))[0] as string
    expect(purgeFile(project, `${TRASH_DIR}/${name}`)).toEqual({ status: 'ok' })
    expect(readdirSync(join(workspaceDir(project), TRASH_DIR))).toHaveLength(0)
  })

  it('moves a file between folders', () => {
    createFolder(project, '', 'weeks')
    writeWorkspaceFile(project, 'learned.md', '# mots')
    expect(moveFile(project, 'learned.md', 'weeks/learned.md')).toEqual({ status: 'ok' })
    expect(readFileSync(join(workspaceDir(project), 'weeks', 'learned.md'), 'utf8')).toBe('# mots')
  })

  it('refuses to overwrite, rather than losing the file that was already there', () => {
    writeWorkspaceFile(project, 'a.md', 'keep me')
    writeWorkspaceFile(project, 'b.md', 'and me')
    expect(moveFile(project, 'a.md', 'b.md')).toEqual({ status: 'exists' })
    expect(readFileSync(join(workspaceDir(project), 'b.md'), 'utf8')).toBe('and me')
  })

  it('refuses to move a folder inside itself', () => {
    createFolder(project, '', 'weeks')
    expect(moveFile(project, 'weeks', 'weeks/inner').status).toBe('invalid')
  })

  it('says so when the thing being moved is not there', () => {
    expect(moveFile(project, 'gone.md', 'weeks/gone.md')).toEqual({ status: 'missing' })
    expect(trashFile(project, 'gone.md')).toEqual({ status: 'missing' })
  })

  it('refuses a move that would land outside the project', () => {
    writeWorkspaceFile(project, 'learned.md', '# mots')
    expect(moveFile(project, 'learned.md', '../../stolen.md').status).toBe('invalid')
    expect(existsSync(join(dataDir, 'stolen.md'))).toBe(false)
  })

  it('keeps two files trashed under the same name', () => {
    writeWorkspaceFile(project, 'a/learned.md', 'one')
    writeWorkspaceFile(project, 'b/learned.md', 'two')
    trashFile(project, 'a/learned.md')
    trashFile(project, 'b/learned.md')
    expect(readdirSync(join(workspaceDir(project), TRASH_DIR))).toHaveLength(2)
  })

  it('refuses a folder name that would not be a safe path segment', () => {
    expect(createFolder(project, '', '../escape').status).toBe('invalid')
    expect(createFolder(project, '', 'mes notes').status).toBe('invalid')
  })
})
