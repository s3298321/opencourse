/**
 * Progress state. Replaces the four models in apps/progress/models.py
 * (Enrollment, LessonCompletion, QuizAttempt, ExerciseCompletion) with one
 * JSON document per course, keyed by app-local course and element UUIDs.
 */
import { lessonKey } from './manifest'
import type { CourseProgress, CourseProgressStatus, CourseView, QuizAttempt, ProjectProgress } from './types'

export const PROGRESS_VERSION = 1

export function emptyProgress(courseId: string): CourseProgress {
  return { courseId, completedLessons: [], quizAttempts: {}, exercises: {}, projects: {} }
}

/** Defensive read: anything missing or of the wrong shape falls back to empty. */
export function normalizeProgress(courseId: string, raw: unknown): CourseProgress {
  const base = emptyProgress(courseId)
  if (!raw || typeof raw !== 'object') return base
  const p = raw as Partial<CourseProgress>
  return {
    courseId,
    lastLesson:
      p.lastLesson && typeof p.lastLesson.moduleId === 'string' && typeof p.lastLesson.lessonId === 'string'
        ? { moduleId: p.lastLesson.moduleId, lessonId: p.lastLesson.lessonId }
        : undefined,
    projects: normalizeProjects(p.projects),
    lastItem: p.lastItem?.kind === 'project' && typeof p.lastItem.moduleId === 'string'
      ? { kind: 'project', moduleId: p.lastItem.moduleId }
      : p.lastItem?.kind === 'lesson' && typeof p.lastItem.moduleId === 'string' && typeof p.lastItem.lessonId === 'string'
        ? { kind: 'lesson', moduleId: p.lastItem.moduleId, lessonId: p.lastItem.lessonId }
        : p.lastLesson && typeof p.lastLesson.moduleId === 'string' && typeof p.lastLesson.lessonId === 'string'
          ? { kind: 'lesson', ...p.lastLesson } : undefined,
    lastAccessed: typeof p.lastAccessed === 'string' ? p.lastAccessed : undefined,
    lastOpenedAt: typeof p.lastOpenedAt === 'string' ? p.lastOpenedAt : undefined,
    completedLessons: Array.isArray(p.completedLessons) ? p.completedLessons.filter((x) => typeof x === 'string') : [],
    quizAttempts: p.quizAttempts && typeof p.quizAttempts === 'object' ? p.quizAttempts : {},
    exercises: p.exercises && typeof p.exercises === 'object' ? p.exercises : {}
  }
}

export function toggleLesson(
  progress: CourseProgress,
  moduleId: string,
  lessonId: string,
  now = new Date()
): CourseProgress {
  const key = lessonKey(moduleId, lessonId)
  const done = progress.completedLessons.includes(key)
  return {
    ...progress,
    completedLessons: done
      ? progress.completedLessons.filter((k) => k !== key)
      : [...progress.completedLessons, key],
    lastAccessed: now.toISOString()
  }
}

export function recordQuizAttempt(
  progress: CourseProgress,
  blockId: string,
  attempt: QuizAttempt
): CourseProgress {
  return { ...progress, quizAttempts: { ...progress.quizAttempts, [blockId]: attempt } }
}

export function setExerciseDone(
  progress: CourseProgress,
  blockId: string,
  done: boolean,
  now = new Date()
): CourseProgress {
  const exercises = { ...progress.exercises }
  if (done) {
    // Merge: a completion must not discard the last run's verdict.
    exercises[blockId] = { ...exercises[blockId], completedAt: now.toISOString() }
  } else {
    delete exercises[blockId]
  }
  return { ...progress, exercises }
}

/**
 * Records the outcome of running the checks. Completion is sticky and one-way:
 * a green run completes the exercise, a red one never un-completes work the
 * learner already finished.
 */
export function recordExerciseRun(
  progress: CourseProgress,
  blockId: string,
  passed: boolean,
  now = new Date()
): CourseProgress {
  const at = now.toISOString()
  const previous = progress.exercises[blockId]
  const entry = { ...previous, lastRun: { at, passed } }
  if (passed) entry.completedAt = previous?.completedAt ?? at
  return { ...progress, exercises: { ...progress.exercises, [blockId]: entry } }
}

/** Opening the overview records recency without starting a lesson. */
export function touchCourse(progress: CourseProgress, now = new Date()): CourseProgress {
  return { ...progress, lastOpenedAt: now.toISOString() }
}

