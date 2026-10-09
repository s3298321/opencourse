import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { Annotation, Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import { indentation } from './indentation'
import { llvmIr } from './llvm-mode'
import { EDITOR_FONT_PX, highlightColors, type WorkbenchTheme } from './theme'

/**
 * Which npm package supplies a mode. This is a renderer concern - it is not the
 * same registry as the Shiki grammar names core uses for prose code fences, and
 * a language with no mode here still edits fine, just without highlighting.
 */
const MODES: Record<string, () => Extension> = { python, c: cpp, cpp, 'llvm-ir': llvmIr }
const externalDocument = Annotation.define<boolean>()

/**
 * Everything a theme decides about the editor, as one extension. It lives in a
 * compartment so applying a theme reconfigures the view in place - recreating
 * it would cost the learner their undo history and cursor.
 */
function themeExtensions(theme: WorkbenchTheme): Extension {
  const palette = highlightColors(theme.dark)
  const highlight = HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: palette.keyword },
    { tag: [tags.string, tags.special(tags.string)], color: palette.string },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: palette.comment, fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: palette.fn },
    { tag: [tags.number, tags.bool, tags.null], color: palette.number },
    { tag: [tags.className, tags.typeName, tags.definition(tags.className)], color: palette.type },
    { tag: tags.labelName, color: palette.type },
    { tag: [tags.variableName, tags.propertyName], color: palette.variable },
    { tag: tags.operator, color: palette.keyword },
    { tag: tags.self, color: palette.keyword }
  ])
  return [
    syntaxHighlighting(highlight),
    EditorView.theme(
      {
        '&': { height: '100%', fontSize: `${EDITOR_FONT_PX}px`, backgroundColor: theme.bg, color: theme.fg },
        '.cm-scroller': { fontFamily: theme.mono, lineHeight: '1.55' },
        '.cm-gutters': { backgroundColor: theme.bg, color: theme.muted, border: 'none' },
        '.cm-activeLine': { backgroundColor: theme.activeLine },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: theme.fg },
        '.cm-cursor': { borderLeftColor: theme.accent },
        '&.cm-focused': { outline: 'none' }
      },
      { dark: theme.dark }
    )
  ]
}

interface Props {
  /** Identity of the buffer. Changing it replaces the document wholesale. */
  docKey: string
  /** Toolchain id, for the syntax mode. */
  language: string
  /** The toolchain's indent, used only when the document shows none of its own. */
  indentUnit: string
  initialDoc: string
  /** Controlled draft buffer; external AI edits replace the visible content. */
  value?: string
  readOnly?: boolean
  ariaLabel?: string
  theme: WorkbenchTheme
  onChange: (value: string) => void
  onSave: () => void
  onRun: () => void
}

export default function CodeEditor({
  docKey,
  language,
  indentUnit,
  initialDoc,
  value,
  readOnly = false,
  ariaLabel = 'Code editor',
  theme,
  onChange,
  onSave,
  onRun
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  // Callbacks change every render; the editor is built once, so read them
  // through a ref rather than tearing the view down and losing undo history.
  const handlers = useRef({ onChange, onSave, onRun })
  handlers.current = { onChange, onSave, onRun }
  // Read at creation; later changes arrive through the compartment below.
  const themeRef = useRef(theme)
  themeRef.current = theme
  const appearance = useRef(new Compartment())
  const applied = useRef<WorkbenchTheme | null>(null)

  useEffect(() => {
    if (!host.current) return undefined

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        ...(MODES[language] ? [MODES[language]()] : []),
        ...indentation(initialDoc, indentUnit),
        appearance.current.of(themeExtensions((applied.current = themeRef.current))),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
          { key: 'Mod-Enter', preventDefault: true, run: () => (handlers.current.onRun(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalDocument))) handlers.current.onChange(update.state.doc.toString())
        })
      ]
    })

    // Created here and destroyed in the cleanup: StrictMode double-invokes
    // effects in development, and two views in one div is a real bug.
    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    return () => { view.current = null; instance.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, language, indentUnit, readOnly, ariaLabel])

  useEffect(() => {
    if (!view.current || applied.current === theme) return
    applied.current = theme
    view.current.dispatch({ effects: appearance.current.reconfigure(themeExtensions(theme)) })
  }, [theme])

  useEffect(() => {
    const editor = view.current
    if (value !== undefined && editor && value !== editor.state.doc.toString()) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalDocument.of(true) })
    }
  }, [value, docKey, readOnly])

  return <div className="editor-host" ref={host} />
}
