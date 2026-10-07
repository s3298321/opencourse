import { useEffect, useRef, useState } from 'react'
import { Form, Link, useLoaderData, useNavigation, useSearchParams, type LoaderFunctionArgs } from 'react-router'
import { ArrowRight, Download, Search, X } from 'lucide-react'
import type { CatalogPage, CatalogTag } from '@core/catalog/api'
import { api } from '../lib/api'
import { server, takeBootData } from '../lib/boot'
import { plural } from '../lib/format'
import { CourseCard, CourseCardSkeleton } from '../components/CourseCard'
import { EmptyState, Pager, useTitle } from '../components/Bits'
import { Sparkles } from '../components/Brand'

export interface CatalogData { page: CatalogPage; tags: CatalogTag[] }

export async function catalogLoader({ request }: LoaderFunctionArgs): Promise<CatalogData> {
  const url = new URL(request.url)
  const booted = takeBootData('catalog', url)
  if (booted) return { page: booted.page, tags: booted.tags }
  const [page, tags] = await Promise.all([api.catalog(url.search, request.signal), api.tags(request.signal)])
  return { page, tags: tags.tags }
}

/** Without a search the default order is popularity, so "Best match" is only offered with one. */
const sortsFor = (q: string): { value: string; label: string }[] => q
  ? [{ value: '', label: 'Best match' }, { value: 'downloads', label: 'Popular' }, { value: 'recent', label: 'Recent' }, { value: 'title', label: 'A–Z' }]
  : [{ value: '', label: 'Popular' }, { value: 'recent', label: 'Recent' }, { value: 'title', label: 'A–Z' }]

/** The current query with one thing changed; page goes back to 1 unless it is the change. */
function withParams(params: URLSearchParams, change: (next: URLSearchParams) => void): string {
  const next = new URLSearchParams(params)
  next.delete('page')
  change(next)
  const text = next.toString()
  return text ? `/?${text}` : '/'
}

