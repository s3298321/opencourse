/**
 * Comparing what a program printed against what the course said it should.
 *
 * This is the second way to verify an exercise: instead of shipping a test file
 * the author states the expected stdout, which is the only workable shape for
 * the first lessons of a compiled language, where the learner's whole program
 * is the answer.
 */
import type { OutputExpectation, OutputMatch } from './types'

export const DEFAULT_MATCH: OutputMatch = 'trimmed'

/** Trailing blank lines are never meaningful; a missing final newline is not a bug. */
function normalizeLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd())
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function shape(value: string, match: OutputMatch): string {
  if (match === 'exact') return value
  if (match === 'trimmed') return normalizeLines(value).join('\n')
  return normalizeLines(value)
    .map((line) => line.trim())
    .join('\n')
}

export interface OutputVerdict {
  ok: boolean
  /** Renderable report, already newline-separated. Empty when ok. */
  report: string
}

export function compareOutput(got: string, expectation: OutputExpectation): OutputVerdict {
  const wanted = shape(expectation.stdout, expectation.match)
  const actual = shape(got, expectation.match)
  if (wanted === actual) return { ok: true, report: '' }

  const wantedLines = wanted.split('\n')
  const actualLines = actual.split('\n')
  const firstDiff = wantedLines.findIndex((line, i) => line !== actualLines[i])
  const at = firstDiff === -1 ? Math.min(wantedLines.length, actualLines.length) : firstDiff

  return {
    ok: false,
    report: [
      `output did not match (first difference on line ${at + 1})`,
      '',
      '  expected:',
      ...wantedLines.map((line) => `    ${line}`),
      '',
      '  got:',
      ...actualLines.map((line) => `    ${line}`)
    ].join('\n')
  }
}
