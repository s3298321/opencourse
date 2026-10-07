import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Block, CourseManifest } from '../src/core/types'
import { availableBlockSlug } from '../src/core/block-slugs'
import { identifyManifest, learningManifest, portableManifest } from '../src/core/course-document'
import { copyElement, newBlock } from '../src/core/course-editor'
import { validateManifest } from '../src/core/schema'

const blocks: Block[] = [
  { type: 'markdown', slug: 'introduction', content: '# Introduction' },
  { type: 'image', slug: 'picture', src: 'assets/image.png', alt: 'A picture' },
  { type: 'video', slug: 'video-tour', src: 'assets/video.mp4', caption: 'Video tour' },
  { type: 'visualization', slug: 'interactive-diagram', src: 'assets/viz/index.html', title: 'An interactive diagram' },
  { type: 'quiz', slug: 'intro-quiz', id: 'q-intro', kind: 'text', question: 'What?', answers: ['yes'] },
  { type: 'exercise', slug: 'intro-exercise', id: 'ex-intro', title: 'Task', prompt: 'Do it', verification_instructions: 'Pass checks' }
]
function course(content: Block[] = blocks): CourseManifest {
  return { schema_version: '1.3', slug: 'course', title: 'Course', modules: [{ slug: 'module', title: 'Module', lessons: [{ slug: 'lesson', title: 'Lesson', blocks: structuredClone(content) }] }] }
}
function contents(manifest: CourseManifest): Block[] { return manifest.modules[0].lessons![0].blocks }

describe('required portable block slugs', () => {
  it('accepts authored slugs for all six types and retains them when assigning UUIDs', () => {
    const authored = course()
    expect(validateManifest(authored)).toEqual([])
    expect(portableManifest(identifyManifest(authored, randomUUID))).toEqual(authored)
  })
  it.each(blocks.map(block => [block.type, block] as const))('requires a slug on %s blocks without repairing the input', (_type, block) => {
    const missing = course([block])
    Reflect.deleteProperty(contents(missing)[0], 'slug')
    expect(validateManifest(missing).join(' ')).toContain('/slug:')
    expect(contents(identifyManifest(missing, randomUUID))[0].slug).toBeUndefined()
    expect(contents(missing)[0].slug).toBeUndefined()
  })
  it('validates kebab-case and lesson-scoped uniqueness', () => {
    for (const slug of ['', 'Bad Slug', 'bad_slug', '-bad']) {
      expect(validateManifest(course([{ type: 'markdown', slug, content: '' }]))).not.toEqual([])
    }
    const duplicates = course([{ type: 'markdown', slug: 'same', content: '' }, { type: 'image', slug: 'same', src: 'assets/image.png' }])
    expect(validateManifest(duplicates).join(' ')).toContain('/blocks/1/slug: duplicate block slug')
    const allowed = course([{ type: 'markdown', slug: 'same', content: '' }])
    allowed.modules[0].lessons!.push({ slug: 'other', title: 'Other', blocks: [{ type: 'markdown', slug: 'same', content: '' }] })
    expect(validateManifest(allowed)).toEqual([])
  })
  it('creates readable unique defaults and gives duplicate blocks fresh identities and names', () => {
    expect(availableBlockSlug('markdown', ['markdown', 'markdown-2'])).toBe('markdown-3')
    const first = newBlock('markdown', randomUUID), second = newBlock('markdown', randomUUID, [first])
    expect(first.slug).toBe('markdown'); expect(second.slug).toBe('markdown-2')
    const saved = identifyManifest(course([first, second]), randomUUID)
    const copied = copyElement(saved, contents(saved)[0].nodeId!, randomUUID)
    expect(contents(copied.manifest)[1].slug).toBe('markdown-copy')
    expect(contents(copied.manifest)[1].nodeId).not.toBe(contents(saved)[0].nodeId)
    expect(validateManifest(portableManifest(copied.manifest))).toEqual([])
  })
  it('preserves authored block slugs in learner data while lesson and quiz identifiers use UUIDs', () => {
    const saved = identifyManifest(course(), randomUUID), learner = learningManifest(saved)
    expect(learner.modules[0].slug).toBe(saved.modules[0].nodeId)
    expect(learner.modules[0].lessons![0].slug).toBe(saved.modules[0].lessons![0].nodeId)
    expect(contents(learner).map((block) => block.slug)).toEqual(contents(saved).map((block) => block.slug))
    expect(contents(learner)[4]).toMatchObject({ id: contents(saved)[4].nodeId, slug: 'intro-quiz' })
  })
})
