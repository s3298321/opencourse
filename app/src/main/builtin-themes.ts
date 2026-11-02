/** Built-in themes use the same format and compiler as imported themes. */
import { compiledWhiteTheme, whiteTheme } from '../core/theme/builtin'
import { WHITE_THEME_ID } from '../core/theme/builtin-ids'
import type { CompiledTheme } from '../core/theme/compile'
import type { ThemeDirectory } from './theme-files'

interface BuiltinTheme extends ThemeDirectory {
  id: string
  directory: string | null
  compiled: CompiledTheme
}

const white: BuiltinTheme = {
  id: WHITE_THEME_ID, theme: whiteTheme, compiled: compiledWhiteTheme,
  directory: null, assets: new Map(), notes: []
}

export function builtinTheme(id: string | undefined): BuiltinTheme | null {
  return id === WHITE_THEME_ID ? white : null
}

export function builtinThemes(): BuiltinTheme[] {
  return [white]
}
