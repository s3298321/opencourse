/**
 * Handing an author a format: the written spec, the JSON Schema, and examples
 * that import as-is - one bundle for courses, one for themes.
 *
 * The files are generated into resources/spec at build time by
 * scripts/build-spec-resources.mjs and shipped as extraResources.
 */
import { BrowserWindow, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { specResourcesDir } from './paths'

const COURSE_FILES = ['course-format.md', 'course-schema.json', 'opencourse-example-course.zip'] as const

/**
 * The theme bundle carries the app's own look as a theme - the absence of a
 * theme, written out - because that is the one an author most wants to copy.
 */
const THEME_FILES = ['theme-format.md', 'theme-schema.json', 'opencourse-default-theme.zip', 'opencourse-example-theme.zip'] as const

export function saveSpecBundle(): Promise<{ saved: string | null; error?: string }> {
  return saveBundle(COURSE_FILES, 'opencourse-course-format', 'Where should the course format go?')
}

export function saveThemeSpecBundle(): Promise<{ saved: string | null; error?: string }> {
  return saveBundle(THEME_FILES, 'opencourse-theme-format', 'Where should the theme format go?')
}

async function saveBundle(files: readonly string[], folder: string, title: string): Promise<{ saved: string | null; error?: string }> {
  const source = specResourcesDir()
  const missing = files.filter((name) => !existsSync(join(source, name)))
  if (missing.length) {
    return { saved: null, error: `this build is missing ${missing.join(', ')}` }
  }

  const win = BrowserWindow.getFocusedWindow()
  const options = {
    title,
    buttonLabel: 'Save Here',
    properties: ['openDirectory', 'createDirectory'] as const
  }
  const result = win
    ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
    : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
  if (result.canceled || !result.filePaths[0]) return { saved: null }

  const destination = join(result.filePaths[0], folder)
  mkdirSync(destination, { recursive: true })
  for (const name of files) copyFileSync(join(source, name), join(destination, name))
  return { saved: destination }
}
