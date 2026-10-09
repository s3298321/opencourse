import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compareVersions, DEFAULT_COURSE_VERSION, isVersion, maxVersion, parseVersion } from '../src/core/catalog/semver'
import { adoptPublishedManifest, publishedElements, publishedIdentityErrors, publishedManifest } from '../src/core/catalog/identity'
import { courseNodes, currentFormat, emptyManifest, identifyManifest, portableManifest, visitNodes } from '../src/core/course-document'
import { validateManifest } from '../src/core/schema'
import { projectCourse } from './helpers/project'

describe('course versions', () => {
  it('accepts exactly MAJOR.MINOR.PATCH', () => {
    for (const ok of ['0.1.0', '1.0.0', '10.20.300']) expect(isVersion(ok)).toBe(true)
    for (const bad of ['1.0', '1.0.0.0', 'v1.0.0', '01.0.0', '1.0.0-beta', '1.0.0+build', ' 1.0.0', '', null, 1]) expect(isVersion(bad)).toBe(false)
    expect(parseVersion('2.3.4')).toEqual([2, 3, 4])
  })
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.3', '1.10.0')).toBeLessThan(0)
    expect(maxVersion(['0.1.0', '0.10.0', '0.2.0'])).toBe('0.10.0')
    expect(maxVersion([])).toBeNull()
    expect(() => compareVersions('1.0', '1.0.0')).toThrow()
  })
  it('starts a new course at the default version, in the current format', () => {
    expect(emptyManifest()).toMatchObject({ schema_version: '1.6', version: DEFAULT_COURSE_VERSION })
    expect(currentFormat({ ...projectCourse(), version: '2.0.0' })).toMatchObject({ schema_version: '1.6', version: '2.0.0' })
  })
})

describe('schema 1.5', () => {
  it('requires a version from 1.5 and accepts older archives without one', () => {
    const course = projectCourse()
    expect(validateManifest({ ...course, schema_version: '1.4' })).toEqual([])
    expect(validateManifest({ ...course, schema_version: '1.5' }).join(' ')).toContain('/version')
    expect(validateManifest({ ...course, schema_version: '1.5', version: '1.2.0' })).toEqual([])
    expect(validateManifest({ ...course, schema_version: '1.5', version: '1.2' })).toEqual(['/version: use three numbers, MAJOR.MINOR.PATCH, such as 1.2.0'])
  })
  it('allows a uid on the course and on every element, and only a lowercase UUID v4', () => {
    const published = publishedManifest(identifyManifest(projectCourse(), randomUUID), randomUUID())
    expect(validateManifest(published)).toEqual([])
    const bad = structuredClone(published); bad.modules[0].uid = 'not-a-uuid'
    expect(validateManifest(bad).join(' ')).toContain('/modules/0/uid')
  })
})

describe('server identity', () => {
  const local = () => identifyManifest(projectCourse(), randomUUID)
  it('publishes local IDs as uids and adopts them back unchanged', () => {
    const manifest = local(), courseId = randomUUID()
    const published = publishedManifest(manifest, courseId)
    expect(published.uid).toBe(courseId)
    expect(JSON.stringify(published)).not.toContain('nodeId')
    const adopted = adoptPublishedManifest(published)
    expect(adopted.ok).toBe(true)
    if (!adopted.ok) return
    expect(adopted.courseId).toBe(courseId)
    expect(courseNodes(adopted.manifest)).toEqual(courseNodes(manifest))
    expect(JSON.stringify(adopted.manifest)).not.toContain('"uid"')
    expect(publishedElements(published).map((e) => e.uid)).toEqual(courseNodes(manifest).map((n) => n.id))
  })
  it('refuses an archive with a missing, malformed or repeated uid', () => {
    const published = publishedManifest(local(), randomUUID())
    const missing = structuredClone(published); delete missing.modules[0].lessons![0].uid
    expect(publishedIdentityErrors(missing)).toEqual(['lesson "intro": missing or invalid uid'])
    const repeated = structuredClone(published); repeated.modules[0].lessons![0].uid = repeated.modules[0].uid
    expect(publishedIdentityErrors(repeated)[0]).toContain('is used twice')
    const noCourse = structuredClone(published); delete noCourse.uid
    expect(adoptPublishedManifest(noCourse)).toMatchObject({ ok: false, errors: ['/uid: a server course must carry its own uid'] })
  })
  it('never lets a uid survive a local import or a ZIP export', () => {
    const published = publishedManifest(local(), randomUUID())
    const imported = identifyManifest(published, randomUUID)
    expect(imported.uid).toBeUndefined()
    visitNodes(imported, (node) => expect(node.uid).toBeUndefined())
    const adopted = adoptPublishedManifest(published)
    if (!adopted.ok) throw new Error(adopted.errors[0])
    const serverIds = new Set(courseNodes(adopted.manifest).map((n) => n.id))
    expect(courseNodes(imported).some((n) => serverIds.has(n.id))).toBe(false)
    expect(JSON.stringify(portableManifest(published))).not.toContain('"uid"')
  })
})
