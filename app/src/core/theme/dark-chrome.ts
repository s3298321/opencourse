import dark from '../../../../docs/default-theme/theme.json'
import { normalizeTheme } from './normalize'
import { compileTheme } from './compile'
import { colorCss, composite, parseColor } from './color'

// Use the same source as the exported Bond theme, without changing theme format v1.
const read = normalizeTheme(dark, new Map())
if ('error' in read) throw new Error(read.error)
export const darkChrome = compileTheme(read.theme, { assets: new Map(), url: path => path })
export const darkChromeBackground = colorCss(composite(parseColor(darkChrome.values['--chrome'])!, parseColor(darkChrome.native.background)!))
// Installed only for Panda. Descendants use their ordinary Bond rules, including
// hover, focus, disabled and accessibility variants, against these local tokens.
const surfaces = [
  '.titlebar[data-dark-chrome]', '.reading-size',
  '.prose th', '.writing-preview th', '.writing-new-page', '.tooltip', '.cm-tooltip',
  '.sidechat-latest', '.sidechat-send', '.sidechat-tab', '.learning-chat-send', '.learning-chat-tab'
].join(', ')
export const darkChromeCss = darkChrome.css.replaceAll(':root', surfaces) + `
:where(${surfaces}) { color: var(--fg); color-scheme: dark; }
.sidechat-send:enabled, .learning-chat .learning-chat-send:enabled {
  background-color: var(--chip-bg);
  color: var(--fg);
}
.cm-editor .cm-tooltip { background-color: #333338; color: white; border-color: var(--border); }
.cm-editor .cm-tooltip .cm-tooltip-arrow::before { border-block-color: #333338; }
.cm-editor .cm-tooltip .cm-tooltip-arrow::after { border-block-color: transparent; }
.titlebar[data-dark-chrome] { --chrome: ${darkChromeBackground}; color-scheme: dark; }
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .titlebar[data-dark-chrome] { --chrome: ${darkChrome.reducedTransparency['--chrome']}; }
}`
