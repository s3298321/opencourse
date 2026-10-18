import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocumentSection } from '@core/documents/types'

interface Heading { section: DocumentSection; children: Heading[]; parent?: Heading }

export default function DocumentOutline({ sections, currentId, jump, revealSignal }: {
  sections: DocumentSection[]; currentId?: string; jump: (page: number, top?: number) => void; revealSignal: number
}) {
  const prefix = useId()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const lastCurrent = useRef<string | undefined>(undefined)
  const lastReveal = useRef(0), pendingReveal = useRef<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  const { roots, headings } = useMemo(() => {
    const roots: Heading[] = [], stack: Heading[] = [], headings = new Map<string, Heading>()
    // Keep bookmark order: destinations need not follow page order, and levels can skip.
    for (const section of sections) {
      while (stack.length && stack.at(-1)!.section.depth >= section.depth) stack.pop()
      const parent = stack.at(-1), heading: Heading = { section, children: [], parent }
      ;(parent ? parent.children : roots).push(heading)
      headings.set(section.id, heading)
      stack.push(heading)
    }
    return { roots, headings }
  }, [sections])
  useLayoutEffect(() => {
    // An explicit progress jump also reveals the path when the current section hasn't changed.
    const reveal = lastReveal.current !== revealSignal
    lastReveal.current = revealSignal
    if (lastCurrent.current === currentId && !reveal) return
    lastCurrent.current = currentId
    pendingReveal.current = reveal ? currentId ?? null : null
    let parent = currentId ? headings.get(currentId)?.parent : undefined
    const ancestors: string[] = []
    while (parent) { ancestors.push(parent.section.id); parent = parent.parent }
    if (ancestors.length) setCollapsed(previous => {
      if (!ancestors.some(id => previous.has(id))) return previous
      const next = new Set(previous)
      ancestors.forEach(id => next.delete(id))
      return next
    })
  }, [currentId, headings, revealSignal])
  useLayoutEffect(() => {
    const row = pendingReveal.current ? rows.current.get(pendingReveal.current) : undefined
    // Wait for the expanded ancestors to reach the DOM before measuring the heading.
    if (!row || row.closest('[hidden]')) return
    const scroller = row.closest<HTMLElement>('.document-outline-scroll')
    if (!scroller) return
    const top = scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop
    scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight))
    pendingReveal.current = null
  }, [collapsed, currentId, revealSignal])
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const branches = [...headings.values()].filter(heading => heading.children.length)
  const renderHeading = ({ section, children }: Heading, level = 0) => {
    const expanded = !collapsed.has(section.id), groupId = `${prefix}-${section.id}`
    return <li key={section.id}>
      <div ref={element => { if (element) rows.current.set(section.id, element); else rows.current.delete(section.id) }} className={`document-section-row${section.id === currentId ? ' active' : ''}`} style={{ paddingLeft: 8 + Math.min(level, 4) * 12 }}>
        {children.length ? <button className="document-section-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.title}`} aria-expanded={expanded} aria-controls={groupId} onClick={() => toggle(section.id)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg>
        </button> : <span className="document-section-toggle-space" />}
        <button className={`document-section${section.id === currentId ? ' active' : ''}`} aria-current={section.id === currentId ? 'location' : undefined} onClick={() => jump(section.page, section.top)} title={section.title}><span>{section.title}</span><small>{section.page}</small></button>
      </div>
      {children.length > 0 && <ul id={groupId} hidden={!expanded}>{children.map(child => renderHeading(child, level + 1))}</ul>}
    </li>
  }
  return <>
    {branches.length > 0 && <div className="document-outline-actions">
      <button className="ghost" disabled={!branches.some(heading => collapsed.has(heading.section.id))} onClick={() => setCollapsed(new Set())}>Expand all</button>
      <button className="ghost" disabled={branches.every(heading => collapsed.has(heading.section.id))} onClick={() => setCollapsed(new Set(branches.map(heading => heading.section.id)))}>Collapse all</button>
    </div>}
    <div className="document-outline-scroll"><ul className="document-outline-list">{roots.map(heading => renderHeading(heading))}</ul></div>
  </>
}
