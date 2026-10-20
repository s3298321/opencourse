import { useCallback, useEffect, useLayoutEffect, useState, useRef, type RefObject } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { ContentKind, LearningState, PublishedDocument } from '@core/learning/types'
import type { CourseView, Block, ExerciseBlock, QuizBlock } from '@core/types'
import { exerciseLanguage, getToolchain } from '@core/toolchains'
import { call } from '../lib/api'
import { server } from '../lib/boot'
import { useAccount } from '../lib/session'
import ReadingSize from '../../../../app/src/learning-ui/ReadingSize'
import { normalizeReadingScale } from '@core/reading-scale'
import { CourseOutline } from '../components/CourseOutline'
import { ReadingChatDock } from '../components/ReadingChatDock'
import { Html } from '../components/Html'
import { renderMarkdown, plainText } from '../lib/markdown'
import { PdfReader } from './PdfReader'
import { ExerciseCard, ExerciseWorkspace } from '../components/Exercise'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronLeft,
  Check,
  ChevronRight,
  FileText,
  Monitor,
  Search,
  Trash2,
  Layers
} from 'lucide-react'
import { EmptyState, PageHeader, useTitle } from '../components/Bits'

function ContentArtwork({ kind, cover }: { kind: ContentKind; cover?: string }) {
  return (
    <div className={`content-artwork ${kind}`} aria-hidden="true">
      {cover ? (
        <img src={cover} alt="" />
      ) : (
        <>
          <span className="content-artwork-orbit" />
          {kind === 'course' ? <BookOpen /> : <FileText />}
        </>
      )}
    </div>
  )
}
function LoadingCards() {
  return (
    <div className="learning-grid" role="status" aria-label="Loading library">
      {[1, 2, 3].map((n) => (
        <div key={n} className="oc-skeleton library-skeleton" />
      ))}
    </div>
  )
}

