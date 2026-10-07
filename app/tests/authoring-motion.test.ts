import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diffText } from '../src/renderer/authoring/text-diff'
import { captureMotion, playMotion } from '../src/renderer/authoring/motion'
import { useAuthoringMotion } from '../src/renderer/authoring/useAuthoringMotion'
import type { CourseManifest } from '../src/core/types'

describe('AI word changes', () => {
  const changes = (before: string, after: string) => {
    const result = diffText(before, after)
    return { removed: result.removed.map(range => before.slice(range.start, range.end)), added: result.added.map(range => after.slice(range.start, range.end)) }
  }
  it('isolates separate edits while keeping intervening text, whitespace and Unicode intact', () => {
    expect(changes('The old compiler keeps this sentence and produces code.', 'The new compiler keeps this sentence and produces objects.'))
      .toEqual({ removed: ['old', 'code'], added: ['new', 'objects'] })
    expect(changes('Café 😀 stays\nunchanged.', 'Café 😀 stays\nunchanged.')).toEqual({ removed: [], added: [] })
    expect(changes('Use **types**.', 'Use **types** and values.')).toEqual({ removed: [], added: [' and values'] })
    expect(changes('Remove this paragraph.', '')).toEqual({ removed: ['Remove this paragraph.'], added: [] })
  })
  it('reads a rewrite as one change rather than a scatter of surviving words, and says what it kept', () => {
    const before = 'A compiler reads your source code and turns it into machine instructions. The process happens in stages.'
    const after = 'A compiler is a translator: it reads source code, checks that it means something, and produces instructions a processor can run. Each stage hands a richer structure to the next.'
    expect(changes(before, after)).toEqual({ removed: ['reads your source code and turns it into machine instructions. The process happens in stages'],
      added: ['is a translator: it reads source code, checks that it means something, and produces instructions a processor can run. Each stage hands a richer structure to the next'] })
    const { kept } = diffText(before, after)
    expect(kept.map(run => [before.slice(run.before, run.before + run.length), after.slice(run.after, run.after + run.length)])).toEqual([['A compiler ', 'A compiler '], ['.', '.']])
  })
  it('keeps a large unchanged middle between distant edits', () => {
    const middle = Array.from({ length: 1600 }, (_, i) => `stable${i}`).join(' ')
    expect(changes(`old ${middle} gone`, `new ${middle} added`)).toEqual({ removed: ['old', 'gone'], added: ['new', 'added'] })
  })
})

