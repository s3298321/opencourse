import { Fragment, useEffect, useRef, useState } from 'react'
import type { DragEvent, JSX } from 'react'
import type { Block, CourseManifest, Lesson } from '@core/types'
import { copyElement, deleteElement, editElement, insertLessonBlock, moveLessonBlock, newBlock, reorderElement } from '@core/course-editor'
import { newDraftRef } from '@core/course-document'
import BlockTypeIcon, { blockTypeLabels } from '../components/BlockTypeIcon'
import { EditorValidation, ElementFields } from './CourseEditorFields'

export const elementKinds: Block['type'][] = ['markdown', 'python-cell', 'image', 'video', 'visualization', 'quiz', 'exercise']
export type ElementDrag = { type: Block['type'] } | { id: string; lessonId: string }
export function beginElementDrag(event: DragEvent, value: ElementDrag, start: (value: ElementDrag | null) => void): void {
  event.dataTransfer.setData('application/x-opencourse-element', JSON.stringify(value))
  event.dataTransfer.effectAllowed = 'type' in value ? 'copy' : 'move'
  start(value)
}

export function ElementsPalette({ enabled, onDrag }: {
  enabled: boolean; onDrag: (value: ElementDrag | null) => void
}): JSX.Element {
  return <div className="elements-palette">
    <p className="meta">{enabled ? 'Drag an element into the lesson.' : 'Select a lesson in Outline to add elements.'}</p>
    {elementKinds.map(type => <div className="element-palette-item" key={type}>
      <button className="element-palette-drag" aria-label={`Drag ${blockTypeLabels[type]}`} disabled={!enabled} draggable={enabled}
        onDragStart={event => beginElementDrag(event, { type }, onDrag)} onDragEnd={() => onDrag(null)}>
        <BlockTypeIcon type={type} /><span>{blockTypeLabels[type]}</span><span aria-hidden="true">⠿</span>
      </button>
    </div>)}
  </div>
}

