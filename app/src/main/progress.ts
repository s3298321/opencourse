/** Progress persistence: one JSON file per course, under the current user. */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { emptyProgress, normalizeProgress } from '../core/progress'
import type { CourseProgress } from '../core/types'
import { userProgressDir } from './paths'
import { assertSafeSegment } from '../core/scaffold'
import { requireUser } from './users'

function dir(): string {
  return userProgressDir(requireUser())
}

function fileFor(courseId: string): string {
  return join(dir(), `${assertSafeSegment(courseId, 'course id')}.json`)
}

export function readProgress(courseId: string): CourseProgress {
  try {
    return normalizeProgress(courseId, JSON.parse(readFileSync(fileFor(courseId), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProgress(courseId)
    throw new Error(`Progress could not be read; the original file is retained: ${(error as Error).message}`)
  }
}

/** Atomic write: a crash mid-save must not truncate someone's progress. */
export function writeProgress(progress: CourseProgress): CourseProgress {
  mkdirSync(dir(), { recursive: true })
  const target = fileFor(progress.courseId)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(progress, null, 2))
  renameSync(tmp, target)
  return progress
}

export function updateProgress(
  courseId: string,
  mutate: (current: CourseProgress) => CourseProgress
): CourseProgress {
  return writeProgress(mutate(readProgress(courseId)))
}
