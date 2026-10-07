import type { Block, CourseManifest, Flashcard, Lesson, Module } from './types'
import { duplicateElement } from './course-document'
import { availableBlockSlug } from './block-slugs'

export type OutlineElement = Module | Lesson | Block | Flashcard
export interface EditorLocation { element: OutlineElement; siblings: OutlineElement[]; index: number; parentId: string | null; kind: 'module' | 'lesson' | 'block' | 'flashcard' }
export function locateElement(manifest: CourseManifest, id: string): EditorLocation | undefined {
  for (const [index, module] of manifest.modules.entries()) {
    if (module.nodeId === id) return { element: module, siblings: manifest.modules, index, parentId: null, kind: 'module' }
    if (module.type === 'project') continue
    for (const [index, lesson] of module.lessons.entries()) {
      if (lesson.nodeId === id) return { element: lesson, siblings: module.lessons, index, parentId: module.nodeId!, kind: 'lesson' }
      for (const [index, block] of lesson.blocks.entries()) if (block.nodeId === id) return { element: block, siblings: lesson.blocks, index, parentId: lesson.nodeId!, kind: 'block' }
      for (const [index, card] of (lesson.flashcards ?? []).entries()) if (card.nodeId === id) return { element: card, siblings: lesson.flashcards!, index, parentId: lesson.nodeId!, kind: 'flashcard' }
    }
  }
  return undefined
}
export function editElement(manifest: CourseManifest, id: string, fields: Record<string, unknown>): CourseManifest {
  const copy = structuredClone(manifest)
  const location = locateElement(copy, id)
  if (location) Object.assign(location.element, fields)
  return copy
}
export function deleteElement(manifest: CourseManifest, id: string): CourseManifest {
  const copy = structuredClone(manifest)
  const location = locateElement(copy, id)
  location?.siblings.splice(location.index, 1)
  return copy
}
export function reorderElement(manifest: CourseManifest, id: string, direction: -1 | 1): CourseManifest {
  const copy = structuredClone(manifest)
  const location = locateElement(copy, id)
  if (!location) return copy
  const next = location.index + direction
  if (next < 0 || next >= location.siblings.length) return copy
  const [element] = location.siblings.splice(location.index, 1)
  location.siblings.splice(next, 0, element)
  return copy
}
export function moveElement(manifest: CourseManifest, id: string, parentId: string): CourseManifest {
  const copy = structuredClone(manifest)
  const location = locateElement(copy, id)
  const parent = locateElement(copy, parentId)
  if (!location || !parent) return copy
  if (location.kind === 'lesson' && parent.kind === 'module' && 'lessons' in parent.element && parent.element.type !== 'project') {
    const [element] = location.siblings.splice(location.index, 1)
    parent.element.lessons.push(element as Lesson)
  } else if (location.kind === 'block' && parent.kind === 'lesson' && 'blocks' in parent.element) {
    const [element] = location.siblings.splice(location.index, 1)
    parent.element.blocks.push(element as Block)
  } else if (location.kind === 'flashcard' && parent.kind === 'lesson' && 'blocks' in parent.element) {
    if (location.parentId !== parentId) throw new Error('Flashcards are bound to their lesson. Create a new card in the other lesson and delete this one.')
    const [element] = location.siblings.splice(location.index, 1)
    ;(parent.element.flashcards ??= []).push(element as Flashcard)
  }
  return copy
}
export function copyElement(manifest: CourseManifest, id: string, uuid: () => string): { manifest: CourseManifest; id: string } {
  const copy = structuredClone(manifest)
  const location = locateElement(copy, id)
  if (!location) return { manifest: copy, id }
  const duplicate = duplicateElement(location.element, uuid)
  if (location.kind === 'block') {
    const block = duplicate as Block
    block.slug = availableBlockSlug(`${(location.element as Block).slug || block.type}-copy`, (location.siblings as Block[]).map((b) => b.slug))
  }
  location.siblings.splice(location.index + 1, 0, duplicate)
  return { manifest: copy, id: duplicate.nodeId! }
}
export function newBlock(type: Block['type'], uuid: () => string, siblings: readonly Block[] = []): Block {
  const nodeId = uuid()
  const suffix = nodeId.replace(/[^a-z0-9]/gi, '').slice(-12)
  const slug = availableBlockSlug(type, siblings.map((block) => block.slug))
  switch (type) {
    case 'markdown': return { nodeId, slug, type, content: '' }
    case 'image': return { nodeId, slug, type, src: '', alt: '' }
    case 'video': return { nodeId, slug, type, src: '' }
    case 'visualization': return { nodeId, slug, type, src: '', title: '', height: 480 }
    case 'quiz': return { nodeId, slug, type, id: `quiz-${suffix}`, kind: 'single', question: '', options: [true, false].map((correct, index) => ({ nodeId: uuid(), id: `option-${index + 1}`, text: '', correct })) }
    case 'exercise': return { nodeId, slug, type, id: `exercise-${suffix}`, title: 'New exercise', prompt: '', starter_code: '', verification_instructions: '' }
  }
}