export default function CourseLessonWorkspace({ lesson, manifest, courseId, path, errors, locked, drag, onDrag, mutate, activeElement, onActiveElement, onAddCard, onResetCard, savedCardIds }: {
  lesson: Lesson; manifest: CourseManifest; courseId: string; path: string; errors: string[]; locked: boolean
  drag: ElementDrag | null; onDrag: (value: ElementDrag | null) => void
  mutate: (change: (manifest: CourseManifest) => CourseManifest) => void
  activeElement: string | null; onActiveElement: (id: string | null) => void
  onAddCard: () => void; onResetCard: (id: string) => void; savedCardIds: Set<string>
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [boundary, setBoundary] = useState<number | null>(null)
  const pointerY = useRef<number | null>(null)
  const validDrag = !locked && drag && ('type' in drag || drag.lessonId === lesson.nodeId)
  useEffect(() => {
    if (!activeElement) return
    setCollapsed(previous => { const next = new Set(previous); next.delete(activeElement); return next })
    const frame = requestAnimationFrame(() => {
      const element = [...(root.current?.querySelectorAll<HTMLElement>('[data-element-id]') ?? [])].find(item => item.dataset.elementId === activeElement)
      element?.scrollIntoView?.({ block: 'nearest' })
      element?.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [activeElement])
  useEffect(() => {
    if (!validDrag) { setBoundary(null); pointerY.current = null; return }
    let frame = 0
    const scroll = (): void => {
      const pane = root.current?.closest<HTMLElement>('.author-form')
      if (pane && pointerY.current !== null) {
        const rect = pane.getBoundingClientRect(), y = pointerY.current
        if (y < rect.top + 60) pane.scrollTop -= Math.min(18, (rect.top + 60 - y) / 3)
        else if (y > rect.bottom - 60) pane.scrollTop += Math.min(18, (y - rect.bottom + 60) / 3)
      }
      frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [validDrag])
  const drop = (event: DragEvent, index: number): void => {
    if (!validDrag || !drag) return
    event.preventDefault(); event.stopPropagation()
    if ('type' in drag) {
      const result = insertLessonBlock(manifest, lesson.nodeId!, drag.type, index, newDraftRef)
      mutate(() => result.manifest); if (result.id) onActiveElement(result.id)
    } else {
      mutate(current => moveLessonBlock(current, lesson.nodeId!, drag.id, index))
      onActiveElement(drag.id)
    }
    setBoundary(null); onDrag(null)
  }
  const over = (event: DragEvent, index: number): void => {
    if (!validDrag || !drag) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'type' in drag ? 'copy' : 'move'
    pointerY.current = event.clientY; setBoundary(index)
  }
  const dropZone = (index: number): JSX.Element => <div className={`lesson-drop-zone${boundary === index && validDrag ? ' active' : ''}${index === lesson.blocks.length ? ' append' : ''}${lesson.blocks.length === 0 ? ' empty' : ''}`}
    data-drop-index={index} onDragOver={event => over(event, index)} onDrop={event => drop(event, index)}>
    {index === lesson.blocks.length ? 'Drag an element here' : <span aria-hidden="true">Drop here</span>}
  </div>
  const actions = (id: string, index: number, count: number): JSX.Element => <>
    <button className="ghost" disabled={locked || index === 0} onClick={() => mutate(current => reorderElement(current, id, -1))}>↑ Move up</button>
    <button className="ghost" disabled={locked || index === count - 1} onClick={() => mutate(current => reorderElement(current, id, 1))}>↓ Move down</button>
    <button className="ghost" disabled={locked} onClick={() => { const result = copyElement(manifest, id, newDraftRef); mutate(() => result.manifest); onActiveElement(result.id) }}>Duplicate</button>
    <button className="ghost" disabled={locked} onClick={() => { mutate(current => deleteElement(current, id)); if (activeElement === id) onActiveElement(null) }}>Delete</button>
  </>
  return <div ref={root} className={`lesson-workspace${validDrag ? ' dragging' : ''}`} onDragLeave={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { pointerY.current = null; setBoundary(null) }
  }}>
    <EditorValidation value={{ path, errors }}><ElementFields element={lesson} manifest={manifest} courseId={courseId} set={fields => mutate(current => editElement(current, lesson.nodeId!, fields))} /></EditorValidation>
    <h2>Elements</h2>
    {lesson.blocks.map((block, index) => <Fragment key={block.nodeId}>
      {dropZone(index)}
      <article className="lesson-element" data-element-id={block.nodeId}
        onDragOver={event => { const rect = event.currentTarget.getBoundingClientRect(); over(event, index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)) }}
        onDrop={event => { const rect = event.currentTarget.getBoundingClientRect(); drop(event, index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)) }}>
        <div className="lesson-element-heading">
          <button className="ghost element-drag-handle" draggable={!locked} disabled={locked} aria-label={`Drag ${blockTypeLabels[block.type]} ${index + 1}`}
            onDragStart={event => beginElementDrag(event, { id: block.nodeId!, lessonId: lesson.nodeId! }, onDrag)} onDragEnd={() => onDrag(null)}>⠿</button>
          <BlockTypeIcon type={block.type} /><strong>{blockTypeLabels[block.type]}</strong>
          <button className="ghost" aria-expanded={!collapsed.has(block.nodeId!)} aria-controls={`element-fields-${block.nodeId}`} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(block.nodeId!)) next.delete(block.nodeId!); else next.add(block.nodeId!); return next
          })}>{collapsed.has(block.nodeId!) ? 'Expand' : 'Collapse'}</button>
        </div>
        <div className="author-element-actions actions">{actions(block.nodeId!, index, lesson.blocks.length)}</div>
        <div id={`element-fields-${block.nodeId}`} hidden={collapsed.has(block.nodeId!)}>
          <EditorValidation value={{ path: `${path}/blocks/${index}`, errors }}>
            <ElementFields element={block} manifest={manifest} courseId={courseId} set={fields => mutate(current => editElement(current, block.nodeId!, fields))} />
          </EditorValidation>
          <details className="author-section"><summary>Change element type</summary>
            <label className="author-action-field">Replacing the type clears this element’s content.
              <select aria-label="Change block type" value={block.type} onChange={event => {
                const replacement = newBlock(event.target.value as Block['type'], newDraftRef, lesson.blocks)
                mutate(current => editElement(current, lesson.nodeId!, { blocks: lesson.blocks.map(entry => entry.nodeId === block.nodeId ? replacement : entry) })); onActiveElement(replacement.nodeId!)
              }}>{elementKinds.map(type => <option value={type} key={type}>{blockTypeLabels[type]}</option>)}</select>
            </label>
          </details>
        </div>
      </article>
    </Fragment>)}
    {dropZone(lesson.blocks.length)}
    <section className="lesson-flashcards" aria-label="Lesson flashcards"><h2>Flashcards</h2>
      {(lesson.flashcards ?? []).map((card, index) => <article className="lesson-element" data-element-id={card.nodeId} key={card.nodeId}>
        <div className="author-element-actions actions">{actions(card.nodeId!, index, lesson.flashcards!.length)}
          {savedCardIds.has(card.nodeId!) && <button className="ghost" disabled={locked} onClick={() => onResetCard(card.nodeId!)}>Reset review progress</button>}
        </div>
        <EditorValidation value={{ path: `${path}/flashcards/${index}`, errors }}><ElementFields element={card} manifest={manifest} courseId={courseId} set={fields => mutate(current => editElement(current, card.nodeId!, fields))} /></EditorValidation>
      </article>)}
      <button className="secondary" disabled={locked} onClick={onAddCard}>+ Add card</button>
    </section>
  </div>
}
