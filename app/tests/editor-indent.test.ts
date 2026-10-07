/**
 * The editor's indentation, driven through CodeMirror's own Enter command.
 *
 * Detection alone is not the bug: the bug was what Enter produced, which is the
 * language mode's indenter multiplied by the unit. So this runs the real
 * command against the real modes with the extensions CodeEditor uses.
 */
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { insertNewlineAndIndent } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { python } from '@codemirror/lang-python'
import { indentation } from '../src/renderer/workbench/indentation'
import { llvmIr } from '../src/renderer/workbench/llvm-mode'

/** Press Enter at `at` (default: the end of `line`) and return the new line's leading whitespace. */
function enterAfter(doc: string, mode: Extension, line: string, fallback = '    '): string {
  const end = doc.indexOf(line) + line.length
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(end),
    extensions: [mode, ...indentation(doc, fallback)]
  })
  insertNewlineAndIndent({ state, dispatch: (tr) => (state = tr.state) })
  const next = state.doc.lineAt(state.selection.main.head)
  return /^[ \t]*/.exec(next.text)?.[0] ?? ''
}

describe('Enter in the editor', () => {
  it('keeps a four-space C body at four spaces', () => {
    const doc = 'int main(void) {\n    int x = 1;\n    return x;\n}\n'
    expect(enterAfter(doc, cpp(), '    int x = 1;')).toBe('    ')
  })

  it('keeps a tabbed C body tabbed', () => {
    const doc = 'int main(void) {\n\tint x = 1;\n\treturn x;\n}\n'
    expect(enterAfter(doc, cpp(), '\tint x = 1;')).toBe('\t')
  })

  it('opens a C block one unit in from the toolchain default when the file has no style yet', () => {
    const doc = 'int main(void) {\n}\n'
    expect(enterAfter(doc, cpp(), 'int main(void) {')).toBe('    ')
  })

  it('indents after a Python colon by four', () => {
    const doc = 'def f(x):\n    return x\n\ndef g(y):\n'
    expect(enterAfter(doc, python(), 'def g(y):')).toBe('    ')
  })

  it('follows a two-space Python file rather than imposing four', () => {
    const doc = 'def f(x):\n  if x:\n    return 1\n  return 2\n'
    expect(enterAfter(doc, python(), '  if x:')).toBe('    ')
    expect(enterAfter(doc, python(), '  return 2')).toBe('  ')
  })
})

describe('Enter in an LLVM IR file', () => {
  const doc = 'define i32 @f(i32 %x) {\nentry:\n  %y = add i32 %x, 1\n  ret i32 %y\n}\n\ndeclare i32 @g()\n'

  it('indents the first line of a body', () => {
    expect(enterAfter(doc, llvmIr(), 'define i32 @f(i32 %x) {', '  ')).toBe('  ')
  })

  it('indents after a label, which sits in column zero itself', () => {
    expect(enterAfter(doc, llvmIr(), 'entry:', '  ')).toBe('  ')
  })

  it('keeps an instruction line where it is', () => {
    expect(enterAfter(doc, llvmIr(), '  %y = add i32 %x, 1', '  ')).toBe('  ')
  })

  it('goes back to column zero outside a function', () => {
    expect(enterAfter(doc, llvmIr(), 'declare i32 @g()', '  ')).toBe('')
  })
})
