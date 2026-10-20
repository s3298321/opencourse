import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { indentation } from '../../../../app/src/renderer/workbench/indentation'
import { llvmIr } from '../../../../app/src/renderer/workbench/llvm-mode'

/** The app's modes, by toolchain id. A language with none still edits, unhighlighted. */
const MODES: Record<string, () => Extension> = { python, c: cpp, cpp, 'llvm-ir': llvmIr }

/** The app's dark editor palette (app/src/renderer/workbench/theme.ts); the web is dark only. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: '#ff7b72' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a5d6ff' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#8b949e', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#d2a8ff' },
  { tag: [tags.number, tags.bool, tags.null], color: '#79c0ff' },
  { tag: [tags.className, tags.typeName, tags.definition(tags.className)], color: '#ffa657' },
  { tag: tags.labelName, color: '#ffa657' },
  { tag: [tags.variableName, tags.propertyName], color: '#e6edf3' },
  { tag: tags.operator, color: '#ff7b72' },
  { tag: tags.self, color: '#ff7b72' }
])

// Tokens rather than values: the reading scale and the palette follow the page
// without reconfiguring the view, which would cost undo history and the cursor.
const appearance = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: 'calc(12.5px * var(--reading-scale, 1))',
      backgroundColor: 'var(--code-bg)',
      color: 'var(--fg)'
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--muted)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' }
  },
  { dark: true }
)

export function CodeEditor({
  docKey,
  language,
  indentUnit,
  initialDoc,
  onChange,
  onSave
}: {
  /** Identity of the buffer. Changing it replaces the document wholesale. */
  docKey: string
  language: string
  /** The toolchain's indent, used only when the document shows none of its own. */
  indentUnit: string
  initialDoc: string
  onChange: (value: string) => void
  onSave: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  // The view is built once per buffer; callbacks are read through a ref.
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }
  useEffect(() => {
    if (!host.current) return undefined
    // In a shadow root, CodeMirror's styles are constructed stylesheets. In the
    // document it adds <style> elements, which the page's CSP refuses (no
    // 'unsafe-inline') - the editor then renders without its own layout.
    // Page tokens (--code-bg, --reading-scale) still inherit into it.
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' })
    const view = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          EditorView.contentAttributes.of({ 'aria-label': 'Code editor' }),
          ...(MODES[language] ? [MODES[language]()] : []),
          ...indentation(initialDoc, indentUnit),
          syntaxHighlighting(highlight),
          appearance,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
          })
        ]
      })
    })
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, language, indentUnit])
  return <div className="editor-host" ref={host} />
}
