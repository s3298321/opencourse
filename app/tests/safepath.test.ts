import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { isInside, resolveInside } from '@core/safepath'

let root: string
let outside: string

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'opencourse-safepath-'))
  root = join(base, 'course')
  outside = join(base, 'secrets')
  mkdirSync(join(root, 'assets', 'viz', 'v'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'course.json'), '{}')
  writeFileSync(join(root, 'assets', 'viz', 'v', 'index.html'), '<h1>hi</h1>')
  writeFileSync(join(outside, 'passwd'), 'root:x:0:0')
  symlinkSync(join(outside, 'passwd'), join(root, 'assets', 'link-out'))
})

describe('resolveInside', () => {
  it('resolves a file in the course', () => {
    expect(resolveInside(root, 'assets/viz/v/index.html')).toContain('index.html')
  })

  it('refuses to walk out with ..', () => {
    expect(resolveInside(root, '../secrets/passwd')).toBeNull()
    expect(resolveInside(root, 'assets/../../secrets/passwd')).toBeNull()
  })

  it('refuses percent-encoded traversal', () => {
    expect(resolveInside(root, '%2e%2e%2fsecrets%2fpasswd')).toBeNull()
  })

  it('refuses an absolute path', () => {
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
  })

  it('refuses a symlink that points outside the course', () => {
    expect(resolveInside(root, 'assets/link-out')).toBeNull()
  })

  it('refuses a directory', () => {
    expect(resolveInside(root, 'assets')).toBeNull()
  })

  it('returns null for anything missing or malformed', () => {
    expect(resolveInside(root, 'nope.png')).toBeNull()
    expect(resolveInside(root, '%zz')).toBeNull()
    expect(resolveInside(root, 'a\0b')).toBeNull()
  })
})

/**
 * isInside is what guards the terminal: unlike resolveInside it has to accept
 * directories, and directories the workbench has not created yet.
 */
describe('isInside', () => {
  it('accepts the root itself and anything under it', () => {
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, join(root, 'assets'))).toBe(true)
    expect(isInside(root, join(root, 'assets', 'viz', 'v'))).toBe(true)
  })

  it('accepts a directory that does not exist yet', () => {
    expect(isInside(root, join(root, 'course-slug', '.venv', 'bin'))).toBe(true)
  })

  it('refuses a sibling directory', () => {
    expect(isInside(root, outside)).toBe(false)
  })

  it('refuses a traversal, however it is spelled', () => {
    expect(isInside(root, join(root, '..', 'secrets'))).toBe(false)
    expect(isInside(root, join(root, 'assets', '..', '..', 'secrets'))).toBe(false)
  })

  it('refuses a path that reaches out through a symlinked ancestor', () => {
    expect(isInside(root, join(root, 'assets', 'link-out'))).toBe(false)
  })

  it('refuses a null byte and an empty root', () => {
    expect(isInside(root, `${root}/a\0b`)).toBe(false)
    expect(isInside('', root)).toBe(false)
  })
})
