import ActionButton from './ActionButton'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CatalogCourse, CatalogPage, CatalogSort, CatalogTag } from '@core/catalog/api'
import type { CourseSummary, ServerConnection } from '@core/types'
import type { Route, Screen } from '../routes'

/**
 * Library → Add courses: the selected server's courses. Everything here comes
 * through main (window.opencourse) - the renderer still makes no network
 * request of its own, covers included.
 */
export default function Catalog({ serverId, navigate, route, library, onAdded }: {
  serverId: string
  navigate: (r: Route) => void
  route: Screen
  library: CourseSummary[]
  onAdded: () => void
}): JSX.Element {
  const [servers, setServers] = useState<ServerConnection[] | null>(null)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [sort, setSort] = useState<CatalogSort | ''>('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<CatalogPage | null>(null)
  const [allTags, setAllTags] = useState<CatalogTag[]>([])
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  const loadServers = useCallback(() => { void window.opencourse.listServers().then(setServers).catch(() => setServers([])) }, [])
  useEffect(loadServers, [loadServers])
  useEffect(() => window.opencourse.onServersChanged(loadServers), [loadServers])
  const active = servers?.find((s) => s.id === serverId) ?? null

  // Typing settles before it searches; a new search starts at page one.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(q); setPage(1) }, 250)
    return () => clearTimeout(timer)
  }, [q])

  useEffect(() => {
    if (!active) return undefined
    let alive = true
    setError(null)
    setResult(null)
    void window.opencourse.searchCatalog(active.id, { q: query, tags, sort: sort || undefined, page }).then((r) => {
      if (!alive) return
      if (r.ok) setResult(r.value)
      else { setResult(null); setError(r.message) }
    }).catch((err) => { if (alive) { setResult(null); setError(err.message) } })
    return () => { alive = false }
  }, [active?.id, query, tags, sort, page])

  useEffect(() => {
    if (!active) return
    let alive = true
    void window.opencourse.listCatalogTags(active.id).then((r) => { if (alive) setAllTags(r.ok ? r.value : []) }).catch(() => { if (alive) setAllTags([]) })
    return () => { alive = false }
  }, [active?.id, result?.total])

  if (servers === null) return <p className="meta">Loading…</p>
  if (!active) {
    return (
      <div className="empty-library catalog-empty">
        <h3>No server to browse</h3>
        <p>Course catalogs live on OpenCourse servers. Connect to one in Settings — with an account there, you can add its courses to your library and publish your own.</p>
        <ActionButton icon="settings" onClick={() => navigate({ name: 'settings', from: route, section: 'servers' })}>Open Settings</ActionButton>
      </div>
    )
  }

  const inLibrary = new Set(library.map((c) => c.courseId))
  const add = async (course: CatalogCourse): Promise<void> => {
    setAdding(course.id); setNote(null)
    try {
      const r = await window.opencourse.addCatalogCourse(active.id, course.id)
      if (r.ok) { setNote({ text: `Added “${r.value.title}” (v${r.value.version}) to your courses.`, error: false }); onAdded() }
      else setNote({ text: r.message, error: true })
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally { setAdding(null) }
  }
  const toggleTag = (tag: string): void => { setTags((now) => now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]); setPage(1) }
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1

  return (
    <div className="catalog">
      <div className="catalog-bar">
        <span className="catalog-server-name" title={active.url}>{active.name}</span>
        <input type="search" className="catalog-search" aria-label="Search courses" placeholder="Search by keyword" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Sort courses" value={sort} onChange={(e) => { setSort(e.target.value as CatalogSort | ''); setPage(1) }}>
          <option value="">Best match</option>
          <option value="downloads">Most downloaded</option>
          <option value="recent">Recently updated</option>
          <option value="title">Title</option>
        </select>
      </div>
      {!active.account && (
        <p className="import-note">You are signed out of {active.name}. <button className="ghost catalog-inline" onClick={() => navigate({ name: 'settings', from: route, section: 'servers' })}>Sign in</button> to add courses.</p>
      )}
      {allTags.length > 0 && (
        <div className="catalog-tags" aria-label="Filter by tag">
          {allTags.map((t) => (
            <button key={t.tag} className={`catalog-tag${tags.includes(t.tag) ? ' on' : ''}`} aria-pressed={tags.includes(t.tag)} onClick={() => toggleTag(t.tag)}>
              {t.tag} <span>{t.count}</span>
            </button>
          ))}
        </div>
      )}
      {note && <p className={`import-note${note.error ? ' error' : ''}`} role="status">{note.text}</p>}
      {error && <p className="import-note error" role="alert">{error}</p>}
      {!result && !error && <p className="meta">Loading courses…</p>}
      {result && <p className="meta catalog-count">{result.total === 1 ? '1 course' : `${result.total} courses`}{query || tags.length ? ' match' : ` on ${active.name}`}</p>}
      {result?.courses.length === 0 && <p className="meta">Nothing matches. Try fewer words or tags.</p>}
      <div className="catalog-grid">
        {result?.courses.map((course) => (
          <CatalogCard key={course.id} serverId={active.id} course={course} inLibrary={inLibrary.has(course.id)} adding={adding === course.id} canAdd={Boolean(active.account)}
            onOpen={() => navigate({ name: 'catalogCourse', serverId: active.id, courseId: course.id })}
            onAdd={() => void add(course)}
            onOpenInLibrary={() => navigate({ name: 'course', courseId: course.id })} />
        ))}
      </div>
      {pages > 1 && (
        <nav className="catalog-pager">
          <ActionButton icon="left" className="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</ActionButton>
          <span className="meta">Page {page} of {pages}</span>
          <ActionButton icon="right" className="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</ActionButton>
        </nav>
      )}
    </div>
  )
}

