import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { copyElement, deleteElement, editElement, locateElement, moveElement } from '../src/core/course-editor'
import { courseNodes, identifyManifest, learningManifest, portableManifest } from '../src/core/course-document'
import { referencedAssets, buildCourse } from '../src/core/manifest'
import { authoringManifest, parseAuthoringManifest, authoringContext } from '../src/core/authoring/document'
import { validateManifest } from '../src/core/schema'
import type { CourseManifest, Flashcard } from '../src/core/types'

const manifest = (): CourseManifest => ({ schema_version: '1.4', slug: 'cards', title: 'Cards', modules: [{ slug: 'one', title: 'One', lessons: [
  { slug: 'intro', title: 'Intro', blocks: [], flashcards: [{ id: 'first', question: 'Question?', answer: '**Answer**', image: { src: 'assets/card.svg', alt: 'Diagram' } }] },
  { slug: 'later', title: 'Later', blocks: [] }
] }] })
describe('flashcard format and identities', () => {
  it('accepts cards only in 1.4 and still accepts legacy courses without cards', () => {
    expect(validateManifest(manifest())).toEqual([])
    for (const schema_version of ['1.0', '1.1', '1.2', '1.3']) {
      const source = { ...manifest(), schema_version }
      expect(validateManifest(source).join(' ')).toContain('require schema_version 1.4')
      delete source.modules[0].lessons![0].flashcards
      expect(validateManifest(source)).toEqual([])
    }
  })
  it.each(['id', 'question', 'answer'] as const)('rejects missing and blank %s', field => {
    for (const value of [undefined, '', ' \n\t']) {
      const source = manifest()
      ;(source.modules[0].lessons![0].flashcards![0] as unknown as Record<string, unknown>)[field] = value
      expect(validateManifest(source).length).toBeGreaterThan(0)
    }
  })
  it('rejects duplicate archive IDs and unsafe images', () => {
    const source = manifest(), cards = source.modules[0].lessons![0].flashcards!
    cards.push({ ...cards[0] })
    expect(validateManifest(source).join(' ')).toContain('duplicate flashcard id')
    cards.pop(); cards[0].image!.src = '../outside.svg'
    expect(validateManifest(source).length).toBeGreaterThan(0)
  })
  it('binds cards to their lessons, preserves IDs through edits and strips local IDs on export', () => {
    const source = identifyManifest(manifest(), randomUUID), lessons = source.modules[0].lessons!, card = lessons[0].flashcards![0]
    expect(courseNodes(source).find(node => node.id === card.nodeId)).toMatchObject({ kind: 'flashcard', parentId: lessons[0].nodeId })
    expect(() => moveElement(source, card.nodeId!, lessons[1].nodeId!)).toThrow('bound to their lesson')
    const edited = editElement(source, card.nodeId!, { question: 'Edited?' })
    expect(locateElement(edited, card.nodeId!)?.parentId).toBe(lessons[0].nodeId)
    expect(learningManifest(edited).modules[0].lessons![0].flashcards![0].id).toBe(card.nodeId)
    expect(JSON.stringify(portableManifest(edited))).not.toContain('nodeId')
    const duplicated = copyElement(edited, card.nodeId!, randomUUID)
    expect(duplicated.id).not.toBe(card.nodeId)
    expect((locateElement(duplicated.manifest, duplicated.id)!.element as Flashcard).id).not.toBe(card.id)
    expect(locateElement(deleteElement(edited, lessons[0].nodeId!), card.nodeId!)).toBeUndefined()
    const reassigned = authoringManifest(source)
    reassigned.modules[0].lessons![1].flashcards = reassigned.modules[0].lessons![0].flashcards
    reassigned.modules[0].lessons![0].flashcards = []
    expect(() => parseAuthoringManifest(reassigned, source)).toThrow('bound to their lesson')
  })
  it('collects and resolves question image attachments', () => {
    expect(referencedAssets(manifest())).toEqual(['assets/card.svg'])
    expect(buildCourse(manifest(), '/tmp', path => `resolved:${path}`).modules[0].lessons![0].flashcards![0].image?.src).toBe('resolved:assets/card.svg')
  })
  it('round trips authoring refs and allows unfinished draft questions/answers', () => {
    const source = identifyManifest(manifest(), randomUUID), card = source.modules[0].lessons![0].flashcards![0]
    const authored = authoringManifest(source); authored.modules[0].lessons![0].flashcards![0].answer = ''
    expect(parseAuthoringManifest(authored, source).modules[0].lessons![0].flashcards![0].nodeId).toBe(card.nodeId)
    expect(authoringContext(source, { kind: 'flashcard', ref: card.nodeId! }, 1).outline.some(node => node.kind === 'flashcard')).toBe(true)
  })
})
