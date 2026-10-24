// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { insertLessonBlock, moveLessonBlock } from '../src/core/course-editor'
import type { CourseManifest } from '../src/core/types'
const manifest = (): CourseManifest => ({ schema_version: '1.8', title: 'Test', slug: 'test', modules: [{ nodeId: 'module', title: 'Module', slug: 'module', lessons: [{ nodeId: 'lesson', title: 'Lesson', slug: 'lesson', blocks: ['a', 'b', 'c'].map(id => ({ nodeId: id, type: 'markdown', slug: id, content: id })) }, { nodeId: 'other', title: 'Other', slug: 'other', blocks: [] }] }] })
const blocks = (value: CourseManifest) => value.modules[0].lessons![0].blocks

describe('lesson element operations', () => {
  it.each([0, 1, 2, 3])('inserts a fresh element at boundary %i without changing existing identities or the input', index => {
    const source = manifest()
    const result = insertLessonBlock(source, 'lesson', 'quiz', index, (() => { let n = 0; return () => `new-${++n}` })())
    expect(result.id).toBe('new-1')
    expect(blocks(result.manifest)[index]).toMatchObject({ nodeId: 'new-1', type: 'quiz', options: [{ nodeId: 'new-2' }, { nodeId: 'new-3' }] })
    expect(blocks(result.manifest).filter(block => block.nodeId !== result.id)).toEqual(blocks(source))
    expect(blocks(source).map(block => block.nodeId)).toEqual(['a', 'b', 'c'])
  })
  it('supports empty lessons and unique slugs for repeated palette additions', () => {
    const first = insertLessonBlock(manifest(), 'other', 'markdown', 0, () => 'first')
    const second = insertLessonBlock(first.manifest, 'other', 'markdown', 1, () => 'second')
    const added = second.manifest.modules[0].lessons![1].blocks
    expect(new Set(added.map(block => block.slug)).size).toBe(2)
    expect(added.map(block => block.nodeId)).toEqual(['first', 'second'])
  })
  it.each([['a', 3, ['b', 'c', 'a']], ['c', 0, ['c', 'a', 'b']], ['a', 2, ['b', 'a', 'c']]] as const)('moves %s to boundary %i preserving content and identity', (id, boundary, expected) => {
    const source = manifest(), result = moveLessonBlock(source, 'lesson', id, boundary)
    expect(blocks(result).map(block => block.nodeId)).toEqual(expected)
    for (const block of blocks(result)) expect(block).toEqual(blocks(source).find(old => old.nodeId === block.nodeId))
    expect(blocks(source).map(block => block.nodeId)).toEqual(['a', 'b', 'c'])
  })
  it('ignores invalid, cross-lesson and adjacent drops', () => {
    const source = manifest()
    for (const [lesson, id, boundary] of [['other', 'a', 0], ['missing', 'a', 0], ['lesson', 'missing', 0], ['lesson', 'a', -1], ['lesson', 'a', 4], ['lesson', 'a', 0], ['lesson', 'a', 1]] as const) expect(moveLessonBlock(source, lesson, id, boundary)).toBe(source)
    for (const [lesson, index] of [['missing', 0], ['module', 0], ['lesson', -1], ['lesson', 4], ['lesson', .5]] as const) expect(insertLessonBlock(source, lesson, 'markdown', index, () => { throw new Error('should not allocate') })).toEqual({ manifest: source })
  })
})
