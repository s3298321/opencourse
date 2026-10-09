import { describe, expect, it } from 'vitest'
import { detectIndentUnit } from '@core/indent'
import { getToolchain } from '@core/toolchains'
import { fixtureCourseDir, readManifest } from './helpers/courses'

describe('detectIndentUnit', () => {
  it('reads four spaces off a C body', () => {
    expect(detectIndentUnit('int main(void) {\n    int x = 1;\n    return x;\n}\n')).toBe('    ')
  })

  it('reads a tab off a tabbed file', () => {
    expect(detectIndentUnit('int main(void) {\n\tint x = 1;\n\treturn x;\n}\n')).toBe('\t')
  })

  it('reads two spaces when that is the style', () => {
    expect(detectIndentUnit('def f():\n  if x:\n    return 1\n  return 2\n')).toBe('  ')
  })

  it('measures steps, not depths: eight-space bodies in four-space blocks are a four-space file', () => {
    const nested = 'def f():\n    for x in y:\n        if x:\n            yield x\n    return\n'
    expect(detectIndentUnit(nested)).toBe('    ')
  })

  it('has no opinion on a file with nothing indented', () => {
    expect(detectIndentUnit('/* your code here */\n')).toBeNull()
    expect(detectIndentUnit('')).toBeNull()
    expect(detectIndentUnit('\n   \n\t\n')).toBeNull()
  })

  it('ignores widths that are alignment rather than a style', () => {
    expect(detectIndentUnit('x = f(a,\n      b)\n')).toBeNull()
  })

  it('lets the majority win in a mixed file', () => {
    expect(detectIndentUnit('{\n\ta;\n\tb;\n    c;\n}\n')).toBe('\t')
    expect(detectIndentUnit('{\n    a;\n    b;\n\tc;\n}\n')).toBe('    ')
  })

  it('reads every starter in the fixture courses as the toolchain default', () => {
    // The fallback and the files agree today; if a course ever changes style,
    // the editor follows the file, and this says so.
    for (const slug of ['intro-to-python', 'python-asyncio']) {
      const course = readManifest(fixtureCourseDir(slug))
      const fallback = getToolchain(course.runtime?.language).indentUnit
      for (const mod of course.modules) {
        for (const lesson of mod.lessons ?? []) {
          for (const block of lesson.blocks) {
            if (block.type !== 'exercise' || !block.starter_code) continue
            const found = detectIndentUnit(block.starter_code)
            expect(found ?? fallback, `${slug}/${block.id}`).toBe(fallback)
          }
        }
      }
    }
  })
})
