import { createRoot, type Root } from 'react-dom/client'
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { sketchLine, type Sketch, type SketchSettings } from '@core/writing-notebooks/sketch'
import { SketchAssets } from './sketch-assets'
import { SketchCanvas, type SketchHistory } from './SketchCanvas'

const activate = StateEffect.define<number | null>()
const activeSketch = StateField.define<{ at: number; session: object } | null>({
  create: () => null,
  update(active, tr) {
    for (const effect of tr.effects) if (effect.is(activate)) return effect.value === null ? null : { at: effect.value, session: {} }
    if (!active) return null
    const pos = tr.changes.mapPos(active.at)
    const line = tr.state.doc.lineAt(pos)
    if (!sketchLine.test(line.text) || (tr.selection && tr.state.doc.lineAt(tr.selection.main.head).from !== line.from)) return null
    return line.from === active.at ? active : { ...active, at: line.from }
  }
})
const mounts = new WeakMap<HTMLElement, Root>()
class SketchWidget extends WidgetType {
  constructor(readonly assets: SketchAssets, readonly asset: string, readonly session: object | undefined, readonly history: SketchHistory, readonly save: () => void) { super() }
  eq(other: SketchWidget) { return this.asset === other.asset && this.session === other.session && this.assets === other.assets && this.history === other.history }
  render(host: HTMLElement, view: EditorView) {
    const line = () => view.state.doc.lineAt(view.posAtDOM(host))
    const activeLine = () => {
      const active = view.state.field(activeSketch)
      return active && active.session === this.session ? view.state.doc.lineAt(active.at) : undefined
    }
    const currentAsset = () => sketchLine.exec(activeLine()?.text ?? '')?.[1]
    const replace = (expected: string, next: string) => {
      const here = activeLine()
      if (!here || sketchLine.exec(here.text)?.[1] !== expected) return false
      const from = here.from + here.text.lastIndexOf(expected)
      view.dispatch({ changes: { from, to: from + expected.length, insert: next }, annotations: isolateHistory.of('full') })
      return true
    }
    mounts.get(host)!.render(<SketchCanvas history={this.history} active={!!this.session} asset={this.asset} assets={this.assets}
      currentAsset={currentAsset} replace={replace}
      open={() => { const at = line().from; view.dispatch({ selection: { anchor: at }, effects: activate.of(at) }) }}
      exit={() => {
        const here = line(), last = here.number === view.state.doc.lines
        view.dispatch({ changes: last ? { from: here.to, insert: '\n' } : undefined, selection: { anchor: here.to + 1 }, effects: activate.of(null), scrollIntoView: true })
        view.focus()
      }}
      measure={() => view.requestMeasure()} save={this.save} />)
  }
  toDOM(view: EditorView) {
    const host = document.createElement('span')
    host.className = 'writing-sketch'
    host.contentEditable = 'false'
    host.addEventListener('click', event => {
      if (event.target === host) {
        const at = view.state.doc.lineAt(view.posAtDOM(host)).from
        view.dispatch({ selection: { anchor: at }, effects: activate.of(at) })
      }
    })
    mounts.set(host, createRoot(host))
    this.render(host, view)
    return host
  }
  updateDOM(host: HTMLElement, view: EditorView, old: SketchWidget) {
    // Active gestures update one mounted canvas. Never transfer tool history to another line.
    if (!this.session || this.session !== old.session || this.assets !== old.assets) return false
    this.render(host, view)
    return true
  }
  destroy(host: HTMLElement) {
    const root = mounts.get(host)
    mounts.delete(host)
    if (root) queueMicrotask(() => root.unmount())
  }
}

export function sketchExtensions(assets: SketchAssets, save: () => void) {
  function build(state: EditorState, previous = Decoration.none) {
    const ranges: Range<Decoration>[] = []
    syntaxTree(state).iterate({ enter(node) {
      if (node.name !== 'Image') return
      const line = state.doc.lineAt(node.from)
      if (line.from !== node.from || line.to !== node.to) return
      const asset = sketchLine.exec(line.text)?.[1]
      if (!asset) return
      const active = state.field(activeSketch)
      const session = line.from === active?.at ? active.session : undefined
      let history: SketchHistory = { undo: [], redo: [] }
      // Keep gesture history for this occurrence across blur, theme refreshes and edits above it.
      // A pasted copy gets its own history, even when both links still point at the same SVG.
      previous.between(line.from, line.from, (from, _to, decoration) => {
        const old = decoration.spec.widget as SketchWidget
        if (from === line.from && (old.asset === asset || (session && session === old.session))) history = old.history
      })
      const widget = new SketchWidget(assets, asset, session, history, save)
      ranges.push(Decoration.replace({ widget }).range(line.from, line.to))
      return false
    } })
    return Decoration.set(ranges)
  }
  const decorations = StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => tr.docChanged || tr.startState.field(activeSketch) !== tr.state.field(activeSketch) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ? build(tr.state, value.map(tr.changes)) : value,
    provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))]
  })
  return [activeSketch, decorations, EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element)) return false
      const line = event.target.closest('.cm-line')
      if (!line?.querySelector('.writing-sketch') || event.target.closest('.writing-sketch')) return false
      const at = view.state.doc.lineAt(view.posAtDOM(line)).from
      view.dispatch({ selection: { anchor: at }, effects: activate.of(at) })
      event.preventDefault()
      return true
    }
  })]
}

export function sketchKeymap(settings: SketchSettings, assets: SketchAssets) {
  return keymap.of([{ key: settings.shortcut, run(view) {
    const state = view.state, line = state.doc.lineAt(state.selection.main.head)
    for (let node = syntaxTree(state).resolveInner(line.from, 1); node; node = node.parent!) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false
    }
    const blank = !line.text.trim(), at = blank ? line.from : line.to + 1
    const model: Sketch = { version: 1, width: settings.width, height: settings.height, marks: [] }
    const source = `![Sketch](${assets.stage(model)})`
    view.dispatch({ changes: { from: blank ? line.from : line.to, to: line.to, insert: (blank ? '' : '\n') + source },
      effects: activate.of(at), selection: { anchor: at }, scrollIntoView: true, annotations: isolateHistory.of('full') })
    return true
  } }])
}
export function dismissSketch(view: EditorView, target: EventTarget | null) {
  if (view.state.field(activeSketch) !== null && !(target instanceof Element && target.closest('.writing-sketch'))) {
    view.dispatch({ effects: activate.of(null) })
  }
}
