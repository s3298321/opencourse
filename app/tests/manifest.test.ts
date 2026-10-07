import { describe, expect, it } from 'vitest'
import { assetUrl, buildCourse, findLesson, flattenLessons, referencedAssets, siblings, summarize } from '@core/manifest'
import type { CourseManifest } from '@core/types'

const manifest: CourseManifest = {
  schema_version: '1.1',
  slug: 'demo',
  title: 'Demo',
  cover_image: 'assets/cover.svg',
  modules: [
    {
      slug: 'one',
      title: 'One',
      lessons: [
        {
          slug: 'a',
          title: 'A',
          estimated_minutes: 10,
          blocks: [
            { type: 'markdown', slug: 'hi', content: 'hi' },
            { type: 'image', slug: 'x', src: 'assets/img/x.png', alt: 'x' },
            { type: 'quiz', slug: 'q1', id: 'q1', kind: 'text', question: '?', answers: ['x'] }
          ]
        },
        {
          slug: 'b',
          title: 'B',
          estimated_minutes: 20,
          blocks: [
            { type: 'visualization', slug: 'assets-viz-v-index-html', src: 'assets/viz/v/index.html', height: 400 },
            { type: 'exercise', slug: 'e1', id: 'e1', title: 'E', prompt: 'do it', verification_instructions: 'run it' }
          ]
        }
      ]
    },
    { slug: 'two', title: 'Two', lessons: [{ slug: 'c', title: 'C', blocks: [] }] }
  ]
}

const course = buildCourse(manifest, '/tmp/demo')

describe('assetUrl', () => {
  it('builds a opencourse url', () => {
    expect(assetUrl('demo', 'assets/img/x.png')).toBe('opencourse://demo/assets/img/x.png')
  })
  it('percent-encodes each segment but keeps the separators', () => {
    expect(assetUrl('demo', 'assets/my folder/a b.png')).toBe('opencourse://demo/assets/my%20folder/a%20b.png')
  })
  it('tolerates a leading ./', () => {
    expect(assetUrl('demo', './assets/a.png')).toBe('opencourse://demo/assets/a.png')
  })
})

describe('buildCourse', () => {
  it('rewrites asset srcs and leaves other blocks alone', () => {
    const [lessonA, lessonB] = course.modules[0].lessons!
    expect(lessonA.blocks[1]).toMatchObject({ src: 'opencourse://demo/assets/img/x.png', alt: 'x' })
    expect(lessonB.blocks[0]).toMatchObject({ src: 'opencourse://demo/assets/viz/v/index.html' })
    expect(lessonA.blocks[0]).toEqual({ type: 'markdown', slug: 'hi', content: 'hi' })
  })

  it('does not mutate the manifest it was given', () => {
    expect(manifest.modules[0].lessons![0].blocks[1]).toMatchObject({ src: 'assets/img/x.png' })
  })

  it('collects stable ids and totals', () => {
    expect(course.quizIds).toEqual(['q1'])
    expect(course.exerciseIds).toEqual(['e1'])
    expect(course.totalMinutes).toBe(30)
    expect(course.flatLessons).toHaveLength(3)
  })
})

describe('navigation', () => {
  it('flattens lessons in course order', () => {
    expect(flattenLessons(manifest).map((l) => l.lessonId)).toEqual(['a', 'b', 'c'])
  })

  it('finds a lesson by its slugs', () => {
    expect(findLesson(course, 'one', 'b')?.lesson.title).toBe('B')
    expect(findLesson(course, 'one', 'nope')).toBeUndefined()
    expect(findLesson(course, 'nope', 'b')).toBeUndefined()
  })

  it('gives prev/next and stops at the ends', () => {
    expect(siblings(course, 0)).toEqual({ prev: undefined, next: course.flatLessons[1] })
    expect(siblings(course, 1).prev?.lessonId).toBe('a')
    expect(siblings(course, 2)).toEqual({ prev: course.flatLessons[1], next: undefined })
  })
})

describe('summaries', () => {
  it('lists every referenced asset', () => {
    expect(referencedAssets(manifest)).toEqual([
      'assets/cover.svg',
      'assets/img/x.png',
      'assets/viz/v/index.html'
    ])
  })

  it('summarizes for the library screen', () => {
    expect(summarize(course)).toMatchObject({
      slug: 'demo',
      lessonCount: 3,
      coverUrl: 'opencourse://demo/assets/cover.svg'
    })
  })
})

describe('asset resolution', () => {
  it('uses an injected resolver for every asset, cover included', () => {
    const seen: string[] = []
    const custom = buildCourse(manifest, '/tmp/demo', (rel: string) => {
      seen.push(rel)
      return `x://${rel}`
    })

    expect(seen).toEqual(expect.arrayContaining(['assets/cover.svg', 'assets/img/x.png', 'assets/viz/v/index.html']))
    expect(custom.coverUrl).toBe('x://assets/cover.svg')
    expect(custom.modules[0].lessons![0].blocks[1]).toMatchObject({ src: 'x://assets/img/x.png' })
    expect(summarize(custom).coverUrl).toBe('x://assets/cover.svg')
  })

  it('falls back to opencourse:// when no resolver is given', () => {
    expect(course.coverUrl).toBe('opencourse://demo/assets/cover.svg')
  })
})
