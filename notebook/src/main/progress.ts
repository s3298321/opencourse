/** Progress persistence: one JSON file per course, under the current user. */
import { db } from './db'
import { journalProgress } from './learning-store'
import { readFileSync } from 'node:fs'
import { atomicJSON } from './course-store'
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
    const pending = db().prepare('SELECT value FROM learning_progress_journal WHERE local_id=?').get(courseId) as { value: string } | undefined
    if (pending) {
      const recovered = normalizeProgress(courseId, JSON.parse(pending.value))
      persistProgress(recovered)
      db().prepare('DELETE FROM learning_progress_journal WHERE local_id=?').run(courseId)
      return recovered
    }
    return normalizeProgress(courseId, JSON.parse(readFileSync(fileFor(courseId), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProgress(courseId)
    throw new Error(`Progress could not be read; the original file is retained: ${(error as Error).message}`)
  }
}

/** Atomic write: a crash mid-save must not truncate someone's progress. */
export function writeProgress(progress: CourseProgress): CourseProgress {
  const journaled = journalProgress(readProgress(progress.courseId), progress)
  const result = persistProgress(progress)
  if (journaled) db().prepare('DELETE FROM learning_progress_journal WHERE local_id=?').run(progress.courseId)
  return result
}
export function persistProgress(progress: CourseProgress): CourseProgress {
  atomicJSON(fileFor(progress.courseId), progress)
  return progress
}

export function updateProgress(
  courseId: string,
  mutate: (current: CourseProgress) => CourseProgress
): CourseProgress {
  return writeProgress(mutate(readProgress(courseId)))
}