export function CatalogPageView() {
  const { page, tags } = useLoaderData() as CatalogData
  const [params] = useSearchParams()
  const navigation = useNavigation()
  const q = params.get('q') ?? ''
  const sort = !q && params.get('sort') === 'downloads' ? '' : params.get('sort') ?? ''
  const selected = params.getAll('tag').map((t) => t.toLowerCase())
  const filtered = Boolean(q || selected.length)
  const [value, setValue] = useState(q)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setValue(q), [q])
  useTitle('')
  const loading = navigation.state === 'loading' && navigation.location?.pathname === '/'

  return (
    <div className="catalog">
      <section className="catalog-hero">
        <div className="oc-aurora" aria-hidden="true" />
        <Sparkles count={8} className="hero-sparkles" />
        <div className="oc-wrap catalog-hero-inner oc-stagger">
          <span className="hero-eyebrow"><span className="oc-sparkle" aria-hidden="true" />Course catalog</span>
          <h1 className="hero-title oc-silver-text">{server.name}</h1>
          {server.description && <p className="hero-lede">{server.description}</p>}
          <Form method="get" action="/" role="search" className="hero-search" preventScrollReset>
            <div className="hero-search-field">
              <Search aria-hidden />
              <input ref={input} data-search type="search" name="q" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Search courses, subjects, authors…" aria-label="Search courses" autoComplete="off" />
              {value && <button type="button" className="hero-search-clear" aria-label="Clear the search" onClick={() => { setValue(''); input.current?.focus() }}><X aria-hidden /></button>}
              <kbd className="oc-kbd" aria-hidden="true">/</kbd>
            </div>
            {selected.map((tag) => <input key={tag} type="hidden" name="tag" value={tag} />)}
            {sort && <input type="hidden" name="sort" value={sort} />}
            <button type="submit" className="oc-btn lg">Search</button>
          </Form>
        </div>
      </section>

      <div className="oc-wrap catalog-body">
        {tags.length > 0 && (
          <nav className="tag-row oc-enter" aria-label="Filter by tag">
            <Link to={withParams(params, (next) => next.delete('tag'))} className="oc-chip" aria-current={selected.length === 0 ? 'true' : undefined} preventScrollReset>All</Link>
            {tags.map((tag) => {
              const on = selected.includes(tag.tag)
              return (
                <Link
                  key={tag.tag}
                  className="oc-chip"
                  aria-current={on ? 'true' : undefined}
                  preventScrollReset
                  to={withParams(params, (next) => {
                    next.delete('tag')
                    for (const t of on ? selected.filter((x) => x !== tag.tag) : [...selected, tag.tag]) next.append('tag', t)
                  })}
                >
                  {tag.tag}<span className="count">{tag.count}</span>
                </Link>
              )
            })}
          </nav>
        )}

        <div className="results-bar">
          <p className="results-count" aria-live="polite">
            {page.total ? plural(page.total, 'course') : 'No courses'}
            {q && <> for <strong>“{q}”</strong></>}
            {filtered && <Link to="/" className="results-clear" preventScrollReset>Clear filters</Link>}
          </p>
          <div className="oc-segment" role="group" aria-label="Sort">
            {sortsFor(q).map((option) => (
              <Link
                key={option.value}
                to={withParams(params, (next) => { if (option.value) next.set('sort', option.value); else next.delete('sort') })}
                aria-current={sort === option.value ? 'page' : undefined}
                preventScrollReset
              >{option.label}</Link>
            ))}
          </div>
        </div>

        {page.courses.length > 0 ? (
          <ul className={`course-grid oc-stagger${loading ? ' is-loading' : ''}`} key={`${params.toString()}`}>
            {page.courses.map((course) => <CourseCard key={course.id} course={course} />)}
          </ul>
        ) : loading ? (
          <ul className="course-grid">{Array.from({ length: 6 }, (_, i) => <CourseCardSkeleton key={i} />)}</ul>
        ) : filtered ? (
          <EmptyState title="Nothing matches that" actions={<Link className="oc-btn secondary" to="/">Show every course</Link>}>
            Try fewer words, or another tag. Search matches titles, descriptions, subjects, authors and lesson titles.
          </EmptyState>
        ) : (
          <EmptyState title="No courses here yet" actions={<a className="oc-btn" href={server.appUrl}><Download aria-hidden />Get OpenCourse</a>}>
            Courses are published from the OpenCourse app: open a course in its editor and choose <strong>Publish</strong>. The first one will appear right here.
          </EmptyState>
        )}

        <Pager page={page.page} pageSize={page.pageSize} total={page.total} href={(n) => withParams(params, (next) => { if (n > 1) next.set('page', String(n)) })} />

        <HowItWorks />
      </div>
    </div>
  )
}

export function CatalogFallback() {
  return (
    <div className="catalog">
      <section className="catalog-hero"><div className="oc-aurora" aria-hidden="true" /><div className="oc-wrap catalog-hero-inner"><div className="oc-skeleton hero-skeleton" /></div></section>
      <div className="oc-wrap catalog-body"><ul className="course-grid">{Array.from({ length: 6 }, (_, i) => <CourseCardSkeleton key={i} />)}</ul></div>
    </div>
  )
}

function HowItWorks() {
  const address = server.publicUrl.replace(/^https?:\/\//, '')
  return (
    <section className="how oc-reveal" aria-labelledby="how-title">
      <div className="how-head">
        <span className="oc-eyebrow">How it works</span>
        <h2 id="how-title">Learn any of these in the OpenCourse app</h2>
      </div>
      <ol className="how-steps">
        <li className="oc-panel oc-edge"><span className="how-n">1</span><h3>Get OpenCourse</h3><p>A free Mac app for courses on any subject: lessons, quizzes, flashcards and exercises that grade themselves.</p><a href={server.appUrl} className="how-link">Download<ArrowRight aria-hidden /></a></li>
        <li className="oc-panel oc-edge"><span className="how-n">2</span><h3>Connect to this server</h3><p>In <strong>Settings ▸ Servers</strong>, add <code>{address}</code> and sign in - or create an account right in the app.</p></li>
        <li className="oc-panel oc-edge"><span className="how-n">3</span><h3>Add a course</h3><p>Pick it from the <strong>Course catalog</strong> tab. Your progress stays on your Mac, and updates keep it.</p></li>
      </ol>
    </section>
  )
}
