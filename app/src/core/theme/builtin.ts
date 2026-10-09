import { compileTheme } from './compile'
import { normalizeTheme } from './normalize'
import white from './white.json'
import type { ThemeAsset } from './assets'

// Imported as data so the theme ships in the main bundle, including packaged
// apps. No files or fonts are needed; a null logo preserves the bundled mark.
const assets = new Map<string, ThemeAsset>()
const read = normalizeTheme(white, assets)
if ('error' in read) throw new Error(`Invalid built-in White theme: ${read.error}`)

export const whiteTheme = read.theme
export const compiledWhiteTheme = compileTheme(whiteTheme, { assets, url: (path) => path })
