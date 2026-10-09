/**
 * Integration: courses loaded the way the app does - validate, build, render
 * every markdown block, resolve every asset - so a bad manifest or a broken
 * link fails here rather than in the window.
 *
 * `npm test` checks the committed courses only: the format's example and the
 * fixtures in tests/fixtures/courses. `npm run validate:content` is the content
 * gate, and adds every course in content/ - authoring input, gitignored, so
 * whatever is on this machine - with the checks about particular courses that
 * are there.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { grade } from '@core/grading'
import { buildCourse, referencedAssets } from '@core/manifest'
import { createRenderer, type MarkdownRenderer } from '@core/markdown'
import { validateManifest } from '@core/schema'
import { CURRENT_SCHEMA_VERSION } from '@core/course-document'
import { getToolchain, outputMatch, resolveRuntime, TOOLCHAIN_IDS } from '@core/toolchains'
import type { CourseManifest } from '@core/types'
import { committedCourseDirs, CONTENT_DIR, contentCourseDirs, fixtureCourseDirs } from './helpers/courses'

/** Set by `npm run validate:content`: the gate over content/. */
const GATE = Boolean(process.env['OPENCOURSE_VALIDATE_CONTENT'])
const CONTENT = GATE ? contentCourseDirs() : []
const COURSE_DIRS = [...committedCourseDirs(), ...CONTENT]
/** A particular authored course, checked by the gate when it is on this machine. */
const authored = (slug: string): boolean => GATE && existsSync(join(CONTENT_DIR, slug, 'course.json'))

let md: MarkdownRenderer
beforeAll(async () => {
  md = await createRenderer()
}, 30_000)

