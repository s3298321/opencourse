import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '@core/schema'

const REPO = join(__dirname, '..', '..')

function example(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, 'docs/example-course/course.json'), 'utf8'))
}

describe('validateManifest', () => {
  it('accepts the example course', () => {
    expect(validateManifest(example())).toEqual([])
  })

  it('requires block slugs regardless of the declared course format version', () => {
    for (const schema_version of ['1.0', '1.1', '1.2', '1.3']) {
      const manifest = example() as { schema_version: string; modules: { type?: string; lessons: { blocks: Record<string, unknown>[] }[] }[] }
      manifest.schema_version = schema_version
      manifest.modules = manifest.modules.filter((module) => module.type !== 'project')
      delete manifest.modules[0].lessons[0].blocks[0].slug
      expect(validateManifest(manifest).join(' ')).toContain('/slug:')
    }
  })

  it('still accepts a v1.0 manifest', () => {
    const m = example()
    m.schema_version = '1.0'
    m.modules = (m.modules as { type?: string }[]).filter((mod) => mod.type !== 'project')
    for (const module of m.modules as { lessons: { flashcards?: unknown }[] }[]) for (const lesson of module.lessons) delete lesson.flashcards
    expect(validateManifest(m)).toEqual([])
  })

  it('rejects an unknown schema version', () => {
    expect(validateManifest({ ...example(), schema_version: '2.0' })).not.toEqual([])
  })

  /* --- v1.2: runtimes and the second exercise shape --------------------- */

  function withExercise(extra: Record<string, unknown>): Record<string, unknown> {
    const m = example()
    const modules = m.modules as { lessons: { blocks: unknown[] }[] }[]
    const lesson = modules[0]!.lessons[0]!
    lesson.blocks = [
      {
        type: 'exercise',
        slug: 'probe-exercise',
        id: 'ex-probe',
        title: 't',
        prompt: 'p',
        verification_instructions: 'v',
        ...extra
      }
    ]
    return m
  }

  it('rejects a per-exercise runtime in another language', () => {
    expect(
      validateManifest(
        withExercise({ runtime: { language: 'c' } })
      )
    ).toContain('/modules/0/lessons/0/blocks/0/runtime/language: Only Python exercises are supported')
  })

  it('rejects a language the app has no toolchain for', () => {
    expect(validateManifest(withExercise({ runtime: { language: 'rust' } }))).not.toEqual([])
  })

  it('accepts an expected-output contract', () => {
    expect(validateManifest(withExercise({ expected_output: 'hi\n', stdin: '1\n', match: 'lines' }))).toEqual([])
    expect(validateManifest(withExercise({ match: 'fuzzy' }))).not.toEqual([])
  })

  it('refuses an extra file that would be written outside the exercise', () => {
    expect(validateManifest(withExercise({ extra_files: [{ path: 'exercise.h', content: 'x' }] }))).toEqual([])
    for (const path of ['../evil.h', '/etc/passwd', 'a/../b', '.zshrc', 'evil.command', 'evil.COMMAND']) {
      expect(validateManifest(withExercise({ extra_files: [{ path, content: 'x' }] })), path).not.toEqual([])
    }
  })

  it('accepts a course that declares no runtime at all', () => {
    const m = example()
    delete m.runtime
    delete m.python_version
    expect(validateManifest(m)).toEqual([])
  })

  it('rejects a missing required field', () => {
    const m = example()
    delete m.modules
    expect(validateManifest(m)[0]).toMatch(/modules/)
  })

  it('rejects a typo in a field name', () => {
    const m = example() as { modules: { lessons: { titel?: string }[] }[] }
    m.modules[0].lessons[0].titel = 'oops'
    expect(validateManifest(m).join(' ')).toMatch(/unknown field "titel"/)
  })

  it('rejects a non-kebab slug', () => {
    expect(validateManifest({ ...example(), slug: 'Not A Slug' }).join(' ')).toMatch(/pattern/)
  })

  it('rejects asset paths that try to escape the course', () => {
    for (const src of ['../secrets.png', '/etc/passwd', '~/x.png', 'a/../../b.png']) {
      expect(validateManifest({ ...example(), cover_image: src }), src).not.toEqual([])
    }
  })

  it('rejects a choice quiz with no options', () => {
    const m = example() as { modules: { lessons: { blocks: Record<string, unknown>[] }[] }[] }
    m.modules[0].lessons[0].blocks.push({ type: 'quiz', slug: 'q-x', id: 'q-x', kind: 'single', question: 'hm?' })
    expect(validateManifest(m)).not.toEqual([])
  })

  it('rejects a text quiz with no answers', () => {
    const m = example() as { modules: { lessons: { blocks: Record<string, unknown>[] }[] }[] }
    m.modules[0].lessons[0].blocks.push({ type: 'quiz', slug: 'q-y', id: 'q-y', kind: 'text', question: 'hm?' })
    expect(validateManifest(m)).not.toEqual([])
  })

  it('rejects an unknown block type', () => {
    const m = example() as { modules: { lessons: { blocks: Record<string, unknown>[] }[] }[] }
    m.modules[0].lessons[0].blocks.push({ type: 'podcast', src: 'x.mp3' })
    expect(validateManifest(m)).not.toEqual([])
  })
})
