import { requireUser } from './users'
const mutations = new Set<string>()
export function courseBusy(courseId: string): boolean { return mutations.has(`${requireUser()}/${courseId}`) }
export function assertCourseAvailable(courseId: string): void {
  if (courseBusy(courseId)) throw new Error('The course is being saved or deleted. Please try again when it finishes.')
}
export function beginCourseMutation(courseId: string): () => void {
  assertCourseAvailable(courseId)
  const key = `${requireUser()}/${courseId}`
  mutations.add(key)
  return () => { mutations.delete(key) }
}
