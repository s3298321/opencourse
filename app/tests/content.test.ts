/**
 * Integration: the authored courses and the format fixture. Loads them the way the app
 * does - validate, build, render every markdown block, resolve every asset -
 * so a bad manifest or a broken link fails here rather than in the window.
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
import type { CourseManifest, ExerciseBlock } from '@core/types'
import { skipWithoutContent } from './helpers/content'

const REPO = join(__dirname, '..', '..')

/** Every authored course in content/, plus the format fixture. */
function courseDirs(): string[] {
  const content = join(REPO, 'content')
  const dirs = existsSync(content)
    ? readdirSync(content, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(content, e.name, 'course.json')))
        .map((e) => join(content, e.name))
    : []
  return [...dirs, join(REPO, 'docs', 'example-course')]
}

const COURSE_DIRS = courseDirs()

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
    projects: ['data-audit-project', 'experiment-decision-project', 'churn-handoff-project'] },
  { slug: 'operating-systems-and-c', language: 'c', lessons: 30, quizzes: 60, exercises: 21,
    projects: ['stream-counter', 'file-copy', 'small-launcher'] }
].filter(({ slug }) => !skipWithoutContent(slug)))('content/$slug', ({ slug, language, lessons, quizzes, exercises, projects }) => {
  const dir = join(REPO, 'content', slug)
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

describe.each(COURSE_DIRS.filter((dir) => dir.startsWith(join(REPO, 'content'))))('%s authoring format', (dir) => {
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

const skipLlvm = skipWithoutContent('intro-to-llvm')
describe.skipIf(skipLlvm)('content/intro-to-llvm', () => {
  const dir = join(REPO, 'content', 'intro-to-llvm')
  const manifest = skipLlvm ? (undefined as never) : JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
  const course = skipLlvm ? (undefined as never) : buildCourse(manifest, dir)

  const exercises = (): ExerciseBlock[] =>
    course.modules.flatMap((m) => (m.lessons ?? []).flatMap((l) => l.blocks.filter((b) => b.type === 'exercise')))
  const inLanguage = (language: string): ExerciseBlock[] =>
    exercises().filter((block) => resolveRuntime(manifest, block).language === language)

  it('is the whole course', () => {
    expect(course.modules).toHaveLength(8)
    expect(course.flatItems.filter((item) => item.kind === 'project').map((item) => item.moduleId))
      .toEqual(['project-a-real-pass'])
    expect(course.flatLessons).toHaveLength(23)
    expect(course.quizIds).toHaveLength(92)
    expect(course.exerciseIds).toHaveLength(22)
  })

  it('frames every lesson', () => {
    for (const mod of course.modules) {
      for (const lesson of mod.lessons ?? []) {
        expect(lesson.objectives?.length, lesson.slug).toBeGreaterThan(2)
        expect(lesson.estimated_minutes, lesson.slug).toBeGreaterThan(0)
        const takeaways = lesson.blocks.filter(
          (b) => b.type === 'markdown' && b.content.startsWith('## Key takeaways')
        )
        expect(takeaways, lesson.slug).toHaveLength(1)
      }
    }
  })

  it('writes IR first and drives LLVM from Python after', () => {
    expect(exercises().map((block) => resolveRuntime(manifest, block).language).every(
      (language) => language === 'llvm-ir' || language === 'python'
    )).toBe(true)
    expect(inLanguage('llvm-ir')).toHaveLength(9)
    expect(inLanguage('python')).toHaveLength(13)
    for (const block of exercises()) {
      expect(block.solution, block.id).toBeTruthy()
      expect(block.starter_code, block.id).toBeTruthy()
    }
  })

  it('grades hand-written IR with a C harness that owns main and says what failed', () => {
    for (const block of inLanguage('llvm-ir')) {
      if (!block.tests) {
        // The program shape: the learner's IR is the whole program.
        expect(block.expected_output, block.id).toBeTruthy()
        expect(block.solution, block.id).toContain('define i32 @main(')
        continue
      }
      expect(block.tests, block.id).toContain('int main(void)')
      expect(block.solution, block.id).not.toMatch(/define [^@]*@main\(/)
      const header = (block.extra_files ?? []).find((f) => f.path === 'exercise.h')
      expect(header?.content, `${block.id} ships no exercise.h`).toContain('#ifndef')
      expect(block.tests, block.id).toContain('"exercise.h"')
      expect(block.tests, block.id).toMatch(/checks passed/)
      // Output is piped, so it is fully buffered: a learner's IR that crashes
      // would otherwise take every FAIL line printed before it down with it.
      expect(block.tests, block.id).toContain('setvbuf(stdout, NULL, _IONBF, 0)')
    }
  })

  it('pins llvmlite and makes it print modern opaque pointers', () => {
    for (const block of inLanguage('python')) {
      expect(resolveRuntime(manifest, block).packages, block.id).toContain('llvmlite>=0.50')
      expect(block.tests, block.id).toContain('import exercise')
      const conftest = (block.extra_files ?? []).find((f) => f.path === 'conftest.py')
      expect(conftest?.content, `${block.id} ships no conftest.py`).toContain(
        'os.environ["LLVMLITE_ENABLE_IR_LAYER_TYPED_POINTERS"] = "0"'
      )
    }
  })

  it('gives the project a build, a test runner and a first passing test', () => {
    const project = manifest.modules.find((m) => m.type === 'project')?.project
    const paths = (project?.starter_files ?? []).map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['StrengthReduce.cpp', 'build.sh', 'run_tests.sh', 'tests/mul.ll']))
    const test = project?.starter_files?.find((f) => f.path === 'tests/mul.ll')?.content ?? ''
    expect(test).toContain('; RUN:')
    expect(test).toContain('CHECK-LABEL')
  })

  it('explains every quiz', () => {
    for (const mod of course.modules) {
      for (const lesson of mod.lessons ?? []) {
        for (const block of lesson.blocks) {
          if (block.type === 'quiz') expect(block.explanation, block.id).toBeTruthy()
        }
      }
    }
  })
})
