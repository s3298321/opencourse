import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { server } from '../lib/boot'
import { Sparkles } from './Brand'

/** Sets the tab's title the way the server's first response did: page, then server. */
export function useTitle(title: string): void {
  useEffect(() => { document.title = title ? `${title} · ${server.name}` : server.name }, [title])
}

export function PageHeader({ eyebrow, title, description, actions, children }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header oc-enter">
      <div className="page-header-text">
        {eyebrow && <span className="oc-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
        {children}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}

export function EmptyState({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state oc-enter">
      <div className="empty-art" aria-hidden="true">
        <Sparkles count={9} />
      </div>
      <h2>{title}</h2>
      {children && <div className="empty-text">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  )
}

/** Previous / page n of m / next, as links so every page has an address. */
export function Pager({ page, pageSize, total, href }: { page: number; pageSize: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  const shown = [...new Set([1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b)
  return (
    <nav className="pager" aria-label="Pages">
      {page > 1 ? <Link className="oc-btn secondary sm" to={href(page - 1)} rel="prev" preventScrollReset={false}><ChevronLeft aria-hidden />Previous</Link> : <span className="oc-btn secondary sm" aria-disabled="true"><ChevronLeft aria-hidden />Previous</span>}
      <span className="pager-pages">
        {shown.map((n, i) => (
          <span key={n} className="pager-slot">
            {i > 0 && n - shown[i - 1]! > 1 && <span className="pager-gap">…</span>}
            <Link to={href(n)} className={n === page ? 'current' : ''} aria-current={n === page ? 'page' : undefined}>{n}</Link>
          </span>
        ))}
      </span>
      {page < pages ? <Link className="oc-btn secondary sm" to={href(page + 1)} rel="next">Next<ChevronRight aria-hidden /></Link> : <span className="oc-btn secondary sm" aria-disabled="true">Next<ChevronRight aria-hidden /></span>}
    </nav>
  )
}

export function Stat({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {children}
    </div>
  )
}
