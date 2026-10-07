import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { APP_SOURCE, VIZ_SOURCE } from '../src/core/vizbridge'
import { AskProvider } from '../src/renderer/ask-context'
import Visualization from '../src/renderer/blocks/Visualization'
import { PreviewAskOffer, usePreviewAsk } from '../src/renderer/sidechat/usePreviewAsk'

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })
it('turns sandboxed visualization selections into preview quotes and marks/unmarks the originating frame', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  function Screen() {
    const panel = usePreviewAsk(true, 'block')
    return createElement(AskProvider, { value: panel.ask },
      createElement(Visualization, { block: { type: 'visualization', slug: 'demo', src: 'about:blank', title: 'Preview' } }),
      createElement(PreviewAskOffer, { offer: panel.selection, attach: panel.ask.attach }),
      createElement('output', null, panel.quote ? `${panel.quote.from}: ${panel.quote.text}` : ''),
      createElement('button', { onClick: panel.clearQuote }, 'Dismiss'))
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(Screen)))
  const frame = container.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  Object.defineProperty(frame, 'getBoundingClientRect', { value: () => ({ left: 80, top: 160 }) })
  const message = { source: VIZ_SOURCE, type: 'selection', text: 'Inside the visualization', rect: { left: 10, top: 20, width: 60, height: 18 } }
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: message })))
  expect(container.querySelector('.ask-about')).toBeNull()
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: message })))
  const offer = container.querySelector<HTMLButtonElement>('.ask-about')!
  expect(offer.style.left).toBe('120px'); expect(offer.style.top).toBe('180px')
  await act(async () => offer.click())
  expect(container.querySelector('output')!.textContent).toBe('preview: Inside the visualization')
  expect(post).toHaveBeenCalledWith({ source: APP_SOURCE, type: 'mark' }, '*')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')!.click())
  expect(post).toHaveBeenCalledWith({ source: APP_SOURCE, type: 'unmark' }, '*')
})