export function MyLearning() {
  useTitle('My learning')
  const [items, setItems] = useState<LearningState[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [filter, setFilter] = useState<ContentKind>('course')
  const refresh = () =>
    void call<{ items: LearningState[] }>('GET', '/me/learning')
      .then((r) => {
        setItems(r.items)
        setError('')
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  useEffect(refresh, [])
  const visible = items.filter((s) => s.enrollment.kind === filter)
  return (
    <div className="oc-wrap page learning-library">
      <PageHeader title="My learning" />
      <div className="library-toolbar">
        <div className="oc-segment" role="group" aria-label="Filter My learning">
          {(['course', 'document'] as const).map((value) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'course' ? 'Courses' : 'Documents'}{' '}
              <span className="filter-count">{items.filter((s) => s.enrollment.kind === value).length}</span>
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingCards />
      ) : (
        <div className="learning-grid">
          {visible.map((s) => {
            const e = s.enrollment
            const lessons = Object.entries(s.fields).filter(
              ([key, field]) => key.startsWith('lesson:') && field.value === true
            ).length
            const readPage = Number(s.fields.readPage?.value ?? 0)
            // A course opens on its overview, as in the app; a document opens to read.
            const href = e.kind === 'course' ? `/learning/courses/${encodeURIComponent(e.id)}` : `/learn/${e.kind}/${e.id}`
            return (
              <article className="library-card oc-card" key={`${e.kind}:${e.id}`}>
                <Link to={href} className="library-card-link">
                  <ContentArtwork
                    kind={e.kind}
                    cover={s.hasCover ? `/api/v1/learn/${e.kind}/${e.id}/${encodeURIComponent(e.version)}/cover` : undefined}
                  />
                  <div className="library-card-body">
                    <div className="library-card-meta">
                      <span>{e.kind === 'course' ? 'Course' : 'PDF document'}</span>
                      <span>v{e.version}</span>
                    </div>
                    <h2>{e.title}</h2>
                    <p className="library-card-progress">
                      {e.kind === 'course'
                        ? lessons
                          ? `${lessons} ${lessons === 1 ? 'lesson' : 'lessons'} read`
                          : 'Ready for your first lesson'
                        : readPage
                          ? `Read through page ${readPage}`
                          : 'Ready to start reading'}
                    </p>
                  </div>
                </Link>
                {/* A course is removed from its overview; a document opens straight
                    into reading, so its card is where it leaves the library. */}
                {e.kind === 'document' && (
                  <div className="library-card-actions">
                    <button
                      className="oc-btn ghost sm"
                      onClick={() => {
                        if (confirm(`Remove “${e.title}” from My learning on all devices? Progress and chats are retained.`))
                          void call('DELETE', `/me/learning/document/${encodeURIComponent(e.id)}`)
                            .then(refresh)
                            .catch((err) => setError(err.message))
                      }}
                    >
                      <Trash2 aria-hidden /> Remove
                    </button>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
      {!loading && !visible.length && !error && (
        <EmptyState title={items.length ? 'Nothing here yet' : 'Make room for something new'}>
          <p>Add a course or document to your library and start learning at your own pace.</p>
        </EmptyState>
      )}
    </div>
  )
}
export function DocumentsCatalog() {
  useTitle('Documents')
  const [items, setItems] = useState<PublishedDocument[]>([]),
    [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void call<{ documents: PublishedDocument[]; total: number }>(
      'GET',
      `/documents?q=${encodeURIComponent(q)}&page=${page}`,
      undefined,
      controller.signal
    )
      .then((r) => {
        setItems(r.documents)
        setTotal(r.total)
        setError('')
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [q, page])
  return (
    <div className="oc-wrap page document-catalog">
      <PageHeader title="Document catalog" />
      <div className="library-toolbar">
        <div className="library-search">
          <Search aria-hidden />
          <input
            data-search
            type="search"
            aria-label="Search documents"
            placeholder="Search documents…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
          <kbd className="oc-kbd">/</kbd>
        </div>
        <span className="library-result-count" role="status">
          {loading ? 'Finding documents…' : `${total} ${total === 1 ? 'document' : 'documents'}`}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingCards />
      ) : (
        <div className="learning-grid">
          {items.map((d) => (
            <article className="library-card oc-card" key={d.id}>
              <Link to={`/documents/${d.id}`} tabIndex={-1} aria-hidden="true">
                <ContentArtwork kind="document" cover={d.hasCover ? `/api/v1/documents/${d.id}/cover` : undefined} />
              </Link>
              <div className="library-card-body">
                <div className="library-card-meta">
                  <span>PDF document</span>
                  <span>
                    {d.pages} {d.pages === 1 ? 'page' : 'pages'}
                  </span>
                </div>
                <h2>
                  <Link to={`/documents/${d.id}`}>{d.title}</Link>
                </h2>
                <p className="library-card-description">
                  {plainText(d.description) || 'Open this document to explore its contents.'}
                </p>
                <div className="library-card-footer">
                  <span>By {d.publisher}</span>
                  <Link to={`/documents/${d.id}`} aria-label={`View ${d.title}`}>
                    <ArrowRight />
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !items.length && !error && (
        <EmptyState
          title={q ? 'No documents found' : undefined}
          actions={
            q && (
              <button className="oc-btn secondary" onClick={() => setQ('')}>
                Clear search
              </button>
            )
          }
        >
          <p>{q ? 'Try a different title or a broader search.' : 'Documents published to this server will appear here.'}</p>
        </EmptyState>
      )}
      {total > 30 && (
        <nav className="pager" aria-label="Document pages">
          <button className="oc-btn secondary sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft /> Previous
          </button>
          <span>
            Page {page} of {Math.ceil(total / 30)}
          </span>
          <button className="oc-btn secondary sm" disabled={page * 30 >= total} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight />
          </button>
        </nav>
      )}
    </div>
  )
}
export function DocumentOverview() {
  const { id } = useParams(),
    [item, setItem] = useState<PublishedDocument | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  useTitle(item?.title ?? 'Document')
  useEffect(() => {
    void call<PublishedDocument>('GET', `/documents/${id}`)
      .then(setItem)
      .catch((e) => setError(e.message))
  }, [id])
  return (
    <div className="oc-wrap page">
      <Link className="back-link" to="/documents">
        <ArrowLeft /> Documents
      </Link>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!item && !error && <LoadingCards />}
      {item && (
        <div className="document-overview">
          <aside className="document-overview-aside oc-panel">
            <ContentArtwork kind="document" cover={item.hasCover ? `/api/v1/documents/${item.id}/cover` : undefined} />
            <div className="document-overview-action">
              <span className="oc-eyebrow">Your next read</span>
              <p>
                {item.pages} {item.pages === 1 ? 'page' : 'pages'} · PDF document
              </p>
              <button
                className="oc-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void call('PUT', `/me/learning/document/${id}`, {})
                    .then(() => navigate(`/learn/document/${id}`))
                    .catch((e) => {
                      if (e.status === 401) navigate(`/signin?next=${encodeURIComponent(`/documents/${id}`)}`)
                      else setError(e.message)
                    })
                    .finally(() => setBusy(false))
                }}
              >
                <BookOpen /> {busy ? 'Adding…' : 'Add to My learning'}
              </button>
              <small>Read here or continue in the desktop app.</small>
              {item.ownedByYou && <Link className="oc-btn secondary" to={`/me/documents/${encodeURIComponent(item.id)}`} viewTransition>Manage</Link>}
            </div>
          </aside>
          <div className="document-overview-body">
            <PageHeader
              eyebrow={
                <>
                  <FileText /> Document · v{item.version}
                </>
              }
              title={item.title}
              description={`Published by ${item.publisher}`}
            />
            <Html className="oc-prose" html={renderMarkdown(item.description)} />
            {item.sections.length > 0 && (
              <section className="document-contents">
                <h2>Inside this document</h2>
                <ol>
                  {item.sections.map((s) => (
                    <li key={s.id}>
                      <span>{s.title}</span>
                      <span>Page {s.page}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
export function WebLearning() {
  const [citedPage, setCitedPage] = useState<{ page: number } | null>(null)
  const account = useAccount()
  const [search, setSearch] = useSearchParams()
  const { kind: rawKind, id } = useParams(),
    kind = rawKind as ContentKind,
    [state, setState] = useState<LearningState | null>(null),
    [course, setCourse] = useState<CourseView | null>(null),
    [document, setDocument] = useState<{ title: string; pages: number; sections: string } | null>(null),
    [error, setError] = useState(''),
    [lesson, setLesson] = useState(0),
    [quote, setQuote] = useState(''),
    [chatOpen, setChatOpen] = useState(false),
    [update, setUpdate] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false),
    [exercise, setExercise] = useState<string | null>(null),
    [opened, setOpened] = useState<number | null>(null)
  useTitle(state?.enrollment.title ?? 'Learning')
  const loaded = useRef('')
  const reader = useRef<HTMLElement>(null)
  const layout = useRef<HTMLDivElement>(null)
  // The columns animate when the chat opens. Opening or leaving an exercise
  // swaps what is in them, and the new layout should simply be there.
  useLayoutEffect(() => {
    const element = layout.current
    if (!element) return
    element.dataset.instant = 'true'
    void getComputedStyle(element).gridTemplateColumns
    delete element.dataset.instant
  }, [exercise])
  // Opening an exercise replaces the lesson and goes to the top of the page, so
  // where the lesson was is kept here: Back to lesson lands on the exercise you
  // left, not the lesson's first line. Moving to another lesson forgets it.
  const lessonScroll = useRef<number | null>(null)
  useLayoutEffect(() => {
    const want = lessonScroll.current
    if (exercise !== null || want === null) return
    lessonScroll.current = null
    window.scrollTo({ top: want, behavior: 'instant' })
    if (window.scrollY >= want) return
    // The lesson has just mounted again and is not its full height yet - an
    // image without its size yet - so the browser stops short. Keep asking
    // for a little while rather than leave the reader above where they were.
    let frames = 0
    let raf = requestAnimationFrame(function retry(): void {
      window.scrollTo({ top: want, behavior: 'instant' })
      if (window.scrollY < want && frames++ < 40) raf = requestAnimationFrame(retry)
    })
    return () => cancelAnimationFrame(raf)
  }, [exercise])
  const load = useCallback(async () => {
    try {
      const library = await call<{ items: LearningState[] }>('GET', '/me/learning'),
        s = library.items.find((x) => x.enrollment.kind === kind && x.enrollment.id === id)
      if (!s) throw new Error('Add this item to My learning first.')
      const result = await call<{ state: LearningState; course?: CourseView; document?: typeof document }>(
        'GET',
        `/learn/${kind}/${id}/${s.enrollment.version}`
      )
      setState(result.state)
      setCourse(result.course ?? null)
      setDocument(result.document ?? null)
      if (loaded.current !== `${kind}:${id}:${s.enrollment.version}`) {
        loaded.current = `${kind}:${id}:${s.enrollment.version}`
        // The overview links to one item by ?module=&lesson=; otherwise resume where the learner left off.
        const asked = search.get('module') ? { moduleId: search.get('module')!, lessonId: search.get('lesson') ?? undefined } : null
        const last = asked ?? (result.state.fields.lastItem?.value as { moduleId?: string; lessonId?: string } | undefined)
        const index = Math.max(
          0,
          result.course?.flatItems.findIndex(
            (i) => i.moduleId === last?.moduleId && (i.kind === 'project' || i.lessonId === last?.lessonId)
          ) ?? 0
        )
        setLesson(index)
        // Opening a lesson from the overview is opening it: Continue comes back here,
        // and so does a reload, once the address no longer names the lesson.
        if (asked && result.course) setOpened(index)
        if (asked) setSearch({}, { replace: true })
      }
      const latest = await call<{ version: string }>(
        'GET',
        `/${kind === 'course' ? 'courses' : 'documents'}/${id}`
      ).catch(() => null)
      setUpdate(latest && latest.version !== s.enrollment.version ? latest.version : null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [kind, id])
  useEffect(() => {
    setState(null)
    setChatOpen(false)
    setQuote('')
    setCourse(null)
    setLesson(0)
    lessonScroll.current = null
    setExercise(null)
    void load()
    const timer = setInterval(() => void load(), 30000)
    return () => clearInterval(timer)
  }, [load])
  async function action(field: string, value: unknown): Promise<string | null> {
    if (!state) return null
    try {
      const op = {
        kind,
        id,
        version: state.enrollment.version,
        generation: state.enrollment.generation,
        epoch: state.epoch,
        at: Date.now(),
        idempotencyKey: crypto.randomUUID(),
        field,
        value
      }
      setSaving(true)
      setSaved(false)
      setState((s) =>
        s ? { ...s, fields: { ...s.fields, [field]: { value, at: op.at, operation: op.idempotencyKey } } } : s
      )
      const r = await call<{ rejected: unknown[] }>('POST', '/sync', { operations: [op] })
      if (r.rejected.length) throw new Error('Progress changed on another device. Reload before trying again.')
      setSaved(true)
      return op.idempotencyKey
    } catch (e) {
      setError((e as Error).message)
      void load()
      return null
    } finally {
      setSaving(false)
    }
  }
  useEffect(() => {
    if (opened === null || !state || !course?.flatItems[opened]) return
    setOpened(null)
    void action('lastItem', course.flatItems[opened])
  }, [opened, state, course])
  function go(index: number) {
    if (!course || !course.flatItems[index]) return
    lessonScroll.current = null
    setLesson(index)
    setExercise(null)
    requestAnimationFrame(() => {
      if (!reader.current) return
      const headerBottom = window.document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 61
      const outlineHeight = window.matchMedia('(max-width: 700px)').matches
        ? (window.document.querySelector('.course-reading-outline')?.getBoundingClientRect().height ?? 0)
        : 0
      window.scrollTo({
        top: window.scrollY + reader.current.getBoundingClientRect().top - headerBottom - outlineHeight - 16,
        behavior: 'instant'
      })
    })
    void action('lastItem', course.flatItems[index])
  }
  if (!state)
    return (
      <div className="oc-wrap page">
        <Link to="/learning">My learning</Link>
        <p role={error ? 'alert' : undefined}>{error || 'Loading…'}</p>
      </div>
    )
  const source = { kind, id: id!, version: state.enrollment.version },
    item = course?.flatItems[lesson],
    module = course?.modules.find((m) => m.slug === item?.moduleId),
    current =
      module?.type !== 'project' && item?.kind === 'lesson'
        ? module?.lessons.find((l) => l.slug === item.lessonId)
        : null,
    open = current?.blocks.find((b): b is ExerciseBlock => b.type === 'exercise' && b.id === exercise)
  const exercises: ExerciseControls = {
    done: (b) => Boolean((state.fields[`exercise:${b.id}`]?.value as { completedAt?: string } | null)?.completedAt),
    started: (b) => typeof state.fields[`code:${b.id}`]?.value === 'string',
    open: (b) => {
      lessonScroll.current = window.scrollY
      setExercise(b.id)
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    },
    toggle: (b, done) => {
      const startedAt = (state.fields[`exercise:${b.id}`]?.value as { startedAt?: string } | null)?.startedAt
      void action(
        `exercise:${b.id}`,
        done
          ? { ...(startedAt ? { startedAt } : {}), completedAt: new Date().toISOString() }
          : startedAt
            ? { startedAt }
            : null
      )
    }
  }
  return (
    <div className="oc-wrap page learning-page" data-course-reader={Boolean(course)} data-document-reader={Boolean(document)}>
      <span className="oc-visually-hidden" role="status" aria-label="Progress saving status">
        {saving ? 'Saving progress…' : saved ? 'Progress saved' : ''}
      </span>
      {error && <p role="alert">{error}</p>}
      {update && (
        <button
          className="oc-btn secondary"
          onClick={() => {
            if (
              confirm(
                `Update to ${update}? Course progress follows existing lessons. A changed PDF starts new reading progress.`
              )
            )
              void call('PUT', `/me/learning/${kind}/${id}`, { version: update })
                .then(load)
                .catch((e) => setError(e.message))
          }}
        >
          Update to {update}
        </button>
      )}
      <div
        className="web-learning-layout"
        ref={layout}
        data-chat-open={chatOpen}
        data-has-outline={Boolean(course)}
        data-workbench={Boolean(open)}
      >
        {course && <CourseOutline course={course} state={state} current={lesson} onNavigate={go} />}
        <div className="web-reader-column">
          <section
            className="web-reading"
            ref={reader}
            style={
              {
                '--reading-scale': normalizeReadingScale(state.fields['preference:readingScale']?.value)
              } as import('react').CSSProperties
            }
          >
            {course && open && (
              <ExerciseWorkspace
                key={open.id}
                block={open}
                {...exerciseTools(course, open)}
                synced={state.fields[`code:${open.id}`]}
                brief={
                  <ExerciseCard
                    block={open}
                    mode="brief"
                    done={exercises.done(open)}
                    started
                    onToggleDone={(done) => exercises.toggle(open, done)}
                  />
                }
                onSave={(code) => action(`code:${open.id}`, code)}
                onClose={() => setExercise(null)}
              />
            )}
            {course && !open && (
              <>
                <div className="reader-content">
                  {!(
                    current?.blocks[0]?.type === 'markdown' &&
                    /^#{1,6}\s+(.+?)(?:\s+#+)?(?:\n|$)/.exec(current.blocks[0].content.trimStart())?.[1]?.trim() ===
                      item?.title?.trim()
                  ) && <h2 className="lesson-title">{item?.title}</h2>}
                  {module?.type === 'project' ? (
                    <>
                      <Html className="oc-prose" html={renderMarkdown(module.project.definition ?? '')} />
                      <AppRequired />
                    </>
                  ) : (
                    current && (
                      <>
                        {current.blocks.map((b) => (
                          <LearningBlock
                            key={b.slug}
                            block={b}
                            base={`/learn/course/${id}/${source.version}`}
                            onSaved={load}
                            exercises={exercises}
                          />
                        ))}
                        <div className="lesson-complete">
                          <button
                            className={`oc-btn${state.fields[`lesson:${current.slug}`]?.value === true ? ' secondary' : ''}`}
                            aria-pressed={state.fields[`lesson:${current.slug}`]?.value === true}
                            onClick={() =>
                              void action(`lesson:${current.slug}`, state.fields[`lesson:${current.slug}`]?.value !== true)
                            }
                          >
                            <Check />
                            {state.fields[`lesson:${current.slug}`]?.value === true ? 'Lesson completed' : 'Mark lesson completed'}
                          </button>
                        </div>
                      </>
                    )
                  )}
                </div>
                <div className="learning-nav">
                  <button className="oc-btn secondary" disabled={lesson === 0} onClick={() => go(lesson - 1)}>
                    <ChevronLeft /> Previous
                  </button>
                  <button
                    className="oc-btn"
                    disabled={lesson === course.flatItems.length - 1}
                    onClick={() => go(lesson + 1)}
                  >
                    Next <ChevronRight />
                  </button>
                </div>
              </>
            )}
            {document && (
              <PdfReader
                key={`${source.id}:${source.version}`}
                source={source}
                document={document}
                initialPage={Number(state.fields.position?.value ?? 1)}
                requestedPage={citedPage}
                zoom={Number(state.fields['preference:pdfZoom']?.value ?? 1)}
                onZoom={(z) => void action('preference:pdfZoom', z)}
                readPage={Number(state.fields.readPage?.value ?? 0)}
                onPage={(p) => void action('position', p)}
                onRead={(p) => void action('readPage', p)}
                outlineKey={`web-document-outline:${account?.id}:${id}`}
              />
            )}
          </section>
        </div>
        {/* A grid item of its own, in the outline's cell (see app.css), so it
            stays beside the outline and never sinks below the outline's foot. */}
        {course && (
          <ReadingSize
            scale={normalizeReadingScale(state.fields['preference:readingScale']?.value)}
            onChange={(scale) => void action('preference:readingScale', scale)}
          />
        )}
        <ReadingChatDock
          key={`${kind}:${id}:${source.version}`}
          open={chatOpen}
          onOpenChange={setChatOpen}
          draftKey={`web:${account?.id}:${kind}:${id}:${source.version}`}
          source={source}
          quote={quote}
          onQuoteUsed={() => setQuote('')}
          onSource={citation => {
            if (citation.page) setCitedPage({ page: citation.page })
            else if (course && citation.moduleId) {
              const index = course.flatItems.findIndex(item => item.moduleId === citation.moduleId && (item.kind === 'project' ? !citation.lessonId : item.lessonId === citation.lessonId))
              if (index >= 0) go(index)
            }
          }}
        />
      </div>
      <AskAboutOffer
        reader={reader}
        onAsk={(text) => {
          setQuote(text)
          setChatOpen(true)
        }}
      />
    </div>
  )
}
/**
 * Offer to ask the chat about whatever was just highlighted in the reader, the
 * way the desktop app does. Highlighting is also how people copy and re-read,
 * so a selection is only an offer until the button is pressed.
 *
 * Bound to the document, because a drag that ends outside the text still
 * finishes a selection. A touch selection is adjusted by its handles without
 * any pointer events reaching the page, so a settled `selectionchange` counts
 * too - but not while a press is down, or the offer would chase the drag.
 */
function AskAboutOffer({ reader, onAsk }: { reader: RefObject<HTMLElement | null>; onAsk: (text: string) => void }) {
  const [offer, setOffer] = useState<{ text: string; range: Range; x: number; y: number } | null>(null)
  useEffect(() => {
    let pressed = false
    let timer = 0
    const place = (range: Range) => {
      const box = range.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top, visible: Boolean(box.width || box.height) }
    }
    const update = () => {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''
      const root = reader.current
      if (!selection || !text || text.length > 8000 || selection.rangeCount === 0 || !root) return setOffer(null)
      const range = selection.getRangeAt(0)
      const node = range.commonAncestorContainer
      const element = node instanceof Element ? node : node.parentElement
      // Selecting in the editor or a field is editing, not a question about the
      // lesson. (The editor is in a shadow root, so its selection is its host.)
      if (!element || !root.contains(element) || element.closest('.editor-host, input, textarea, select')) return setOffer(null)
      const at = place(range)
      if (!at.visible) return setOffer(null)
      setOffer({ text, range: range.cloneRange(), x: at.x, y: at.y })
    }
    const down = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.ask-about')) return
      pressed = true
    }
    const up = (event: PointerEvent) => {
      // The release that presses the offer is not a new selection; without
      // this the button unmounts between pointerup and click.
      if ((event.target as Element | null)?.closest?.('.ask-about')) return
      pressed = false
      // The selection a click collapses is only collapsed after pointerup.
      window.clearTimeout(timer)
      timer = window.setTimeout(update, 0)
    }
    const changed = () => {
      if (pressed) return
      window.clearTimeout(timer)
      timer = window.setTimeout(update, 250)
    }
    // The offer is fixed to the viewport, so it follows its passage instead.
    const follow = () =>
      setOffer((current) => {
        if (!current) return current
        const at = place(current.range)
        return at.visible ? { ...current, x: at.x, y: at.y } : null
      })
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    document.addEventListener('selectionchange', changed)
    window.addEventListener('scroll', follow, { passive: true, capture: true })
    window.addEventListener('resize', follow)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('selectionchange', changed)
      window.removeEventListener('scroll', follow, { capture: true })
      window.removeEventListener('resize', follow)
    }
  }, [reader])
  if (!offer) return null
  return (
    <button
      type="button"
      className="ask-about"
      style={{ left: Math.min(Math.max(offer.x, 64), window.innerWidth - 64), top: Math.max(offer.y, 8) }}
      // A press must not take the selection with it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onAsk(offer.text)
        setOffer(null)
      }}
    >
      Ask about this
    </button>
  )
}
function AppRequired() {
  return (
    <div className="app-required">
      <span className="app-required-icon">
        <Monitor />
      </span>
      <p>Complete this activity in the desktop app.</p>
      <a className="oc-btn secondary" href={server.appUrl}>
        Download the app
      </a>
    </div>
  )
}
interface ExerciseControls {
  done: (b: ExerciseBlock) => boolean
  started: (b: ExerciseBlock) => boolean
  open: (b: ExerciseBlock) => void
  toggle: (b: ExerciseBlock, done: boolean) => void
}
/** Which language an exercise is in, from the same descriptors the app runs it with. */
function exerciseTools(course: CourseView, block: ExerciseBlock) {
  const language = exerciseLanguage(course, block)
  try {
    const toolchain = getToolchain(language)
    return { language: toolchain.id, languageLabel: toolchain.label, indentUnit: toolchain.indentUnit }
  } catch {
    return { language, languageLabel: language, indentUnit: '    ' }
  }
}
/** A fence longer than any backtick run inside, so the code cannot close it early. */
function codeFence(code: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${fence}${language}\n${code}\n${fence}`
}
function LearningBlock({
  block: b,
  base,
  onSaved,
  exercises
}: {
  block: Block
  base: string
  onSaved: () => void
  exercises: ExerciseControls
}) {
  switch (b.type) {
    case 'markdown':
      return <Html className="oc-prose lesson-prose" html={renderMarkdown(b.content)} />
    case 'image':
      return <img src={b.src} alt={b.alt ?? ''} />
    case 'video':
      return <video src={b.src} controls poster={b.poster} />
    case 'visualization':
      return (
        <figure className="learning-visualization">
          <figcaption>
            <Layers /> {b.title ?? 'Interactive visualization'}
          </figcaption>
          <iframe
            title={b.title ?? 'Interactive visualization'}
            src={b.src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        </figure>
      )
    case 'quiz':
      return <WebQuiz quiz={b} base={base} onSaved={onSaved} />
    case 'exercise':
      return (
        <ExerciseCard
          block={b}
          done={exercises.done(b)}
          started={exercises.started(b)}
          onOpen={() => exercises.open(b)}
          onToggleDone={(done) => exercises.toggle(b, done)}
        />
      )
    case 'python-cell':
      // Read-only on the web, shown as the code block it would be in markdown.
      return <Html className="oc-prose lesson-prose" html={renderMarkdown(codeFence(b.content, 'python'))} />
    default:
      return null
  }
}
function WebQuiz({ quiz, base, onSaved }: { quiz: QuizBlock; base: string; onSaved: () => void }) {
  const [submitted, setSubmitted] = useState<string[]>([]),
    [result, setResult] = useState<{ isCorrect: boolean; explanation?: string } | null>(null),
    [error, setError] = useState('')
  return (
    <form
      className="oc-panel learning-card"
      onSubmit={(e) => {
        e.preventDefault()
        void call<typeof result>('POST', `${base}/quiz/${quiz.id}`, { submitted, requestId: crypto.randomUUID() })
          .then((r) => {
            setResult(r)
            onSaved()
          })
          .catch((e) => setError(e.message))
      }}
    >
      <span className="oc-eyebrow">Knowledge check</span>
      <Html className="oc-prose" html={renderMarkdown(quiz.question)} />
      {quiz.kind === 'text' ? (
        <input aria-label="Your answer" value={submitted[0] ?? ''} onChange={(e) => setSubmitted([e.target.value])} />
      ) : (
        quiz.options?.map((o) => (
          <label className="quiz-option" key={o.id}>
            <input
              type={quiz.kind === 'single' ? 'radio' : 'checkbox'}
              name={quiz.id}
              checked={submitted.includes(o.id)}
              onChange={(e) =>
                setSubmitted(
                  quiz.kind === 'single'
                    ? [o.id]
                    : e.target.checked
                      ? [...submitted, o.id]
                      : submitted.filter((v) => v !== o.id)
                )
              }
            />
            {o.text}
          </label>
        ))
      )}
      <button className="oc-btn" disabled={!submitted.length}>
        Check answer
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>{result.isCorrect ? 'Correct' : 'Try again'}</p>
          {result.explanation && <Html html={renderMarkdown(result.explanation)} />}
        </>
      )}
    </form>
  )
}
