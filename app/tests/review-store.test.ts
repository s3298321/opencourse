// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CourseManifest } from '../src/core/types'
import { emptyProgress } from '../src/core/progress'
import { installCourseFixture } from './helpers/course'
import { deleteElement, editElement, reorderElement } from '../src/core/course-editor'

const root = mkdtempSync(join(tmpdir(), 'opencourse-review-'))
let dataDir = join(root, 'data'), serial = 0
vi.mock('electron', () => ({ app: { getPath: () => dataDir, on: () => {} }, dialog: {} }))
vi.mock('../src/main/toolchain', () => ({ stopCourseWork: async () => {} }))
vi.mock('../src/main/pty', () => ({ disposePtysInDirectory: () => {} }))
const { closeDb, db } = await import('../src/main/db')
const { createUser, switchUser } = await import('../src/main/users')
const { reloadCourses } = await import('../src/main/courses')
const { writeProgress, readProgress } = await import('../src/main/progress')
const { getAuthoringCourse, saveDraft, saveCourse } = await import('../src/main/course-authoring')
const { endAllReviews, endReviewSession, getReviewSummary, invalidateCourseReviews, rateReviewCard, resetFlashcardProgress, revealReviewAnswer, startReviewSession } = await import('../src/main/review')
const now = new Date('2026-10-06T10:00:00Z')
let userId: string
beforeEach(() => { closeDb(); endAllReviews(); dataDir = join(root, `data-${++serial}`); userId = createUser('Learner').id; reloadCourses() })
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const manifest: CourseManifest = { schema_version: '1.4', slug: 'cards', title: 'Cards', modules: [{ slug: 'one', title: 'One', lessons: [
    { slug: 'intro', title: 'Intro', blocks: [], flashcards: Array.from({ length: 25 }, (_, index) => ({ id: `card-${index}`, question: `Question ${index}?`, answer: `Private answer ${index}` })) },
    { slug: 'later', title: 'Later', blocks: [], flashcards: [{ id: 'future', question: 'Future?', answer: 'Future answer' }] }
  ] }] }
  const course = installCourseFixture(manifest), lesson = course.modules[0].lessons![0]
  writeProgress({ ...emptyProgress(course.courseId), completedLessons: [lesson.slug], lastItem: { kind: 'lesson', moduleId: course.modules[0].slug, lessonId: lesson.slug } })
  return course
}
describe('review session persistence', () => {
  it('unlocks only completed lessons, respects counts and redacts every initial answer', () => {
    const course = fixture()
    expect(getReviewSummary(course.courseId, now)).toMatchObject({ total: 26, eligible: 25, new: 25, practiced: 0, estimatedRecall: null })
    for (const count of [10, 15, 20] as const) {
      const session = startReviewSession(course.courseId, count, 1, now)
      expect(session.total).toBe(count)
      expect(JSON.stringify(session)).not.toContain('Private answer')
    }
    expect(() => startReviewSession(course.courseId, 12 as never, 1, now)).toThrow('Choose')
    writeProgress(emptyProgress(course.courseId))
    expect(() => startReviewSession(course.courseId, 10, 1, now)).toThrow('Complete a lesson')
  })
  it('requires reveal, rates once, saves logs and schedules without changing lesson progress', () => {
    const course = fixture(), progress = readProgress(course.courseId), session = startReviewSession(course.courseId, 10, 1, now), id = session.card!.id
    expect(() => rateReviewCard(session.id, id, 'good', 1, now)).toThrow('Reveal')
    expect(() => revealReviewAnswer(session.id, id, 2, now)).toThrow('ended')
    expect(revealReviewAnswer(session.id, id, 1, now).answer).toBe('Private answer 0')
    const next = rateReviewCard(session.id, id, 'good', 1, now)
    expect(next).toMatchObject({ reviewed: 1, ratings: { good: 1 }, summary: { practiced: 1, new: 24 } })
    expect(next.card!.id).not.toBe(id)
    expect(rateReviewCard(session.id, id, 'good', 1, now)).toEqual(next)
    expect(() => rateReviewCard(session.id, id, 'again', 1, now)).toThrow('already been rated')
    expect(() => rateReviewCard(session.id, next.card!.id, 'wrong' as never, 1, now)).toThrow('Invalid')
    expect(db().prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get()).toEqual({ n: 1 })
    expect(readProgress(course.courseId)).toEqual(progress)
    endReviewSession(session.id, 1); closeDb()
    expect(getReviewSummary(course.courseId, now).practiced).toBe(1)
  })
  it('rolls back a failed history write and lets the same card be retried', () => {
    const course = fixture(), session = startReviewSession(course.courseId, 10, 1, now), id = session.card!.id
    revealReviewAnswer(session.id, id, 1, now)
    db().exec("CREATE TRIGGER fail_review BEFORE INSERT ON flashcard_reviews BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;")
    expect(() => rateReviewCard(session.id, id, 'good', 1, now)).toThrow('simulated write failure')
    expect(getReviewSummary(course.courseId, now).practiced).toBe(0)
    db().exec('DROP TRIGGER fail_review')
    expect(rateReviewCard(session.id, id, 'good', 1, now).reviewed).toBe(1)
  })
  it('rejects stale ratings from another window, unexpected cards, revisions and users', () => {
    const course = fixture(), first = startReviewSession(course.courseId, 10, 1, now), second = startReviewSession(course.courseId, 10, 2, now), id = first.card!.id
    revealReviewAnswer(first.id, id, 1, now); revealReviewAnswer(second.id, id, 2, now)
    rateReviewCard(first.id, id, 'good', 1, now)
    expect(() => rateReviewCard(second.id, id, 'good', 2, now)).toThrow('another window')
    expect(() => revealReviewAnswer(first.id, 'not-in-session', 1, now)).toThrow('no longer available')
    const authored = getAuthoringCourse(course.courseId).document.manifest!
    installCourseFixture(authored, course.courseId)
    expect(() => revealReviewAnswer(first.id, id, 1, now)).toThrow('course changed')
    const other = startReviewSession(course.courseId, 10, 3, now)
    createUser('Other'); expect(() => revealReviewAnswer(other.id, other.card!.id, 3, now)).toThrow('ended')
    switchUser(userId); invalidateCourseReviews(course.courseId)
    expect(() => revealReviewAnswer(other.id, other.card!.id, 3, now)).toThrow('ended')
  })
  it('preserves states through edits/reordering, locks incomplete lessons and cascades saved deletion', async () => {
    const course = fixture(), session = startReviewSession(course.courseId, 10, 1, now), id = session.card!.id
    revealReviewAnswer(session.id, id, 1, now); rateReviewCard(session.id, id, 'easy', 1, now)
    const authored = getAuthoringCourse(course.courseId), lesson = authored.draft.manifest.modules[0].lessons![0]
    const edited = reorderElement(editElement(authored.draft.manifest, id, { question: 'Changed?' }), id, 1)
    const draft = saveDraft(course.courseId, edited, authored.document.revision, authored.draft.draftVersion)
    if ('status' in draft) throw new Error('Fixture conflict')
    expect(await saveCourse(course.courseId, authored.document.revision, draft.draftVersion)).toMatchObject({ status: 'ok' })
    expect(getReviewSummary(course.courseId, now)).toMatchObject({ eligible: 25, practiced: 1 })
    writeProgress({ ...readProgress(course.courseId), completedLessons: [] })
    expect(getReviewSummary(course.courseId, now)).toMatchObject({ eligible: 0, practiced: 0 })
    expect(db().prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get()).toEqual({ n: 1 })
    writeProgress({ ...readProgress(course.courseId), completedLessons: [lesson.nodeId!] })
    expect(getReviewSummary(course.courseId, now).practiced).toBe(1)
    const latest = getAuthoringCourse(course.courseId), removed = saveDraft(course.courseId, deleteElement(latest.draft.manifest, lesson.nodeId!), latest.document.revision, latest.draft.draftVersion)
    if ('status' in removed) throw new Error('Fixture conflict')
    expect(await saveCourse(course.courseId, latest.document.revision, removed.draftVersion)).toMatchObject({ status: 'confirmation-required' })
    await saveCourse(course.courseId, latest.document.revision, removed.draftVersion, true)
    expect(db().prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get()).toEqual({ n: 0 })
    expect(db().prepare('SELECT COUNT(*) AS n FROM flashcard_states').get()).toEqual({ n: 0 })
  })
  it('resets schedule/history and invalidates sessions, including malformed stored state', () => {
    const course = fixture(), session = startReviewSession(course.courseId, 10, 1, now), id = session.card!.id
    revealReviewAnswer(session.id, id, 1, now); rateReviewCard(session.id, id, 'again', 1, now)
    db().prepare('UPDATE flashcard_states SET state=? WHERE card_id=?').run('{"due":"bad"}', id)
    expect(() => getReviewSummary(course.courseId, now)).toThrow('invalid')
    resetFlashcardProgress(course.courseId, id)
    expect(getReviewSummary(course.courseId, now).new).toBe(25)
    expect(db().prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get()).toEqual({ n: 0 })
    expect(() => revealReviewAnswer(session.id, id, 1, now)).toThrow('ended')
  })
  it('completes a small deck without repeating a forgotten card', () => {
    const course = fixture(), progress = readProgress(course.courseId)
    writeProgress({ ...progress, completedLessons: [course.modules[0].lessons![1].slug] })
    const session = startReviewSession(course.courseId, 20, 1, now)
    expect(session.total).toBe(1)
    revealReviewAnswer(session.id, session.card!.id, 1, now)
    const done = rateReviewCard(session.id, session.card!.id, 'again', 1, now)
    expect(done).toMatchObject({ reviewed: 1, card: null, ratings: { again: 1 }, summary: { practiced: 1 } })
  })
})