export function touchLesson(
  progress: CourseProgress,
  moduleId: string,
  lessonId: string,
  now = new Date()
): CourseProgress {
  return { ...touchCourse(progress, now), lastLesson: { moduleId, lessonId }, lastItem: { kind: 'lesson', moduleId, lessonId }, lastAccessed: now.toISOString() }
}

export interface ProgressSummary {
  lessonsDone: number
  lessonsTotal: number
  quizzesCorrect: number
  quizzesTotal: number
  exercisesDone: number
  exercisesTotal: number
  projectsDone: number
  projectsTotal: number
  percent: number
}

export function summarizeProgress(course: CourseView, progress: CourseProgress): ProgressSummary {
  const lessonsTotal = course.flatLessons.length
  const valid = new Set(course.flatLessons.map((l) => lessonKey(l.moduleId, l.lessonId)))
  const lessonsDone = progress.completedLessons.filter((k) => valid.has(k)).length
  const quizzesCorrect = course.quizIds.filter((id) => progress.quizAttempts[id]?.isCorrect).length
  const exercisesDone = course.exerciseIds.filter((id) => progress.exercises[id]?.completedAt).length
  const projectIds = course.flatItems.filter((i) => i.kind === 'project').map((i) => i.moduleId)
  const projectsDone = projectIds.filter((id) => progress.projects?.[id]?.completedAt).length
  return {
    projectsDone, projectsTotal: projectIds.length,
    lessonsDone,
    lessonsTotal,
    quizzesCorrect,
    quizzesTotal: course.quizIds.length,
    exercisesDone,
    exercisesTotal: course.exerciseIds.length,
    percent: course.flatItems.length === 0 ? 0 : Math.round(((lessonsDone + projectsDone) / course.flatItems.length) * 100)
  }
}

/** Library status uses actual completion counts; a rounded 100% can still be unfinished. */
export function summarizeLibraryProgress(course: CourseView, progress: CourseProgress): {
  progressPercent: number; progressStatus: CourseProgressStatus; lastOpenedAt?: string
} {
  const summary = summarizeProgress(course, progress)
  const total = summary.lessonsTotal + summary.projectsTotal
  const done = summary.lessonsDone + summary.projectsDone
  const last = progress.lastItem ?? (progress.lastLesson ? { kind: 'lesson' as const, ...progress.lastLesson } : undefined)
  const started = done > 0
    || course.flatItems.some((item) => item.moduleId === last?.moduleId && (item.kind === 'project'
      ? last.kind === 'project' : last.kind === 'lesson' && item.lessonId === last.lessonId))
    || course.quizIds.some((id) => progress.quizAttempts[id])
    || course.exerciseIds.some((id) => progress.exercises[id])
    || course.flatItems.some((item) => item.kind === 'project' && progress.projects[item.moduleId]?.startedAt)
  return {
    progressPercent: summary.percent,
    progressStatus: total > 0 && done === total ? 'completed' : started ? 'in-progress' : 'not-started',
    // Existing installations already have activity timestamps to sort by.
    lastOpenedAt: progress.lastOpenedAt ?? progress.lastAccessed
  }
}

function normalizeProjects(raw: unknown): Record<string, ProjectProgress> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, ProjectProgress> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const p = value as ProjectProgress
    result[id] = {
      ...(typeof p.startedAt === 'string' ? { startedAt: p.startedAt } : {}),
      ...(typeof p.completedAt === 'string' ? { completedAt: p.completedAt } : {}),
      ...(typeof p.reviewedFingerprint === 'string' ? { reviewedFingerprint: p.reviewedFingerprint } : {}),
      ...(p.lastReview && typeof p.lastReview.chatId === 'string' && typeof p.lastReview.seq === 'number' && typeof p.lastReview.fingerprint === 'string' && typeof p.lastReview.at === 'string' ? { lastReview: p.lastReview } : {})
    }
  }
  return result
}
export function touchProject(progress: CourseProgress, moduleId: string, now = new Date()): CourseProgress {
  const at = now.toISOString()
  return { ...touchCourse(progress, now), lastItem: { kind: 'project', moduleId }, lastAccessed: at, projects: { ...progress.projects, [moduleId]: { ...progress.projects[moduleId], startedAt: progress.projects[moduleId]?.startedAt ?? at } } }
}
export function setProjectDone(progress: CourseProgress, moduleId: string, done: boolean, now = new Date()): CourseProgress {
  const entry = { ...progress.projects[moduleId] }
  if (done) entry.completedAt = now.toISOString()
  else delete entry.completedAt
  return { ...progress, projects: { ...progress.projects, [moduleId]: entry } }
}
