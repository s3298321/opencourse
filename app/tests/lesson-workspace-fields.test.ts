import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CourseLessonWorkspace from '../src/renderer/routes/CourseLessonWorkspace'
import { EditorAttachments } from '../src/renderer/routes/CourseEditorFields'
import type { CourseManifest } from '../src/core/types'

let root: Root | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })

it('keeps attachment edits and validation attached to the right element after reordering', async () => {
  const upload = vi.fn(async () => ({ attachment: { entry: 'assets/photo.png', files: ['assets/photo.png'] }, htmlEntries: [] }))
  vi.stubGlobal('opencourse', { uploadCourseAttachment: upload })
  let latest: CourseManifest
  function Harness() {
    const [manifest, setManifest] = useState<CourseManifest>({ schema_version: '1.8', slug: 'test', title: 'Test', modules: [{ nodeId: 'module', slug: 'module', title: 'Module', lessons: [{ nodeId: 'lesson', slug: 'lesson', title: 'Lesson', blocks: [{ nodeId: 'text', type: 'markdown', slug: 'text', content: 'Keep me' }, { nodeId: 'image', type: 'image', slug: 'image', src: '', alt: '' }] }] }] })
    latest = manifest
    return createElement(EditorAttachments, { value: [] }, createElement(CourseLessonWorkspace, {
      lesson: manifest.modules[0].lessons![0], manifest, courseId: 'course', path: '/modules/0/lessons/0',
      errors: ['/modules/0/lessons/0/blocks/0/src: must NOT have fewer than 1 characters'], locked: false, drag: null, onDrag: () => {},
      mutate: setManifest, activeElement: null, onActiveElement: () => {}, onAddCard: () => {}, onResetCard: () => {}, savedCardIds: new Set<string>()
    }))
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(Harness)))
  const image = container.querySelector('[data-element-id="image"]')!, text = container.querySelector('[data-element-id="text"]')!
  const button = (element: Element, label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent === label)!
  await act(async () => button(image, '↑ Move up').click())
  expect(container.querySelector('[data-element-id]')).toBe(image)
  expect(image.querySelector('.author-field.invalid')).not.toBeNull()
  expect(text.querySelector('.author-field.invalid')).toBeNull()
  await act(async () => button(image, 'Upload attachment').click())
  expect(upload).toHaveBeenCalledWith('course', 'image', false)
  expect(latest!.modules[0].lessons![0].blocks[0]).toMatchObject({ nodeId: 'image', src: 'assets/photo.png' })
  expect(text.querySelector('textarea')!.value).toBe('Keep me')
})
