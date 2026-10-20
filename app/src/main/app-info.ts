import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { BRAND } from '../core/brand'
import { linksFor, PUBLIC_LINKS, type AppLinks } from '../core/links'
import type { AppInfo } from '../core/types'
import { bundledPythonDir } from './bundled-python'
import { devEnvironment } from './dev-env'

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

/** The public site and catalog, or the local ones a `npm run dev` app is wired to. */
export function appLinks(): AppLinks {
  const dev = devEnvironment()
  return dev ? linksFor(dev.site, dev.catalogWeb) : PUBLIC_LINKS
}

export function appInfo(): AppInfo {
  const links = appLinks()
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
    website: links.website,
    links
  }
}
