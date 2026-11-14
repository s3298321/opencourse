import { StreamLanguage, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/**
 * Textual LLVM IR, for the editor. There is no CodeMirror package for it, and
 * the language is regular enough that a stream tokenizer covers what a learner
 * needs to read their own file: `%locals` apart from `@globals`, types apart
 * from opcodes, and comments, which in IR start with `;` rather than anything
 * the other modes would recognise.
 */

/** Opcodes and the structural words of a module. Flags and attributes are not here. */
const KEYWORDS = new Set([
  // terminators
  'ret', 'br', 'switch', 'indirectbr', 'invoke', 'resume', 'unreachable', 'callbr',
  // arithmetic and bitwise
  'add', 'fadd', 'sub', 'fsub', 'mul', 'fmul', 'udiv', 'sdiv', 'fdiv', 'urem', 'srem', 'frem', 'fneg',
  'shl', 'lshr', 'ashr', 'and', 'or', 'xor',
  // aggregates and vectors
  'extractelement', 'insertelement', 'shufflevector', 'extractvalue', 'insertvalue',
  // memory
  'alloca', 'load', 'store', 'fence', 'cmpxchg', 'atomicrmw', 'getelementptr',
  // conversions
  'trunc', 'zext', 'sext', 'fptrunc', 'fpext', 'fptoui', 'fptosi', 'uitofp', 'sitofp',
  'ptrtoint', 'inttoptr', 'bitcast', 'addrspacecast',
  // everything else
  'icmp', 'fcmp', 'phi', 'select', 'call', 'tail', 'musttail', 'notail', 'va_arg', 'freeze',
  'landingpad', 'catchpad', 'cleanuppad',
  // module structure
  'define', 'declare', 'global', 'constant', 'type', 'target', 'datalayout', 'triple',
  'attributes', 'source_filename', 'to', 'x', 'vscale'
])

const TYPES = new Set([
  'void', 'ptr', 'half', 'bfloat', 'float', 'double', 'fp128', 'x86_fp80', 'ppc_fp128',
  'label', 'metadata', 'token', 'opaque'
])

const CONSTANTS_BOOL = new Set(['true', 'false'])
const CONSTANTS_NULL = new Set(['null', 'none', 'undef', 'poison', 'zeroinitializer'])

/** How many braces are open: a function body is one, and its lines are indented. */
interface State {
  depth: number
}

/** A block label: a bare name, or a number, followed by a colon. */
const LABEL = /^(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|\d+):/

const parser: StreamParser<State> = {
  name: 'llvm-ir',
  startState: () => ({ depth: 0 }),
  copyState: (state) => ({ depth: state.depth }),
  token(stream, state) {
    if (stream.eatSpace()) return null

    if (stream.peek() === ';') {
      stream.skipToEnd()
      return 'comment'
    }

    // c"Hello\0A\00" and "quoted names" alike.
    if (stream.match(/^c?"(?:[^"\\]|\\.)*"?/)) return 'string'

    if (stream.sol() && stream.match(LABEL)) return 'labelName'

    if (stream.match(/^@(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)/)) return 'variableName.function'
    if (stream.match(/^%(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)/)) return 'variableName'
    // Attribute groups (#0) and metadata (!0, !llvm.loop, !{...}).
    if (stream.match(/^[#!][-a-zA-Z$._0-9]*/)) return 'meta'

    if (stream.match(/^i\d+\b/)) return 'typeName'
    if (stream.match(/^0x[0-9A-Fa-f]+/) || stream.match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)) return 'number'

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_.]*/)) {
      const word = stream.current()
      if (KEYWORDS.has(word)) return 'keyword'
      if (TYPES.has(word)) return 'typeName'
      if (CONSTANTS_BOOL.has(word)) return 'bool'
      if (CONSTANTS_NULL.has(word)) return 'null'
      // nsw, inbounds, align, noundef, private ...: modifiers, left in the body colour.
      return null
    }

    const ch = stream.next()
    if (ch === '{') state.depth++
    if (ch === '}') state.depth = Math.max(0, state.depth - 1)
    return null
  },
  /**
   * Inside a function body every line is one unit in, except labels and the
   * closing brace. Without this, Enter after `entry:` copies the label's own
   * column and every instruction has to be indented by hand.
   */
  indent(state, textAfter, cx) {
    const after = textAfter.trimStart()
    if (after.startsWith('}')) return Math.max(0, state.depth - 1) * cx.unit
    if (LABEL.test(after)) return Math.max(0, state.depth - 1) * cx.unit
    return state.depth * cx.unit
  },
  languageData: {
    commentTokens: { line: ';' }
  }
}

export function llvmIr(): Extension {
  return StreamLanguage.define(parser)
}