describe.each(COURSE_DIRS)('%s', (dir) => {
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest

  it('validates against the schema', () => {
    expect(validateManifest(manifest)).toEqual([])
  })

  it('has every referenced asset on disk', () => {
    for (const rel of referencedAssets(manifest)) {
      expect(existsSync(join(dir, rel)), rel).toBe(true)
    }
  })

  it('ships every file a visualization bundle needs', () => {
    for (const rel of referencedAssets(manifest)) {
      if (!rel.includes('/viz/')) continue
      const bundleDir = join(dir, rel.split('/').slice(0, -1).join('/'))
      const files = readdirSync(bundleDir)
      const entry = readFileSync(join(dir, rel), 'utf8')
      for (const match of entry.matchAll(/(?:src|href)="([^"?#:]+)"/g)) {
        expect(files, `${rel} references ${match[1]}`).toContain(match[1])
      }
    }
  })

  it('uses unique stable ids', () => {
    const ids: string[] = []
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type === 'quiz' || block.type === 'exercise') ids.push(block.id)
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('renders every markdown block without losing its content', () => {
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type !== 'markdown') continue
          const html = md.render(block.content)
          expect(html.length, `${lesson.slug}`).toBeGreaterThan(0)
          // A stripped tag would show up as a shrunken render.
          expect(html.length).toBeGreaterThan(block.content.length * 0.5)
        }
      }
    }
  })

  it('grades every quiz correctly when given its own answer', () => {
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type !== 'quiz') continue
          const answer =
            block.kind === 'text'
              ? [block.answers![0]]
              : block.options!.filter((o) => o.correct).map((o) => o.id)
          expect(grade(block, answer).isCorrect, `${block.id}`).toBe(true)
          const wrong = block.kind === 'text' ? ['definitely not the answer'] : []
          expect(grade(block, wrong).isCorrect, `${block.id} (wrong answer)`).toBe(false)
        }
      }
    }
  })

  it('keeps markdown out of titles, which are rendered as plain text', () => {
    // A backtick in a lesson title shows up as a literal backtick in the
    // sidebar. Caught once in the C course; pinned so it stays caught.
    //
    // Only backticks and `**`: an underscore is part of `create_task` and a
    // lone asterisk is part of `char *`, so neither is evidence of markdown.
    const titles: string[] = []
    for (const mod of manifest.modules) {
      titles.push(mod.title)
      for (const lesson of mod.lessons ?? []) {
        titles.push(lesson.title)
        for (const block of lesson.blocks) {
          if (block.type === 'exercise') titles.push(block.title)
          if (block.type === 'visualization' && block.title) titles.push(block.title)
        }
      }
    }
    for (const title of titles) {
      expect(title, title).not.toMatch(/`|\*\*/)
    }
  })

  it('gives every exercise a language the app can actually run', () => {
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type !== 'exercise') continue
          const runtime = resolveRuntime(manifest, block)
          expect(TOOLCHAIN_IDS, `${block.id}: unknown language`).toContain(runtime.language)

          const hasTests = Boolean(block.tests)
          if (!hasTests && block.expected_output === undefined) continue

          // Planning is pure, so a bad flag or an illegal test_command is caught
          // here rather than 30 seconds into the exercise gate.
          const toolchain = getToolchain(runtime.language)
          const plan = toolchain.plan({
            exerciseDir: '/tmp/x',
            envDir: toolchain.layout.envDirName ? '/tmp/x/.venv' : undefined,
            tool: '/usr/bin/tool',
            runtime,
            layout: toolchain.layout,
            hasTests,
            testCommand: block.test_command,
            expectedOutput: block.expected_output,
            stdin: block.stdin,
            match: outputMatch(block)
          })
          expect(plan.kind, `${block.id}: ${plan.kind === 'unsupported' ? plan.reason : ''}`).toBe('ok')
        }
      }
    }
  })
})

describe.each([
  { slug: 'intro-to-data-science', language: 'python', lessons: 53, quizzes: 84, exercises: 20,
    projects: ['data-audit-project', 'experiment-decision-project', 'churn-handoff-project'] }

].filter(({ slug }) => authored(slug)))('content/$slug', ({ slug, language, lessons, quizzes, exercises, projects }) => {
  const dir = join(CONTENT_DIR, slug)
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
  const course = buildCourse(manifest, dir)

  it('retains the complete lesson, quiz, exercise and project sequence', () => {
    expect(course.flatLessons).toHaveLength(lessons)
    expect(course.quizIds).toHaveLength(quizzes)
    expect(course.exerciseIds).toHaveLength(exercises)
    expect(course.flatItems.filter((item) => item.kind === 'project').map((item) => item.moduleId))
      .toEqual(projects)
  })

  it('gives every exercise a solution, starter and verification contract', () => {
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type !== 'exercise') continue
          expect(resolveRuntime(manifest, block).language, block.id).toBe(language)
          expect(block.solution, block.id).toBeTruthy()
          expect(block.starter_code, block.id).toBeTruthy()
          expect(Boolean(block.tests) || block.expected_output !== undefined, block.id).toBe(true)
          if (language === 'python') expect(block.tests, block.id).toContain('import exercise')
        }
      }
    }
  })
})

// The fixtures follow the authoring rules too, so they look like a real course.
describe.each([...fixtureCourseDirs(), ...CONTENT])('%s authoring format', (dir) => {
  const manifest = JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest

  it('uses the latest documented version', () => {
    expect(manifest.schema_version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('frames every lesson with a recap before its quizzes', () => {
    for (const mod of manifest.modules) {
      for (const lesson of mod.lessons ?? []) {
        expect(lesson.objectives?.length, lesson.slug).toBeGreaterThan(2)
        expect(lesson.estimated_minutes, lesson.slug).toBeGreaterThan(0)
        const recaps = lesson.blocks.filter(
          (b) => b.type === 'markdown' && b.content.startsWith('## Key takeaways')
        )
        expect(recaps, lesson.slug).toHaveLength(1)
        const firstQuiz = lesson.blocks.findIndex((b) => b.type === 'quiz')
        if (firstQuiz >= 0) expect(lesson.blocks.indexOf(recaps[0]), lesson.slug).toBeLessThan(firstQuiz)
        for (const block of lesson.blocks) {
          if (block.type === 'quiz') expect(block.explanation, block.id).toBeTruthy()
        }
      }
    }
  })
})
