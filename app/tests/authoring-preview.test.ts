import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockPreview, FlashcardPreview, LessonPreview } from '../src/renderer/routes/CourseEditorPreview'
import type { Block, CourseManifest, ExerciseBlock, QuizBlock } from '../src/core/types'

vi.mock('../src/renderer/markdown-context', async () => {
  const { default: MarkdownIt } = await import('markdown-it')
  const md = new MarkdownIt()
  return { useMarkdown: () => md }
})
vi.mock('../src/renderer/workbench/CodeEditor', () => ({ default: ({ value, readOnly, ariaLabel, onChange }: { value: string; readOnly: boolean; ariaLabel: string; onChange: (content: string) => void }) => createElement('textarea', { value, readOnly, 'aria-label': ariaLabel, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }) }))
let root: Root | undefined
let container: HTMLDivElement
const learner = { submitQuiz: vi.fn(), getSolution: vi.fn(), setExerciseDone: vi.fn(), openExercise: vi.fn() }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.values(learner).forEach(mock => mock.mockReset())
  vi.stubGlobal('opencourse', { ...learner, resolveAuthoringAsset: vi.fn(async (id: string, path: string) => `opencourse://draft/${id}/${path}`) })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root!.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals() })
const render = async (block: Block) => act(async () => root!.render(createElement(BlockPreview, { block, courseId: 'draft' })))
const click = async (text: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click())
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const quiz: QuizBlock = { type: 'quiz', nodeId: 'quiz', slug: 'check', id: 'q', kind: 'single', question: '**Which value?**', options: [{ id: 'wrong', text: 'One', correct: false }, { id: 'right', text: 'Two', correct: true }], explanation: 'The answer is **two**.' }
const exercise: ExerciseBlock = { type: 'exercise', nodeId: 'exercise', slug: 'practice', id: 'e', title: 'Practice', prompt: 'Write **code**.', verification_instructions: 'Run the tests.', starter_code: 'print(1)', extra_files: [{ nodeId: 'support', path: 'data.txt', content: 'original data' }], tests: 'assert True', solution: 'print(2)', hints: ['Use `print`.'] }

