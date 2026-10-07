import { describe, expect, it } from 'vitest'
import { MAX_QUOTE_CHARS } from '@core/sidechat/thread'
import {
  VIZ_BRIDGE,
  VIZ_BRIDGE_PATH,
  VIZ_BRIDGE_SCRIPT,
  VIZ_SOURCE,
  injectVizBridge,
  parseVizMessage
} from '@core/vizbridge'

const rect = { left: 10, top: 20, width: 100, height: 16 }
const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: VIZ_SOURCE,
  type: 'selection',
  text: 'the event loop',
  rect,
  ...over
})

describe('injectVizBridge', () => {
  it('goes in before </body>, so it runs after the page has built itself', () => {
    const page = '<!doctype html><html><body><div id="app"></div><script src="app.js"></script></body></html>'
    const out = injectVizBridge(page)
    expect(out.indexOf(VIZ_BRIDGE)).toBeGreaterThan(out.indexOf('app.js'))
    expect(out.endsWith(VIZ_BRIDGE + '</body></html>')).toBe(true)
  })

  it('finds a </BODY> in any case, and the last one if a script mentions it', () => {
    const page = '<body><script>var s = "</body>"</script></BODY>'
    expect(injectVizBridge(page)).toBe('<body><script>var s = "</body>"</script>' + VIZ_BRIDGE + '</BODY>')
  })

  it('appends to a page with no </body>', () => {
    expect(injectVizBridge('<p>hi')).toBe('<p>hi' + VIZ_BRIDGE)
  })

  it('loads the script from the page origin rather than inlining it', () => {
    // The renderer's policy is stamped on visualization responses too, and its
    // script-src is 'self' alone: an inline bridge was refused.
    expect(VIZ_BRIDGE).toContain(`<script data-opencourse-bridge src="${VIZ_BRIDGE_PATH}"></script>`)
    expect(/<script[^>]*>[^<]/.test(VIZ_BRIDGE)).toBe(false)
    expect(VIZ_BRIDGE_PATH.startsWith('/')).toBe(true)
  })

  it('serves script the browser can parse', () => {
    expect(() => new Function(VIZ_BRIDGE_SCRIPT)).not.toThrow()
  })
})

describe('parseVizMessage', () => {
  it('rejects selection sources from retired brands', () => {
    for (const source of ['localcrs-viz', 'pycrs-viz', 'localcrs-app', 'pycrs-app']) {
      expect(parseVizMessage(message({ source }))).toBeNull()
    }
  })
  it('takes a selection with its rectangle', () => {
    expect(parseVizMessage(message())).toEqual({ text: 'the event loop', rect })
  })

  it('reads empty text as the selection going away', () => {
    expect(parseVizMessage(message({ text: '', rect: null }))).toEqual({ text: '', rect: null })
    expect(parseVizMessage(message({ text: '   ' }))).toEqual({ text: '', rect: null })
  })

  it('trims, and caps the text at what the chat would accept anyway', () => {
    const long = parseVizMessage(message({ text: '  ' + 'x'.repeat(MAX_QUOTE_CHARS + 50) + '  ' }))
    expect(long?.text).toHaveLength(MAX_QUOTE_CHARS)
  })

  it("refuses anything that is not the bridge's", () => {
    for (const bad of [
      null,
      undefined,
      'the event loop',
      42,
      message({ source: 'opencourse-app' }),
      message({ source: 'someone-else' }),
      message({ type: 'mark' }),
      message({ text: 7 }),
      message({ text: ['a'] })
    ]) {
      expect(parseVizMessage(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refuses a selection without four finite numbers to place the offer by', () => {
    for (const bad of [
      null,
      'here',
      { left: 1, top: 2, width: 3 },
      { ...rect, top: '20' },
      { ...rect, left: Number.NaN },
      { ...rect, width: Number.POSITIVE_INFINITY }
    ]) {
      expect(parseVizMessage(message({ rect: bad })), JSON.stringify(bad)).toBeNull()
    }
  })

  it('keeps only the fields it knows', () => {
    const parsed = parseVizMessage(message({ rect: { ...rect, extra: 'x' }, html: '<b>' }))
    expect(parsed).toEqual({ text: 'the event loop', rect })
  })
})
