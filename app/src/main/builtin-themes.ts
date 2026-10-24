/** Built-in themes use the same format and compiler as imported themes. */
import { app } from 'electron'
import { join } from 'node:path'
import { compiledWhiteTheme, whiteTheme } from '../core/theme/builtin'
import { NEON_THEME_ID, WHITE_THEME_ID } from '../core/theme/builtin-ids'
import { compileTheme, THEME_URL_PREFIX, type CompiledTheme } from '../core/theme/compile'
import type { ThemeDirectory } from './theme-files'
import { readThemeDirectory } from './theme-files'

interface BuiltinTheme extends ThemeDirectory {
  id: string
  directory: string | null
  compiled: CompiledTheme
}

const white: BuiltinTheme = {
  id: WHITE_THEME_ID, theme: whiteTheme, compiled: compiledWhiteTheme,
  directory: null, assets: new Map(), notes: []
}
let neon: BuiltinTheme | undefined

export function builtinTheme(id: string | undefined): BuiltinTheme | null {
  if (id === WHITE_THEME_ID) return white
  if (id !== NEON_THEME_ID) return null
  if (!neon) {
    const directory = app.isPackaged
      ? join(process.resourcesPath, 'themes', 'neon-afterhours')
      : join(app.getAppPath(), 'resources', 'themes', 'neon-afterhours')
    const read = readThemeDirectory(directory)
    if ('error' in read) throw new Error(`Invalid built-in Neon Afterhours theme: ${read.error}`)
    neon = {
      ...read, id, directory,
      compiled: compileTheme(read.theme, {
        assets: read.assets,
        url: (path) => `${THEME_URL_PREFIX}${id}/${path.split('/').map(encodeURIComponent).join('/')}`
      })
    }
  }
  return neon
}

export function builtinThemes(): BuiltinTheme[] {
  return [white, builtinTheme(NEON_THEME_ID)!]
}
