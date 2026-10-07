import { describe, expect, it } from 'vitest'
import { buildCourse, findLesson, findProject, itemSiblings, referencedAssets, summarize } from '../src/core/manifest'
import { emptyProgress, normalizeProgress, setProjectDone, summarizeProgress, toggleLesson, touchProject } from '../src/core/progress'
import { validateManifest } from '../src/core/schema'
import { searchCourse } from '../src/core/search'
import { itemRoute, sectionOf } from '../src/renderer/routes'
import { projectContextText } from '../src/core/projects/context'
import { projectCourse, projectModule } from './helpers/project'
describe('project course format and navigation', () => {
  it('accepts mixed, project-only and explicitly typed lesson modules', () => {
    const course = projectCourse()
    expect(validateManifest(course)).toEqual([])
    course.modules = [projectModule()]
    expect(validateManifest(course)).toEqual([])
    expect(buildCourse(course, '/tmp/example').flatItems[0].kind).toBe('project')
    expect(summarize(buildCourse(course, '/tmp/example'))).toMatchObject({ lessonCount: 0, projectCount: 1 })
    course.modules = [{ type: 'lessons', slug: 'one', title: 'One', lessons: [{ slug: 'intro', title: 'Intro', blocks: [] }] }]
    expect(validateManifest(course)).toEqual([])
  })
  it('rejects mixed shapes, old versions with projects, duplicate IDs and unsafe starters', () => {
    const base = projectCourse()
    expect(validateManifest({ ...base, schema_version: '1.2' }).join(' ')).toContain('require schema_version 1.3')
    expect(validateManifest({ ...base, modules: [{ ...projectModule(), lessons: [] }] })).not.toEqual([])
    expect(validateManifest({ ...base, modules: [projectModule(), projectModule()] }).join(' ')).toContain('duplicate module slug')
    const mod = projectModule()
    mod.project.requirements.push({ ...mod.project.requirements[0] })
    mod.project.deliverables.push({ ...mod.project.deliverables[0] })
    mod.project.starter_files = [{ path: 'src', content: 'file' }, { path: 'src/main.py', content: '' }]
    expect(validateManifest({ ...base, modules: [mod] }).join(' ')).toMatch(/duplicate requirement.*duplicate deliverable.*collision/)
    for (const path of ['../outside', '/etc/passwd', '.env', 'run.command']) {
      mod.project.starter_files = [{ path, content: '' }]
      expect(validateManifest({ ...base, modules: [mod] }), path).not.toEqual([])
    }
  })
  it('rejects empty deliverables and oversized context without dropping criteria', () => {
    const mod = projectModule()
    expect(validateManifest({ ...projectCourse(), modules: [{ ...mod, project: { ...mod.project, deliverables: [] } }] })).not.toEqual([])
    mod.project.definition = 'x'.repeat(20000)
    mod.project.requirements = Array.from({ length: 30 }, (_, n) => ({ id: `r-${n}`, description: 'x'.repeat(2000) }))
    expect(validateManifest({ ...projectCourse(), modules: [mod] }).join(' ')).toContain('context limit')
  })
  it('orders lessons and projects without changing lesson numbering or asset traversal', () => {
    const course = buildCourse(projectCourse(), '/tmp/example')
    expect(course.flatItems.map((i) => i.kind)).toEqual(['lesson', 'project', 'lesson'])
    expect(course.flatLessons.map((i) => i.index)).toEqual([0, 1])
    expect(itemSiblings(course, 'before', 'intro').next?.kind).toBe('project')
    expect(itemSiblings(course, 'portfolio-project')).toMatchObject({ prev: { lessonId: 'intro' }, next: { lessonId: 'reflect' } })
    expect(itemSiblings(course, 'after', 'reflect').prev?.kind).toBe('project')
    expect(findLesson(course, 'portfolio-project', 'fake')).toBeUndefined()
    expect(findProject(course, 'portfolio-project')?.title).toBe('Build a portfolio')
    expect(referencedAssets(projectCourse())).toEqual([])
    const route = itemRoute(course.slug, course.flatItems[1])
    expect(route).toEqual({ name: 'project', courseId: course.slug, moduleId: 'portfolio-project' })
    expect(sectionOf({ name: 'settings', from: route })).toBe('courses')
  })
  it('searches project requirements and deliverable criteria with a project destination', () => {
    const course = buildCourse(projectCourse(), '/tmp/example')
    expect(searchCourse(course, 'design choices')).toMatchObject([{ kind: 'project', moduleId: 'portfolio-project' }])
    expect(searchCourse(course, 'two examples')[0].kind).toBe('project')
    const context = projectContextText(course.title, projectModule())
    expect(context).toContain('README explains the design choices.')
    expect(context).toContain('[content]')
    expect(context).not.toContain('Add your summary') // starter text is not requirements
  })
})
describe('project progress and compatibility', () => {
  it('normalizes legacy resume coordinates, drops corrupt project values and ignores removed projects', () => {
    expect(normalizeProgress('c', { lastLesson: { moduleId: 'one', lessonId: 'a' } }).lastItem).toEqual({ kind: 'lesson', moduleId: 'one', lessonId: 'a' })
    expect(normalizeProgress('c', { projects: { bad: null, old: { completedAt: 42 } } }).projects).toEqual({ old: {} })
    const course = buildCourse(projectCourse(), '/tmp/example')
    let p = touchProject(emptyProgress(course.slug), 'portfolio-project')
    expect(p.lastItem).toEqual({ kind: 'project', moduleId: 'portfolio-project' })
    p = toggleLesson(p, 'before', 'intro')
    p = setProjectDone(p, 'portfolio-project', true)
    p = setProjectDone(p, 'removed-project', true)
    expect(summarizeProgress(course, p)).toMatchObject({ projectsDone: 1, projectsTotal: 1, percent: 67 })
    expect(setProjectDone(p, 'portfolio-project', false).projects['portfolio-project'].completedAt).toBeUndefined()
  })
})
