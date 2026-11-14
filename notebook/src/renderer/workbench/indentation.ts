import { EditorState, type Extension } from '@codemirror/state'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { detectIndentUnit } from '@core/indent'

/**
 * How the editor indents a document: in the document's own style if it has
 * one, the toolchain's otherwise.
 *
 * Without an explicit unit CodeMirror uses two spaces, and the language modes
 * compute a new line's indent as "enclosing block plus one unit" - so Enter at
 * the end of a four-space line in a C body produced two spaces, and in a tabbed
 * one produced spaces where every other line had a tab. Kept apart from
 * CodeEditor so a test can run the real commands against it without a DOM.
 */
export function indentation(doc: string, fallback: string): Extension[] {
  return [
    indentUnit.of(detectIndentUnit(doc) ?? fallback),
    // What a tab is worth when a mixed file measures a column.
    EditorState.tabSize.of(4),
    // Typing a closing brace re-indents its line, which is what makes "}" land
    // under the block it closes instead of one level inside it.
    indentOnInput()
  ]
}