let root: Root | undefined, host: HTMLDivElement
const rect = new DOMRect(20, 30, 600, 400)
const preference = new EventTarget() as EventTarget & { matches: boolean }
const animate = vi.fn()
let highlights: Map<string, Set<Range>>
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  preference.matches = false
  vi.stubGlobal('matchMedia', () => preference)
  highlights = new Map(); vi.stubGlobal('CSS', { highlights }); vi.stubGlobal('Highlight', class extends Set<Range> {})
  animate.mockReset().mockImplementation(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [new DOMRect(30, 50, 50, 20)] })
  host = document.createElement('div'); document.body.append(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  delete (Range.prototype as unknown as Record<string, unknown>).getClientRects
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate
})
describe('AI edit motion', () => {
  it('animates only changed words and rows, retains real content and cleans overlays/highlights', () => {
    host.innerHTML = '<section><div data-authoring-preview-key="text"><p>Keep <strong>old</strong> wording.</p><p>Unchanged paragraph.</p></div></section><aside><div data-authoring-outline-id="text">text</div><div data-authoring-outline-id="deleted">deleted</div></aside>'
    const preview = host.querySelector('section')!, outline = host.querySelector('aside')!
    const snapshot = captureMotion(preview, outline)
    preview.querySelector('strong')!.textContent = 'new'
    outline.querySelector('[data-authoring-outline-id="deleted"]')!.remove()
    const added = document.createElement('div'); added.dataset.authoringOutlineId = 'added'; added.textContent = 'added'; outline.append(added)
    const stable = preview.querySelectorAll('p')[1], strong = preview.querySelector('strong')!
    const clear = playMotion(snapshot, preview, outline, new Set(['text']), true)
    expect([...preview.querySelectorAll('.departing')].map(el => el.textContent)).toEqual(['old'])
    expect([...preview.querySelectorAll('.arriving')].map(el => el.textContent)).toEqual(['new'])
    expect(preview.querySelectorAll('p')[1]).toBe(stable); expect(preview.querySelector('strong')).toBe(strong)
    expect([...highlights.values()][0].size).toBe(1)
    expect(outline.textContent).toContain('Updated'); expect(outline.textContent).toContain('Removed'); expect(outline.textContent).not.toContain('Added')
    expect((animate.mock.calls[animate.mock.contexts.indexOf(added)][0] as Keyframe[])[0].opacity).toBe(0)
    expect(outline.querySelector('.authoring-motion-overlay')?.getAttribute('aria-hidden')).toBe('true')
    clear()
    expect(highlights.size).toBe(0); expect(host.querySelector('[data-authoring-motion-overlay]')).toBeNull()
    expect(host.querySelector('.authoring-motion-badge')).toBeNull(); expect(strong.textContent).toBe('new')
  })
  it('never clones live frames and dissolves removed media using an inert placeholder', () => {
    host.innerHTML = '<section><div data-authoring-preview-key="viz"><iframe src="about:blank"></iframe></div></section><aside></aside>'
    const preview = host.querySelector('section')!, outline = host.querySelector('aside')!
    const snapshot = captureMotion(preview, outline)
    preview.querySelector('iframe')!.remove()
    const clear = playMotion(snapshot, preview, outline, new Set(), true)
    expect(preview.querySelector('iframe')).toBeNull()
    expect(preview.querySelector('.authoring-motion-media-placeholder')?.textContent).toBe('Visualization')
    vi.advanceTimersByTime(1600)
    expect(preview.querySelector('[data-authoring-motion-overlay]')).toBeNull(); expect(highlights.size).toBe(0)
    clear()
  })
  it('reveals a rewritten list whole and lets the old bullets leave with their words', () => {
    host.innerHTML = '<section><div data-authoring-preview-key="b"><ul><li style="list-style: disc outside"><code style="background-color: rgb(1, 2, 3)">lexer</code> splits text into tokens.</li></ul><p>Stays the same.</p></div></section><aside></aside>'
    const preview = host.querySelector('section')!, outline = host.querySelector('aside')!
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(30, 50, 40, 20)] as unknown as DOMRectList)
    const snapshot = captureMotion(preview, outline)
    preview.querySelector('[data-authoring-preview-key]')!.innerHTML = '<ol><li>Groups characters into names and numbers.</li></ol><p>Stays the same.</p>'
    const clear = playMotion(snapshot, preview, outline, new Set(), true)
    // Nothing of the new list is drawn word by word, so its marker cannot stand there empty.
    expect(preview.querySelectorAll('.arriving')).toHaveLength(0)
    const reveal = animate.mock.calls.findIndex(([frames]) => (frames as Keyframe[])[0].maskImage)
    expect(animate.mock.contexts[reveal]).toBe(preview.querySelector('ol'))
    expect([...preview.querySelectorAll('.departing')].map(el => el.textContent)).toEqual(expect.arrayContaining(['\u2022 ', 'lexer', 'splits', 'tokens.']))
    expect((preview.querySelector('.authoring-motion-box') as HTMLElement).style.backgroundColor).toBe('rgb(1, 2, 3)')
    clear(); expect(preview.querySelector('[data-authoring-motion-overlay]')).toBeNull()
  })
  it('moves an unchanged paragraph down to where an edit above pushed it', () => {
    // Each element and word sits at its data-y, so the edit can move one.
    const at = (node: Node | null): number => Number((node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-y]')?.dataset.y ?? 30)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.matches('section, aside') ? rect : new DOMRect(30, at(this), 400, 20) })
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value(this: Range) { return [new DOMRect(30, at(this.startContainer), 50, 20)] } })
    host.innerHTML = '<section><div data-authoring-preview-key="b"><p data-y="50">Short.</p><p data-y="80">Stays the same.</p></div></section><aside></aside>'
    const preview = host.querySelector('section')!, outline = host.querySelector('aside')!
    const snapshot = captureMotion(preview, outline)
    preview.querySelector('[data-authoring-preview-key]')!.innerHTML = '<p data-y="50">A much longer opening that wraps.</p><p data-y="120">Stays the same.</p>'
    const clear = playMotion(snapshot, preview, outline, new Set(), true)
    const moved = animate.mock.contexts.indexOf(preview.querySelectorAll('p')[1])
    expect((animate.mock.calls[moved][0] as Keyframe[])[0].transform).toBe('translate(0px, -40px)')
    expect([...preview.querySelectorAll('.arriving, .departing')].map(el => el.textContent)).not.toContain('Stays')
    clear()
  })
  it('only animates AI updates, handles interruptions and stops on reduced motion or navigation', async () => {
    const initial: CourseManifest = { schema_version: '1.4', slug: 'demo', title: 'Demo', modules: [{ nodeId: 'module', slug: 'module', title: 'Module', lessons: [{ nodeId: 'lesson', slug: 'lesson', title: 'Lesson', blocks: [{ nodeId: 'text', slug: 'text', type: 'markdown', content: 'Old text' }] }] }] }
    let update: (value: string, ai: boolean) => void, setMode: (mode: 'manual' | 'ai') => void, select: (id: string) => void
    function DelayedText({ content }: { content: string }) {
      const [displayed, setDisplayed] = useState(content)
      // CodeMirror synchronizes external documents in a passive effect too.
      useEffect(() => setDisplayed(content), [content])
      return createElement('p', { 'data-authoring-preview-key': 'text' }, displayed)
    }
    function Harness() {
      const [manifest, setManifest] = useState(initial), [mode, changeMode] = useState<'manual' | 'ai'>('ai'), [selected, setSelected] = useState('text')
      const motion = useAuthoringMotion(manifest, selected, mode)
      setMode = changeMode; select = setSelected
      update = (content, ai) => {
        const next = structuredClone(manifest); Object.assign(next.modules[0].lessons![0].blocks[0], { content })
        motion.prepare(manifest, next, ai); setManifest(next)
      }
      return createElement('div', null,
        createElement('section', { ref: motion.previewRef }, createElement(DelayedText, { content: (manifest.modules[0].lessons![0].blocks[0] as { content: string }).content })),
        createElement('aside', { ref: motion.outlineRef }, createElement('div', { 'data-authoring-outline-id': 'text' }, 'text')))
    }
    root = createRoot(host); await act(async () => root!.render(createElement(Harness)))
    expect(animate).not.toHaveBeenCalled()
    await act(async () => update!('Manual replacement', false)); expect(animate).not.toHaveBeenCalled()
    await act(async () => update!('AI replacement', true)); await act(async () => vi.advanceTimersByTime(20)); expect(host.querySelector('.arriving')).toBeTruthy()
    await act(async () => update!('Latest replacement', true))
    await act(async () => vi.advanceTimersByTime(20))
    expect([...host.querySelectorAll('.arriving')].map(el => el.textContent)).toEqual(['Latest'])
    expect(host.querySelectorAll('section > .authoring-motion-overlay')).toHaveLength(1)
    preference.matches = true; preference.dispatchEvent(new Event('change'))
    expect(host.querySelector('[data-authoring-motion-overlay]')).toBeNull(); expect(highlights.size).toBe(0)
    animate.mockClear(); await act(async () => update!('Reduced motion edit', true)); expect(animate).not.toHaveBeenCalled()
    preference.matches = false; await act(async () => setMode!('manual'))
    await act(async () => update!('Manual mode edit', true)); expect(animate).not.toHaveBeenCalled()
    await act(async () => setMode!('ai')); await act(async () => update!('Another AI edit', true)); await act(async () => vi.advanceTimersByTime(20))
    await act(async () => select!('lesson')); expect(highlights.size).toBe(0)
    expect(host.querySelector('[data-authoring-motion-overlay]')).toBeNull()
  })
})
