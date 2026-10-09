/**
 * The courses a test may read. Only committed ones: the format's example
 * course and the fixtures in tests/fixtures/courses. content/ is authoring
 * input and gitignored, so a test that read it would pass or fail with
 * whatever happened to be on the machine; only the content gates
 * (`npm run validate:content`, `npm run check:exercises`) look there.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCourse } from '@core/manifest'
import type { Course, CourseManifest } from '@core/types'

export const REPO = join(__dirname, '..', '..', '..')
export const EXAMPLE_COURSE_DIR = join(REPO, 'docs', 'example-course')
export const FIXTURE_COURSES_DIR = join(__dirname, '..', 'fixtures', 'courses')
export const CONTENT_DIR = join(REPO, 'content')

/** A fixture course's folder: `python-asyncio` or `intro-to-c`. */
export function fixtureCourseDir(slug: string): string {
  return join(FIXTURE_COURSES_DIR, slug)
}

export function readManifest(dir: string): CourseManifest {
  return JSON.parse(readFileSync(join(dir, 'course.json'), 'utf8')) as CourseManifest
}

export function loadCourse(dir: string): Course {
  return buildCourse(readManifest(dir), dir)
}

function coursesIn(parent: string): string[] {
  if (!existsSync(parent)) return []
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(parent, entry.name, 'course.json')))
    .map((entry) => join(parent, entry.name))
}

/** The example course and every fixture: what `npm test` checks. */
export function committedCourseDirs(): string[] {
  return [EXAMPLE_COURSE_DIR, ...coursesIn(FIXTURE_COURSES_DIR)]
}

/** The fixtures alone, which follow the authoring rules the example course does not need to. */
export function fixtureCourseDirs(): string[] {
  return coursesIn(FIXTURE_COURSES_DIR)
}

/** Whatever is in content/ on this machine - for the content gates only. */
export function contentCourseDirs(): string[] {
  return coursesIn(CONTENT_DIR)
}
