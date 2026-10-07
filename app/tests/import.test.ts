import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ALLOWED_EXTENSIONS, classifyEntry, COURSE_POLICY, LIMITS, stripCommonRoot } from '@core/import'
import { extractArchive } from '../src/main/unzip'
import { makeZip, type ZipMember } from './helpers/zip'

const work = mkdtempSync(join(tmpdir(), 'opencourse-import-test-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

let staging: string
let counter = 0
beforeEach(() => {
  counter += 1
  staging = join(work, `staging-${counter}`)
})

const MANIFEST = JSON.stringify({
  schema_version: '1.1',
  slug: 'demo',
  title: 'Demo',
  modules: [{ slug: 'm', title: 'M', lessons: [{ slug: 'l', title: 'L', blocks: [] }] }]
})

async function unpack(members: ZipMember[]): Promise<{ error?: string }> {
  const zip = makeZip(join(work, `archive-${counter}.zip`), members)
  return extractArchive(zip, staging)
}

/* -------------------------------------------------------------------------- */
/* the policy                                                                  */
/* -------------------------------------------------------------------------- */

describe('classifyEntry', () => {
  const plain = { isSymlink: false, size: 10 }

  it('accepts an ordinary course file', () => {
    expect(classifyEntry('assets/img/a.png', plain)).toEqual({ kind: 'file', path: 'assets/img/a.png' })
  })

  it.each([
    ['../evil.json', /escapes the archive/],
    ['a/../../evil.json', /escapes the archive/],
    ['/etc/passwd.json', /absolute path/],
    ['C:/windows/x.json', /absolute path/],
    ['~/secrets.json', /home-relative/],
    ['a\\b.json', /backslash/],
    ['a//b.json', /malformed path/],
    ['./a.json', /malformed path/]
  ])('refuses %s', (name, reason) => {
    const verdict = classifyEntry(name, plain)
    expect(verdict.kind).toBe('reject')
    expect(verdict.kind === 'reject' && verdict.reason).toMatch(reason)
  })

  it('refuses a name with a null byte', () => {
    expect(classifyEntry('a\0.json', plain).kind).toBe('reject')
  })

  it('refuses a symlink however innocent its name', () => {
    const verdict = classifyEntry('assets/link.png', { isSymlink: true, size: 10 })
    expect(verdict.kind === 'reject' && verdict.reason).toMatch(/symlink/)
  })

  it('refuses a file type that is not in the format', () => {
    for (const name of ['run.sh', 'setup.py', 'thing.exe', 'noextension']) {
      const verdict = classifyEntry(name, plain)
      expect(verdict.kind === 'reject' && verdict.reason).toMatch(/not allowed/)
    }
  })

  it('refuses a member over the size cap', () => {
    const verdict = classifyEntry('assets/big.mp4', { isSymlink: false, size: LIMITS.memberBytes + 1 })
    expect(verdict.kind === 'reject' && verdict.reason).toMatch(/larger than/)
  })

  it('skips directory entries and macOS bookkeeping', () => {
    for (const name of ['assets/', '__MACOSX/course.json', '.DS_Store', 'assets/.DS_Store', 'assets/._cover.svg']) {
      expect(classifyEntry(name, plain)).toEqual({ kind: 'skip' })
    }
  })

  it('allows every extension the format documents', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(classifyEntry(`assets/file${ext}`, plain).kind).toBe('file')
    }
  })
})

describe('stripCommonRoot', () => {
  it('finds the wrapper Finder adds when you compress a folder', () => {
    expect(stripCommonRoot(['my-course/course.json', 'my-course/assets/a.svg'])).toBe('my-course')
  })

  it('leaves an archive that is already rooted alone', () => {
    expect(stripCommonRoot(['course.json', 'assets/a.svg'])).toBeNull()
  })

  it('does not strip when the entries disagree', () => {
    expect(stripCommonRoot(['a/course.json', 'b/assets/x.svg'])).toBeNull()
  })

  it('ignores macOS bookkeeping when deciding', () => {
    expect(stripCommonRoot(['__MACOSX/._c', 'my-course/course.json', 'my-course/a.svg'])).toBe('my-course')
  })
})

/* -------------------------------------------------------------------------- */
/* real archives                                                               */
/* -------------------------------------------------------------------------- */

