import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { notebookProfileRoot, opencourseDataRoot } from '../src/core/data-root'
import { isStandaloneNotebook } from '../src/core/writing-notebooks/standalone'

describe('shared OpenCourse data', () => {
  it('keeps the Electron profile separate from the OpenCourse data root', () => {
    const appData = join('/Users/example/Library/Application Support')
    expect(opencourseDataRoot(appData, false)).toBe(join(appData, 'opencourse'))
    expect(opencourseDataRoot(appData, true)).toBe(join(appData, 'opencourse-dev'))
    expect(notebookProfileRoot(appData, false)).toBe(join(appData, 'opencourse-notebook'))
    expect(notebookProfileRoot(appData, true)).toBe(join(appData, 'opencourse-notebook-dev'))
    expect(notebookProfileRoot(appData, true)).not.toBe(opencourseDataRoot(appData, true))
  })

  it('shares only notebooks that are not tied to content', () => {
    expect(isStandaloneNotebook({})).toBe(true)
    expect(isStandaloneNotebook({ association: undefined })).toBe(true)
    expect(isStandaloneNotebook({ association: null })).toBe(true)
    expect(isStandaloneNotebook({ association: { kind: 'course', id: 'c', title: 'Physics' } })).toBe(false)
    expect(isStandaloneNotebook({ association: { kind: 'document', id: 'd', title: 'Notes' } })).toBe(false)
  })
})
