import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ChatQuote } from '@core/types'
import { QUOTE_HIGHLIGHT } from '@core/vizbridge'
import type { Ask, AskOffer } from '../ask-context'

function markPassage(range: Range | null): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return
  if (range) CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(range))
  else CSS.highlights.delete(QUOTE_HIGHLIGHT)
}

/** The lesson's selection/quote interaction, scoped to the authoring preview. */
export function usePreviewAsk(enabled: boolean, selectionKey: string) {
  const [selection, setSelection] = useState<AskOffer | null>(null)
  const [quote, setQuote] = useState<ChatQuote | null>(null)
  const marked = useRef<AskOffer | null>(null)
  const owner = useRef({})
  const clearQuote = useCallback(() => setQuote(null), [])

  useEffect(() => {
    setSelection(null)
    setQuote(current => enabled && current?.from === 'answer' ? current : null)
  }, [enabled, selectionKey])

  useEffect(() => {
    if (!enabled) return
    const onUp = (event: MouseEvent): void => {
      if ((event.target as Element | null)?.closest?.('.ask-about')) return
      const found = window.getSelection(), text = found?.toString().trim() ?? ''
      if (!found || !text || !found.rangeCount) return setSelection(null)
      const range = found.getRangeAt(0), node = range.commonAncestorContainer
      const element = node instanceof Element ? node : node.parentElement
      const from = element?.closest('[data-ask]')?.getAttribute('data-ask')
      if (from !== 'preview' && from !== 'answer') return setSelection(null)
      const box = range.getBoundingClientRect()
      if (!box.width && !box.height) return setSelection(null)
      const kept = range.cloneRange()
      setSelection({ owner: owner.current, text, from, x: box.left + box.width / 2, y: box.top,
        mark: () => markPassage(kept), unmark: () => markPassage(null) })
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [enabled])

  const attach = useCallback((offer: AskOffer): void => {
    if (!enabled) return
    marked.current?.unmark()
    setQuote({ text: offer.text, from: offer.from === 'answer' ? 'answer' : 'preview' })
    setSelection(null)
    offer.mark()
    marked.current = offer
  }, [enabled])
  const ask = useMemo<Ask>(() => ({
    // Visualization frames reuse the existing lesson bridge, so their source
    // becomes "preview" here while their mark/unmark callbacks stay intact.
    offer: offer => { if (enabled) setSelection({ ...offer, from: 'preview' }) },
    withdraw: owner => setSelection(current => current?.owner === owner ? null : current),
    attach
  }), [enabled, attach])

  useEffect(() => {
    if (quote) return
    marked.current?.unmark()
    marked.current = null
  }, [quote])
  useEffect(() => () => marked.current?.unmark(), [])
  return { ask, selection, quote, clearQuote }
}

export function PreviewAskOffer({ offer, attach }: { offer: AskOffer | null; attach: Ask['attach'] }): JSX.Element | null {
  if (!offer) return null
  return <button className="ask-about" style={{ left: Math.min(Math.max(offer.x, 64), window.innerWidth - 64), top: offer.y }}
    onMouseDown={event => event.preventDefault()} onClick={() => attach(offer)}>Ask about this</button>
}
