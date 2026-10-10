import dark from '../../../../docs/default-theme/theme.json'
import { normalizeTheme } from './normalize'
import { compileTheme } from './compile'
import { colorCss, composite, parseColor } from './color'

// Use the same source as the exported Dark theme, without changing theme format v1.
const read = normalizeTheme(dark, new Map())
if ('error' in read) throw new Error(read.error)
export const darkChrome = compileTheme(read.theme, { assets: new Map(), url: path => path })
export const darkChromeBackground = colorCss(composite(parseColor(darkChrome.values['--chrome'])!, parseColor(darkChrome.native.background)!))
export const darkChromeCss = darkChrome.css.replaceAll(':root', '.titlebar[data-dark-chrome]') + `
.titlebar[data-dark-chrome] { --chrome: ${darkChromeBackground}; color-scheme: dark; }
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .titlebar[data-dark-chrome] { --chrome: ${darkChrome.reducedTransparency['--chrome']}; }
}`
