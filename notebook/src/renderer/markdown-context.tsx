import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { JSX } from 'react'
import { createRenderer, type MarkdownRenderer } from '@core/markdown'

const MarkdownContext = createContext<MarkdownRenderer | null>(null)

export function MarkdownProvider({ children }: { children: ReactNode }): JSX.Element {
  const [renderer, setRenderer] = useState<MarkdownRenderer | null>(null)

  useEffect(() => {
    let alive = true
    void createRenderer().then((r) => {
      if (alive) setRenderer(r)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!renderer) return <div className="empty">Loading…</div>
  return <MarkdownContext.Provider value={renderer}>{children}</MarkdownContext.Provider>
}

export function useMarkdown(): MarkdownRenderer {
  const renderer = useContext(MarkdownContext)
  if (!renderer) throw new Error('useMarkdown outside MarkdownProvider')
  return renderer
}
