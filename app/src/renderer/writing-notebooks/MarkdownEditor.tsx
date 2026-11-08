import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState, RangeSet, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, WidgetType, keymap, lineNumberMarkers, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type { AskOffer } from '../ask-context'
import { DEFAULT_SKETCH, sketchLine } from '@core/writing-notebooks/sketch'
import { SketchAssets } from './sketch-assets'
import { sketchExtensions, sketchKeymap, dismissSketch } from './sketch-editor'
import { onThemeApplied } from '../theme/events'
const parser = new MarkdownIt({ html: false, linkify: false })
class HeadingNumber extends GutterMarker {
  readonly elementClass: string
  constructor(readonly number: number, readonly level: string) {
    super()
    this.elementClass = `writing-heading writing-h${level}`
  }
  eq(other: HeadingNumber) { return this.number === other.number && this.level === other.level }
  toDOM() {
    const number = document.createElement('span')
    number.className = 'writing-heading-line-number'
    number.textContent = String(this.number)
    return number
  }
}
function headingNumberMarkers(state: EditorState): RangeSet<GutterMarker> {
  const markers: Range<GutterMarker>[] = []
  syntaxTree(state).iterate({ enter(node) {
    if (!/^ATXHeading[1-6]$/.test(node.name)) return
    const line = state.doc.lineAt(node.from)
    markers.push(new HeadingNumber(line.number, node.name.slice(-1)).range(line.from))
  } })
  return RangeSet.of(markers, true)
}
const headingNumbers = StateField.define<RangeSet<GutterMarker>>({
  create: headingNumberMarkers,
  update: (value, tr) => tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? headingNumberMarkers(tr.state) : value,
  provide: field => lineNumberMarkers.from(field)
})
const notebookLineNumbers = [lineNumbers(), headingNumbers]
class Preview extends WidgetType {
  constructor(readonly html: string) { super() }
  eq(other: Preview) { return other.html === this.html }
  toDOM() { const element = document.createElement('span'); element.className = 'writing-preview'; element.innerHTML = DOMPurify.sanitize(this.html); return element }
  ignoreEvent() { return false }
}
class ImagePreview extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super() }
  eq(other: ImagePreview) { return other.src === this.src && other.alt === this.alt }
  toDOM() { const wrap = document.createElement('span'), image = document.createElement('img'); wrap.className = 'writing-image'; image.src = this.src; image.alt = this.alt; image.onload = () => { const view = EditorView.findFromDOM(wrap); view?.requestMeasure() }; wrap.append(image); return wrap }
  ignoreEvent() { return false }
}
function livePreview(notebookId: string) {
  const build = (state: EditorState): DecorationSet => {
    const decorations: Range<Decoration>[] = [], lines = new Set<number>()
    const active = (from: number, to: number) => state.selection.ranges.some(r => r.from <= to && r.to >= from)
    syntaxTree(state).iterate({ enter(node) {
      const { name, from, to } = node, source = state.doc.sliceString(from, to), editing = active(from, to)
      if (name === 'Table' && !editing) { decorations.push(Decoration.replace({ widget: new Preview(parser.render(source)), block: true }).range(from, to)); return false }
      if (name === 'Image' && sketchLine.test(source) && state.doc.lineAt(from).text === source) return false
      if (name === 'Image' && !editing) {
        const match = source.match(/^!\[([^\]]*)\]\((assets\/[0-9a-f-]+\.(?:png|jpg|webp|gif))(?:\s+"[^"]*")?\)$/i)
        if (match) { decorations.push(Decoration.replace({ widget: new ImagePreview(`opencourse://writing-notebooks/${notebookId}/${match[2]}`, match[1]!) }).range(from, to)); return false }
      }
      if (name === 'HorizontalRule' && !editing) { decorations.push(Decoration.replace({ widget: new Preview('<hr>') }).range(from, to)); return false }
      const style = name === 'StrongEmphasis' ? 'writing-bold' : name === 'Emphasis' ? 'writing-italic' : name === 'Strikethrough' ? 'writing-strike' : name === 'InlineCode' ? 'writing-code' : name === 'Link' ? 'writing-link' : null
      if (style) decorations.push(Decoration.mark({ class: style }).range(from, to))
      if (/^ATXHeading[1-6]$/.test(name) || name === 'Blockquote' || name === 'FencedCode' || name === 'CodeBlock' || name === 'ListItem') {
        const line = state.doc.lineAt(from)
        if (!lines.has(line.from)) { lines.add(line.from); decorations.push(Decoration.line({ class: name.startsWith('ATX') ? `writing-heading writing-h${name.slice(-1)}` : name.includes('Code') ? 'writing-code-line' : name === 'Blockquote' ? 'writing-blockquote' : 'writing-list-line' }).range(line.from)) }
      }
      if (['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HeaderMark', 'QuoteMark', 'LinkMark'].includes(name)) {
        const parent = node.node.parent
        if (parent && !active(parent.from, parent.to)) {
          // The opening heading marker includes its separator in preview, so
          // the visible title starts at the same left edge as ordinary text.
          const separator = name === 'HeaderMark' && parent.firstChild?.from === from
            ? state.doc.sliceString(to, parent.to).match(/^[ \t]+/)?.[0].length ?? 0 : 0
          decorations.push(Decoration.replace({}).range(from, to + separator))
        }
      }
      if (name === 'URL' && node.node.parent?.name === 'Link' && !active(node.node.parent.from, node.node.parent.to)) decorations.push(Decoration.replace({}).range(from, to))
      if (name === 'TaskMarker' && !editing) { decorations.push(Decoration.replace({ widget: new Preview(source.includes('x') || source.includes('X') ? '☑' : '☐') }).range(from, to)); return false }
    } })
    return Decoration.set(decorations, true)
  }
  return StateField.define<DecorationSet>({ create: build, update: (value, tr) => tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? build(tr.state) : value, provide: field => EditorView.decorations.from(field) })
}
export interface MarkdownEditorHandle { waitForImages: () => Promise<void>; flushSketches: (markdown: string) => Promise<void>; focusAtStart: () => void; clearSelection: () => void }
interface Props { notebookId: string; initial: string; showLineNumbers?: boolean; textLayout?: 'wide' | 'thin'; onChange: (text: string) => void; onOffer: (offer: AskOffer | null) => void; onError: (error: string) => void; onSave: () => void }
export default forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), callbacks = useRef(props), images = useRef(new Set<Promise<void>>())
  const numberGutter = useRef(new Compartment())
  const sketchAssets = useRef<SketchAssets | null>(null)
  callbacks.current = props
  useImperativeHandle(ref, () => ({
    waitForImages: async () => { await Promise.all([...images.current]) },
    flushSketches: async markdown => { await sketchAssets.current?.flush(markdown) },
    focusAtStart: () => {
      const editor = view.current
      if (!editor) return
      editor.focus()
      editor.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
    },
    clearSelection: () => {
      const editor = view.current
      if (editor) editor.dispatch({ selection: { anchor: editor.state.selection.main.head } })
      window.getSelection()?.removeAllRanges()
    }
  }), [])
  useEffect(() => {
    const owner = {}, notebookId = props.notebookId
    const assets = new SketchAssets(notebookId), shortcut = new Compartment()
    sketchAssets.current = assets
    let alive = true
    const insertImages = (files: File[], position: number, editor: EditorView) => {
      const tracking = new Compartment()
      let at = position
      // Track asynchronous insert positions through subsequent edits.
      const track = EditorView.updateListener.of(update => { at = update.changes.mapPos(at, 1) })
      editor.dispatch({ effects: StateEffect.appendConfig.of(tracking.of(track)) })
      const task = (async () => { for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error('Images must be at most 20 MiB.')
        const asset = await window.opencourse.writing.image(notebookId, new Uint8Array(await file.arrayBuffer()))
        if (!alive) return
        const text = `![${file.name.replace(/[\[\]\\\r\n]/g, '') || 'Image'}](${asset})`
        editor.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } }); editor.focus()
      } })()
      images.current.add(task)
      void task.catch(error => callbacks.current.onError(error.message)).finally(() => { images.current.delete(task); if (alive) editor.dispatch({ effects: tracking.reconfigure([]) }) })
    }
    const select = (editor: EditorView) => {
      const range = editor.state.selection.main
      if (range.empty) { callbacks.current.onOffer(null); return }
      const start = editor.coordsAtPos(range.from), end = editor.coordsAtPos(range.to)
      if (!start || !end) return
      callbacks.current.onOffer({ owner, from: 'writing-notebook', text: editor.state.sliceDoc(range.from, range.to), x: (start.left + end.right) / 2, y: Math.max(60, start.top),
        mark: () => {}, unmark: () => {} })
    }
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: props.initial, extensions: [
      markdown({ base: markdownLanguage, completeHTMLTags: false }), history(), shortcut.of(sketchKeymap(DEFAULT_SKETCH, assets)), sketchExtensions(assets, () => callbacks.current.onSave()), keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } }, ...defaultKeymap, ...historyKeymap, { mac: 'Ctrl-z', run: undo }, indentWithTab]),
      EditorView.lineWrapping, numberGutter.current.of(props.showLineNumbers ? notebookLineNumbers : []), livePreview(notebookId), EditorView.contentAttributes.of({ 'aria-label': 'Notebook page', spellcheck: 'true' }),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange(update.state.doc.toString()); if (update.selectionSet && update.view.hasFocus) select(update.view) }),
      EditorView.domEventHandlers({
        mouseup: (_event, editor) => { select(editor) },
        paste: (event, editor) => { const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/')); if (!files.length) return false; event.preventDefault(); insertImages(files, editor.state.selection.main.from, editor); return true },
        dragover: event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); return true } return false },
        drop: (event, editor) => { const files = [...(event.dataTransfer?.files ?? [])]; if (!files.length) return false; event.preventDefault(); if (files.some(f => !f.type.startsWith('image/'))) { callbacks.current.onError('Drop PNG, JPEG, WebP, or GIF images.'); return true } insertImages(files, editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editor.state.selection.main.from, editor); return true }
      })
    ] }) })
    view.current = editor
    const outside = (event: Event) => dismissSketch(editor, event.target)
    const copy = () => { const { from, to } = editor.state.selection.main
      const text = from === to ? editor.state.doc.lineAt(from).text : editor.state.sliceDoc(from, to)
      void assets.flush(text).catch(e => callbacks.current.onError(e.message))
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    editor.dom.addEventListener('copy', copy, true)
    editor.dom.addEventListener('cut', copy, true)
    const api = window.opencourse?.writing
    let settingsChanged = false
    const off = api?.onSketchSettings?.(settings => {
      settingsChanged = true
      editor.dispatch({ effects: shortcut.reconfigure(sketchKeymap(settings, assets)) })
    })
    void api?.sketchSettings?.().then(settings => {
      if (alive && !settingsChanged) editor.dispatch({ effects: shortcut.reconfigure(sketchKeymap(settings, assets)) })
    }).catch(e => { if (alive) callbacks.current.onError(e.message) })
    return () => {
      alive = false; off?.()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      editor.dom.removeEventListener('copy', copy, true)
      editor.dom.removeEventListener('cut', copy, true)
      editor.destroy(); view.current = null; sketchAssets.current = null
    }
  }, [props.notebookId])
  useEffect(() => {
    view.current?.dispatch({ effects: numberGutter.current.reconfigure(props.showLineNumbers ? notebookLineNumbers : []) })
  }, [props.showLineNumbers])
  useEffect(() => { view.current?.requestMeasure() }, [props.textLayout])
  useEffect(() => onThemeApplied(() => view.current?.requestMeasure()), [])
  return <div ref={host} className="writing-editor" data-layout={props.textLayout ?? 'wide'} />
})
