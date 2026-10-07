import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InstalledEditor } from '../core/types'
import { readPreferences, writePreferences } from './preferences'
const execute = promisify(execFile)
const EDITORS = [
  { id: 'zed', label: 'Zed', bundle: 'Zed.app' },
  { id: 'vscode', label: 'Visual Studio Code', bundle: 'Visual Studio Code.app' },
  { id: 'cursor', label: 'Cursor', bundle: 'Cursor.app' },
  { id: 'sublime', label: 'Sublime Text', bundle: 'Sublime Text.app' }
] as const
export function installedEditors(): (InstalledEditor & { bundlePath: string })[] {
  return EDITORS.flatMap((editor) => {
    const bundlePath = [join('/Applications', editor.bundle), join(homedir(), 'Applications', editor.bundle)].find(existsSync)
    return bundlePath ? [{ id: editor.id, label: editor.label, bundlePath }] : []
  })
}
export function editorPreference(): string | null { return readPreferences().projectEditor ?? null }
export async function launchProjectEditor(directory: string, editorId: string): Promise<void> {
  const editor = installedEditors().find((e) => e.id === editorId)
  if (!editor) throw new Error('That editor is no longer installed. Choose another editor or reveal the folder in Finder.')
  await execute('/usr/bin/open', ['-a', editor.bundlePath, directory], { timeout: 10000, maxBuffer: 8192 })
  writePreferences({ ...readPreferences(), projectEditor: editor.id })
}
