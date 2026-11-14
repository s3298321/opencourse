import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { APP_SOURCE, parseVizMessage, type AppToViz } from '@core/vizbridge'
import type { VisualizationBlock } from '@core/types'
import { useAsk, type AskOffer } from '../ask-context'

/**
 * Visualizations run in a sandbox with no same-origin access, so they cannot
 * reach the app, its IPC bridge, or the filesystem - only their own bundle,
 * which the opencourse:// handler serves under a restrictive CSP.
 *
 * The handler also gives every page a small bridge that reports text selected
 * inside it (core/vizbridge.ts), which is how "Ask about this" works here too:
 * this component is the only thing that listens to its own frame, and it
 * hands the lesson an ordinary offer.
 */
export default function VisualizationBlockView({ block }: { block: VisualizationBlock }): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const ask = useAsk()
  // Identity only: which offers are this frame's to take back.
  const [owner] = useState(() => ({}))
  // A selection made while fullscreen. The floating offer would sit behind the
  // fullscreen element, so this one is offered in the bar instead.
  const [held, setHeld] = useState<AskOffer | null>(null)

  // Esc exits without going through the button, so read the state rather than
  // tracking our own - otherwise the label lies after the first Esc.
  useEffect(() => {
    const sync = (): void => {
      setIsFullscreen(document.fullscreenElement === frameRef.current)
      // Either way an offer made in the other mode is in the wrong place now.
      setHeld(null)
      ask.withdraw(owner)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [ask, owner])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      // Only this frame's messages, and only the bridge's shape: the page can
      // post whatever it likes, and so can every other frame in the lesson.
      if (!iframe || event.source !== iframe.contentWindow) return
      const found = parseVizMessage(event.data)
      if (!found) return
      if (!found.text || !found.rect) {
        setHeld(null)
        ask.withdraw(owner)
        return
      }
      const box = iframe.getBoundingClientRect()
      const frame = iframe.contentWindow
      const post = (type: AppToViz['type']): void => {
        frame?.postMessage({ source: APP_SOURCE, type } satisfies AppToViz, '*')
      }
      const offer: AskOffer = {
        owner,
        text: found.text,
        from: 'lesson',
        // The frame reports in its own viewport; the offer floats in ours.
        x: box.left + iframe.clientLeft + found.rect.left + found.rect.width / 2,
        y: box.top + iframe.clientTop + found.rect.top,
        mark: () => post('mark'),
        unmark: () => post('unmark')
      }
      if (document.fullscreenElement === frameRef.current) setHeld(offer)
      else ask.offer(offer)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [ask, owner])

  const toggleFullscreen = (): void => {
    const el = frameRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen()
  }

  // The chat is behind the fullscreen element, so asking leaves fullscreen first.
  const askHeld = (): void => {
    if (!held) return
    const offer = held
    setHeld(null)
    void document.exitFullscreen().finally(() => ask.attach(offer))
  }

  return (
    <div className="block">
      {block.title && <div className="viz-title">{block.title}</div>}
      <div className={`viz-frame${isFullscreen ? ' fullscreen' : ''}`} ref={frameRef}>
        {/* Before the frame, so in fullscreen it is the top of the screen. */}
        <div className="viz-bar">
          <span className="viz-bar-title">{block.title}</span>
          {isFullscreen && held && (
            <button className="viz-ask" onMouseDown={(e) => e.preventDefault()} onClick={askHeld}>
              Ask about this
            </button>
          )}
          <button
            className="viz-fullscreen"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {isFullscreen ? '✕' : '⛶'}
          </button>
        </div>
        <iframe
          ref={iframeRef}
          src={block.src}
          title={block.title ?? 'visualization'}
          height={block.height ?? 480}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      </div>
    </div>
  )
}