describe('course authoring previews', () => {
  it('reveals flashcard answers locally and hides them again after content edits', async () => {
    const card = { id: 'card', question: '**Question?**', answer: 'Hidden answer', image: { src: 'diagram.svg', alt: 'Diagram' } }
    await act(async () => root!.render(createElement(FlashcardPreview, { courseId: 'draft', card })))
    expect(container.textContent).not.toContain('Hidden answer')
    expect(container.querySelector('img')?.alt).toBe('Diagram')
    await click('Reveal answer')
    expect(container.textContent).toContain('Hidden answer')
    await act(async () => root!.render(createElement(FlashcardPreview, { courseId: 'draft', card: { ...card, answer: 'Edited answer' } })))
    expect(container.querySelector('.review-answer')).toBeNull()
    for (const mock of Object.values(learner)) expect(mock).not.toHaveBeenCalled()
  })
  it('lets you answer and check a quiz without revealing answers up front or writing progress, and resets after edits', async () => {
    await render(quiz)
    expect(container.querySelector('.quiz .question strong')?.textContent).toBe('Which value?')
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(container.querySelector('.feedback')).toBeNull()
    expect(container.textContent).not.toContain(quiz.explanation)
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click())
    await click('Check answer')
    expect(container.querySelector('.feedback.err')?.textContent).toContain('Not quite.')
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click())
    await click('Check answer')
    expect(container.querySelector('.feedback.ok strong')?.textContent).toBe('Correct.')
    expect(container.querySelector('.explanation strong')?.textContent).toBe('two')
    expect(learner.submitQuiz).not.toHaveBeenCalled()
    await render({ ...quiz, question: 'Updated question' })
    expect(container.querySelector('.feedback')).toBeNull()
    expect(container.querySelectorAll('input:checked')).toHaveLength(0)
  })
  it('checks multiple-choice and text quizzes with the same grading rules as lessons', async () => {
    await render({ ...quiz, kind: 'multiple', options: quiz.options!.map(option => ({ ...option, correct: true })) })
    await act(async () => container.querySelector<HTMLInputElement>('input')!.click())
    await click('Check answers')
    expect(container.querySelector('.feedback.err')).toBeTruthy()
    await act(async () => container.querySelectorAll<HTMLInputElement>('input')[1].click())
    await click('Check answers')
    expect(container.querySelector('.feedback.ok')).toBeTruthy()
    await render({ ...quiz, kind: 'text', options: undefined, answers: ['two'] })
    await type(container.querySelector('input')!, 'The TWO.')
    await click('Check answer')
    expect(container.querySelector('.feedback.ok')).toBeTruthy()
    expect(learner.submitQuiz).not.toHaveBeenCalled()
  })
  it('renders a complete lesson using the lesson header and each block component, with draft media URLs', async () => {
    const lesson = { nodeId: 'lesson', slug: 'learn', title: 'Learn', estimated_minutes: 8, objectives: ['Understand this'], blocks: [
      { nodeId: 'text', slug: 'notes', type: 'markdown', content: '## Key takeaways\n\n**Notes**' } as Block,
      { nodeId: 'image', slug: 'image', type: 'image', src: 'image.png', alt: 'Example', caption: 'Image caption' } as Block,
      { nodeId: 'video', slug: 'video', type: 'video', src: 'movie.mp4', poster: 'poster.png', caption: 'Video caption' } as Block,
      quiz, exercise
    ] }
    const manifest: CourseManifest = { schema_version: '1.3', slug: 'draft', title: 'Draft', modules: [{ nodeId: 'module', slug: 'module', title: 'Module', lessons: [lesson] }] }
    await act(async () => root!.render(createElement(LessonPreview, { lesson, manifest, courseId: 'draft' })))
    expect(container.querySelector('.lesson-head')?.textContent).toContain('Lesson 1 of 1 · about 8 minutesLearn')
    expect(container.querySelector('.objectives li')?.textContent).toBe('Understand this')
    expect(container.querySelector('.block.prose.takeaways strong')?.textContent).toBe('Notes')
    expect(container.querySelector('img')?.src).toBe('opencourse://draft/draft/image.png')
    expect(container.querySelector('img')?.alt).toBe('Example')
    expect(container.querySelector('video')?.src).toBe('opencourse://draft/draft/movie.mp4')
    expect(container.querySelector('video')?.poster).toBe('opencourse://draft/draft/poster.png')
    expect(container.querySelector('video')?.controls).toBe(true)
    expect(container.querySelector('.quiz input')).toBeTruthy()
    expect(container.querySelector('.exercise .prompt strong')?.textContent).toBe('code')
  })
  it('browses and edits preset files in the draft, reflects external changes and locks editing during AI runs', async () => {
    const change = vi.fn(), edit = vi.fn()
    let setBlock: (block: ExerciseBlock) => void, setLocked: (locked: boolean) => void
    function Harness() {
      const [block, update] = useState(exercise), [editable, allow] = useState(false), [locked, lock] = useState(false)
      setBlock = update; setLocked = lock
      return createElement(BlockPreview, { block, courseId: 'draft', editable, locked, onEdit: () => { edit(); allow(true) }, onChange: (ref, fields) => { change(ref, fields); update(value => ({ ...value, ...fields })) } })
    }
    await act(async () => root!.render(createElement(Harness)))
    const buffer = () => container.querySelector<HTMLTextAreaElement>('[role="tabpanel"] textarea')!
    expect(buffer().value).toBe('print(1)'); expect(buffer().readOnly).toBe(true)
    expect(container.textContent).not.toContain('Open editor')
    await click('data.txt')
    expect(buffer().value).toBe('original data')
    await click('Edit file')
    expect(edit).toHaveBeenCalledOnce(); expect(buffer().readOnly).toBe(false)
    await type(buffer(), 'updated data')
    expect(change).toHaveBeenLastCalledWith('exercise', { extra_files: [{ nodeId: 'support', path: 'data.txt', content: 'updated data' }] })
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    await act(async () => tabs[0].click())
    await type(buffer(), 'print(3)')
    expect(change).toHaveBeenLastCalledWith('exercise', { starter_code: 'print(3)' })
    await act(async () => tabs[2].click())
    await type(buffer(), 'assert 1 == 1')
    expect(change).toHaveBeenLastCalledWith('exercise', { tests: 'assert 1 == 1' })
    await act(async () => tabs[3].click())
    await type(buffer(), 'print(4)')
    expect(change).toHaveBeenLastCalledWith('exercise', { solution: 'print(4)' })
    await act(async () => { setLocked!(true); setBlock!({ ...exercise, solution: 'AI replacement' }) })
    expect(buffer().value).toBe('AI replacement'); expect(buffer().readOnly).toBe(true)
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Done editing')!.disabled).toBe(true)
    await click('Show solution')
    expect(container.querySelector('details[open] code')?.textContent).toBe('AI replacement')
    await click('Mark completed')
    expect(container.textContent).toContain('✓ Completed')
    for (const mock of Object.values(learner)) expect(mock).not.toHaveBeenCalled()
  })
  it('uses exercise runtime file names and keeps same-ID quiz radio groups independent in a lesson', async () => {
    await render({ ...exercise, runtime: { language: 'python' } })
    expect(container.querySelector('[role="tab"]')?.textContent).toBe('exercise.py')
    expect(container.querySelector('textarea')?.value).toBe('print(1)')
    const lesson = { nodeId: 'lesson', slug: 'learn', title: 'Learn', blocks: [quiz, { ...quiz, nodeId: 'another', slug: 'another' }] }
    const manifest: CourseManifest = { schema_version: '1.3', slug: 'draft', title: 'Draft', modules: [{ slug: 'module', title: 'Module', lessons: [lesson] }] }
    await act(async () => root!.render(createElement(LessonPreview, { lesson, manifest, courseId: 'draft' })))
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios[0].name).not.toBe(radios[2].name)
    await act(async () => { radios[0].click(); radios[2].click() })
    expect(radios[0].checked).toBe(true); expect(radios[2].checked).toBe(true)
  })
})