export function useCatalogCover(serverId: string, course: { id: string; version: string; hasCover: boolean }): string | null {
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    if (!course.hasCover) { setCover(null); return undefined }
    let alive = true
    void window.opencourse.getCatalogCover(serverId, course.id, course.version).then((url) => { if (alive) setCover(url) })
    return () => { alive = false }
  }, [serverId, course.id, course.version, course.hasCover])
  return cover
}

function CatalogCard({ serverId, course, inLibrary, adding, canAdd, onOpen, onAdd, onOpenInLibrary }: {
  serverId: string; course: CatalogCourse; inLibrary: boolean; adding: boolean; canAdd: boolean
  onOpen: () => void; onAdd: () => void; onOpenInLibrary: () => void
}): JSX.Element {
  const cover = useCatalogCover(serverId, course)
  return (
    <div className="course-card catalog-card" onClick={onOpen}>
      {cover && <img src={cover} alt="" />}
      <div className="course-card-content">
        <h3 title={course.title}>{course.title}</h3>
        <div className="meta course-card-meta">
          {course.subject ? `${course.subject} · ` : ''}{course.difficulty ?? 'beginner'} · {course.lessonCount} lessons{course.projectCount ? ` · ${course.projectCount} projects` : ''}
          {course.estimatedHours ? ` · ~${course.estimatedHours}h` : ''}
        </div>
        <div className="course-card-origin">
          <span className="version-badge">v{course.version}</span>
          <span className="meta">{course.downloads === 1 ? '1 download' : `${course.downloads} downloads`} · by {course.publisher}</span>
        </div>
        {course.description && <p className="catalog-summary">{course.description.replace(/[#*_`>[\]()]/g, '').slice(0, 220)}</p>}
        <div className="course-card-footer">
          <div className="course-card-tags">{course.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
        </div>
      </div>
      <div className="catalog-card-action" onClick={(e) => e.stopPropagation()}>
        {inLibrary
          ? <ActionButton icon="check" className="secondary" onClick={onOpenInLibrary}>In your library</ActionButton>
          : <ActionButton icon="plus" disabled={adding || !canAdd} onClick={onAdd}>{adding ? 'Adding' : 'Add'}</ActionButton>}
      </div>
    </div>
  )
}
