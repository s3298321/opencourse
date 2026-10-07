/** Disposable smoke/screenshot fixtures name authored content; resolve it to actual local IDs. */
import { getCourse, listCourses } from './courses'
import { readDocument } from './course-store'
export function fixtureCourse(slug: string) {
  const id = listCourses().find((c) => c.slug === slug)?.courseId
  return id ? getCourse(id) : undefined
}
export function fixtureProject(slug: string, moduleSlug: string) {
  const course = fixtureCourse(slug)
  if (!course) throw new Error(`Missing fixture course: ${slug}`)
  const moduleId = readDocument(course.courseId).manifest!.modules.find((m) => m.slug === moduleSlug)?.nodeId
  if (!moduleId) throw new Error(`Missing fixture project: ${moduleSlug}`)
  return { courseId: course.courseId, moduleId }
}
/** Input adaptation only: returned manifests/progress continue to expose real UUIDs. */
export const FIXTURE_API = `(() => {
  const native = window.opencourse;
  const courseId = async name => (await native.listCourses()).find(c => c.courseId === name || c.slug === name)?.courseId ?? name;
  const nodeId = async (course, name) => {
    const id = await courseId(course);
    const {document} = await native.getAuthoringCourse(id);
    let found;
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.nodeId === name || value.slug === name || value.id === name) found = value.nodeId;
      for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); }
    };
    walk(document.manifest);
    return found ?? name;
  };
  const lesson = async (course, ref) => ({moduleId: await nodeId(course, ref.moduleId), lessonId: await nodeId(course, ref.lessonId)});
  const targets = new Set(['openExercise','readExerciseFile','writeExerciseFile','ensureEnv','runTests','openCourseProject','setProjectDone','openProjectEditor','revealProject','listProjectChats','createProjectChat']);
  const courses = new Set(['getCourse','getProgress','removeCourse','listChats','createChat','getSolution','submitQuiz','setExerciseDone','toggleLesson','touchLesson']);
  window.fixtureCourseId = courseId; window.fixtureNodeId = nodeId;
  window.fixtureAPI = new Proxy({}, {get(_, method) {
    const call = native[method];
    if (!targets.has(method) && !courses.has(method) && method !== 'sendChatMessage') return call;
    return async (...args) => {
      if (targets.has(method)) {
        const original = args[0];
        args[0] = {...original, courseId: await courseId(original.courseId)};
        if (original.blockId) args[0].blockId = await nodeId(original.courseId, original.blockId);
        if (original.moduleId) args[0].moduleId = await nodeId(original.courseId, original.moduleId);
        if (original.lessonId) args[0].lessonId = await nodeId(original.courseId, original.lessonId);
      } else if (courses.has(method)) {
        const name = args[0]; args[0] = await courseId(name);
        if (method === 'createChat') args[1] = await lesson(name, args[1]);
        if (['getSolution','submitQuiz','setExerciseDone'].includes(method)) args[1] = await nodeId(name, args[1]);
        if (['touchLesson','toggleLesson'].includes(method)) {args[1] = await nodeId(name, args[1]); args[2] = await nodeId(name, args[2]);}
      } else if (method === 'sendChatMessage') {
        const thread = await native.getChat(args[0]);
        if (thread && args[3]) args[3] = await lesson(thread.chat.courseId, args[3]);
      }
      return call(...args);
    };
  }});
})()`
