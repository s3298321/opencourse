import { ToolActivityIcon } from './ToolActivityIcon'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatTools } from '../core/chat-tools'
import { activeTools, ToolIcon, type ChatToolOption } from './chat-tool-options'

function ToolName({ tool, text }: { tool: ChatToolOption; text: string }) {
  return <span className="chat-tool-name"><ToolIcon name={tool.id} /><span>{text}</span></span>
}

export default function ActiveChatTools({ tools, supportsWeb }: { tools: ChatTools; supportsWeb: boolean }) {
  const selected = useMemo(() => activeTools({ webSearch: tools.webSearch, plan: tools.plan }, supportsWeb), [tools.webSearch, tools.plan, supportsWeb])
  const slot = useRef<HTMLSpanElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(selected.length)

  useLayoutEffect(() => {
    const container = slot.current, ruler = measure.current
    if (!container || !ruler) return
    const fit = () => {
      const width = container.getBoundingClientRect().width
      const gap = parseFloat(getComputedStyle(ruler).columnGap) || 0
      const widths = (selector: string) => Array.from(ruler.querySelectorAll(selector), el => el.getBoundingClientRect().width)
      const names = widths('[data-full]'), short = widths('[data-short]'), counts = widths('[data-count]')
      let used = names.reduce((sum, w) => sum + w, gap * (names.length - 1))
      if (used <= width) { setVisible(names.length); return }
      // Reserve the count first. Only the last visible name may be shortened.
      for (let n = names.length; n > 0; n--) {
        const hidden = names.length - n
        const countWidth = hidden ? gap + counts[hidden - 1] : 0
        if ((hidden || names.length === 1) && used - names[n - 1] + short[n - 1] + countWidth <= width) {
          setVisible(n)
          return
        }
        used -= names[n - 1] + gap
      }
      setVisible(0)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    observer.observe(ruler)
    return () => observer.disconnect()
  }, [selected])

  if (!selected.length) return <span className="chat-tools-spacer" aria-hidden="true" />
  const shown = Math.min(visible, selected.length)
  const hidden = selected.length - shown
  const description = 'Active tools: ' + selected.map(tool => tool.label).join(', ')
  return <span ref={slot} className="chat-active-tools" role="img" aria-label={description} title={description}>
    <span className="chat-tools-row" aria-hidden="true">
      {selected.slice(0, shown).map((tool, index) => <ToolName key={tool.id} tool={tool} text={tool.label + (hidden && index === shown - 1 ? '…' : '')} />)}
      {shown === 0 && <ToolActivityIcon />}
      {hidden > 0 && <span className="chat-tools-count">{shown === 0 ? '…' : ''}+{hidden}</span>}
    </span>
    <span ref={measure} className="chat-tools-ruler" aria-hidden="true">
      {selected.map(tool => <span key={tool.id} data-full><ToolName tool={tool} text={tool.label} /></span>)}
      {selected.map(tool => <span key={tool.id} data-short><ToolName tool={tool} text={tool.label.slice(0, 3) + '…'} /></span>)}
      {selected.map((tool, i) => <span key={tool.id} data-count className="chat-tools-count">+{i + 1}</span>)}
    </span>
  </span>
}
