import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { BRAND } from '../core/brand'
import type { AppInfo } from '../core/types'
import { bundledPythonDir } from './bundled-python'

export function bundledPythonInfo(directory: string): AppInfo['python'] {
  try {
    const metadata = JSON.parse(readFileSync(join(directory, 'PYTHON.json'), 'utf8'))
    if (typeof metadata.python_version !== 'string') return null
    let release: string | null = null
    try {
      const identity = readFileSync(join(directory, '.opencourse-runtime'), 'utf8')
      const match = identity.match(/^([^+]+)\+(\d+):/)
      if (match && match[1] === metadata.python_version) release = match[2]
    } catch { /* Metadata is still useful if the build stamp is missing. */ }
    return { version: metadata.python_version, release }
  } catch { return null }
}

export function appInfo(): AppInfo {
  return {
    name: BRAND.displayName,
    description: 'Courses on any subject, on the desktop, with runnable exercises.',
    version: app.getVersion(),
    python: bundledPythonInfo(bundledPythonDir()),
    electron: process.versions.electron ?? 'Unavailable',
    chromium: process.versions.chrome ?? 'Unavailable',
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    license: 'MIT',
    website: 'https://opencourse.dev'
  }
}