describe('extractArchive', () => {
  it('refuses an archive whose members add up to more than the unpacked limit', async () => {
    const zip = makeZip(join(work, 'too-big.zip'), [{ name: 'course.json', content: MANIFEST }, { name: 'a.txt', content: 'x'.repeat(600) }, { name: 'b.txt', content: 'y'.repeat(600) }])
    const staging = mkdtempSync(join(work, 'too-big-'))
    const small = { ...COURSE_POLICY, limits: { ...COURSE_POLICY.limits, unpackedBytes: 1000 } }
    expect((await extractArchive(zip, staging, small)).error).toMatch(/unpacks to more than/)
    expect(LIMITS.unpackedBytes).toBeGreaterThan(LIMITS.archiveBytes)
  })

  it('unpacks a plain course archive', async () => {
    const result = await unpack([
      { name: 'course.json', content: MANIFEST },
      { name: 'assets/cover.svg', content: '<svg/>' }
    ])
    expect(result.error).toBeUndefined()
    expect(readFileSync(join(staging, 'course.json'), 'utf8')).toBe(MANIFEST)
    expect(existsSync(join(staging, 'assets/cover.svg'))).toBe(true)
  })

  it('strips the wrapping folder, so a Finder-compressed course imports', async () => {
    const result = await unpack([
      { name: 'my-course/course.json', content: MANIFEST },
      { name: 'my-course/assets/cover.svg', content: '<svg/>' }
    ])
    expect(result.error).toBeUndefined()
    expect(existsSync(join(staging, 'course.json'))).toBe(true)
    expect(existsSync(join(staging, 'my-course'))).toBe(false)
  })

  // yauzl refuses `..` and absolute names while reading the central directory,
  // so classifyEntry never sees these. That is the point of having both: the
  // wording comes from whichever guard fires first, the verdict is the same.
  it('refuses zip slip and writes nothing outside the staging directory', async () => {
    const escapee = join(work, 'escaped.json')
    rmSync(escapee, { force: true })
    const result = await unpack([
      { name: 'course.json', content: MANIFEST },
      { name: '../escaped.json', content: 'pwned' }
    ])
    expect(result.error).toMatch(/relative path|escapes the archive/)
    expect(existsSync(escapee)).toBe(false)
  })

  it('refuses an absolute member', async () => {
    const result = await unpack([{ name: '/tmp/opencourse-absolute.json', content: 'x' }])
    expect(result.error).toMatch(/absolute path/)
    expect(existsSync('/tmp/opencourse-absolute.json')).toBe(false)
  })

  it('refuses a symlink member', async () => {
    const result = await unpack([
      { name: 'course.json', content: MANIFEST },
      { name: 'assets/passwd.txt', symlinkTo: '/etc/passwd' }
    ])
    expect(result.error).toMatch(/symlink/)
  })

  it('refuses a file type outside the format', async () => {
    const result = await unpack([
      { name: 'course.json', content: MANIFEST },
      { name: 'install.sh', content: 'rm -rf /' }
    ])
    expect(result.error).toMatch(/not allowed/)
    expect(existsSync(join(staging, 'install.sh'))).toBe(false)
  })

  it('refuses a member that claims to be enormous', async () => {
    const result = await unpack([
      { name: 'course.json', content: MANIFEST },
      { name: 'assets/big.mp4', content: 'x', declaredSize: LIMITS.memberBytes + 1 }
    ])
    expect(result.error).toMatch(/larger than/)
  })

  it('refuses an archive with too many members', async () => {
    const members = Array.from({ length: LIMITS.members + 1 }, (_, i) => ({
      name: `assets/f${i}.txt`,
      content: 'x'
    }))
    expect((await unpack(members)).error).toMatch(/more than/)
  })

  it('drops macOS bookkeeping instead of failing on it', async () => {
    const result = await unpack([
      { name: '__MACOSX/._course.json', content: 'junk' },
      { name: '.DS_Store', content: 'junk' },
      { name: 'course.json', content: MANIFEST }
    ])
    expect(result.error).toBeUndefined()
    expect(existsSync(join(staging, '__MACOSX'))).toBe(false)
    expect(existsSync(join(staging, '.DS_Store'))).toBe(false)
  })

  it('refuses an archive with nothing in it', async () => {
    expect((await unpack([{ name: '.DS_Store', content: 'junk' }])).error).toMatch(/empty/)
  })

  it('reports an unreadable archive instead of throwing', async () => {
    const result = await extractArchive(join(work, 'missing.zip'), staging)
    expect(result.error).toMatch(/could not read the archive/)
  })

  it('reports a file that is not a zip at all', async () => {
    const junk = join(work, 'junk.zip')
    writeFileSync(junk, 'this is not a zip')
    expect((await extractArchive(junk, staging)).error).toMatch(/could not read the archive/)
  })
})
