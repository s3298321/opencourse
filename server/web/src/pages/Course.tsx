import { useState, type ReactNode } from 'react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { ArrowLeft, BookOpen, CheckCircle2, ChevronDown, Clock, Download, FolderKanban, Layers, Plus, Settings2, Sparkles as SparklesIcon } from 'lucide-react'
import type { CourseOverview } from '@core/catalog/api'
import { api, coverUrl } from '../lib/api'
import { server, takeBootData } from '../lib/boot'
import { useAccount } from '../lib/session'
import { capitalize, compact, date, hours, plural } from '../lib/format'
import { renderInline, renderMarkdown } from '../lib/markdown'
import { Cover } from '../components/Cover'
import { Html } from '../components/Html'
import { Dialog } from '../components/Dialog'
import { CopyButton } from '../components/Forms'
import { Stat, useTitle } from '../components/Bits'

export async function courseLoader({ params, request }: LoaderFunctionArgs): Promise<CourseOverview> {
  const url = new URL(request.url)
  const booted = takeBootData('course', url)
  if (booted) return booted.course
  try {
    return await api.course(params['id'] ?? '', request.signal)
  } catch (error) {
    if ((error as { status?: number }).status === 404) throw new Response('Not found', { status: 404 })
    throw error
  }
}

export function CoursePage() {
  const course = useLoaderData() as CourseOverview
  const account = useAccount()
  const [adding, setAdding] = useState(false)
  useTitle(course.title)
  const minutes = course.outline.reduce((sum, m) => sum + m.lessons.reduce((s, l) => s + (l.minutes ?? 0), 0), 0)
  const versions = course.versions.filter((v) => v.status === 'current' || v.status === 'available')
  const counts: { icon: ReactNode; text: string }[] = [{ icon: <BookOpen aria-hidden />, text: plural(course.lessonCount, 'lesson') }]
  if (course.projectCount) counts.push({ icon: <FolderKanban aria-hidden />, text: plural(course.projectCount, 'project') })
  if (course.quizCount) counts.push({ icon: <CheckCircle2 aria-hidden />, text: plural(course.quizCount, 'quiz', 'quizzes') })
  if (course.exerciseCount) counts.push({ icon: <Settings2 aria-hidden />, text: plural(course.exerciseCount, 'exercise') })
  if (course.flashcardCount) counts.push({ icon: <Layers aria-hidden />, text: plural(course.flashcardCount, 'flashcard') })

  return (
    <article className="course-page">
      <section className="course-hero">
        {course.hasCover && <img className="course-hero-glow" src={coverUrl(course.id)} alt="" aria-hidden="true" />}
        <div className="oc-aurora" aria-hidden="true" />
        <div className="oc-wrap">
          <Link to="/" className="back-link" viewTransition><ArrowLeft aria-hidden />Catalog</Link>
          <div className="course-hero-grid">
            <Cover id={course.id} title={course.title} subject={course.subject} hasCover={course.hasCover} className="course-hero-cover" transitionName="course-cover" />
            <div className="course-hero-text oc-stagger">
              {course.subject && <span className="oc-eyebrow">{course.subject}</span>}
              <h1 style={{ viewTransitionName: 'course-title' }}>{course.title}</h1>
              <div className="course-chips">
                {course.difficulty && <span className="oc-pill">{capitalize(course.difficulty)}</span>}
                {hours({ estimatedHours: course.estimatedHours, totalMinutes: course.totalMinutes || minutes }) && <span className="oc-pill"><Clock aria-hidden />{hours({ estimatedHours: course.estimatedHours, totalMinutes: course.totalMinutes || minutes })}</span>}
                {course.tags.map((tag) => <Link key={tag} to={`/?tag=${encodeURIComponent(tag.toLowerCase())}`} className="oc-chip" viewTransition>{tag}</Link>)}
              </div>
              <p className="course-byline">
                {course.author ? <>By <strong>{course.author}</strong> · published by <strong>{course.publisher}</strong></> : <>Published by <strong>{course.publisher}</strong></>}
              </p>
              <div className="course-actions">
                <button type="button" className="oc-btn lg shine" onClick={() => setAdding(true)}><Plus aria-hidden />Add in OpenCourse</button>
                {course.ownedByYou && account && <Link className="oc-btn secondary lg" to={`/me/courses/${encodeURIComponent(course.id)}`} viewTransition>Manage</Link>}
              </div>
            </div>
          </div>
          <div className="course-stats oc-enter">
            <Stat label="Version" value={course.version} />
            <Stat label={course.downloads === 1 ? 'Learner' : 'Learners'} value={compact(course.downloads)} />
            <Stat label="Updated" value={date(course.updatedAt)} />
            <Stat label="Contents" value={plural(course.outline.length, 'module')} />
          </div>
        </div>
      </section>

      <div className="oc-wrap course-layout">
        <div className="course-main">
          {course.description && (
            <section className="course-section oc-reveal">
              <h2>About this course</h2>
              <Html className="oc-prose" html={renderMarkdown(course.description)} />
            </section>
          )}
          {course.prerequisites.length > 0 && (
            <section className="course-section oc-reveal">
              <h2>Before you start</h2>
              <ul className="prereqs">
                {course.prerequisites.map((p, i) => <li key={i}><span className="oc-sparkle" aria-hidden="true" /><Html as="span" html={renderInline(p)} /></li>)}
              </ul>
            </section>
          )}
          <section className="course-section oc-reveal">
            <div className="section-head">
              <h2>Contents</h2>
              <ul className="count-list">{counts.map((c) => <li key={c.text}>{c.icon}{c.text}</li>)}</ul>
            </div>
            <ol className="outline">
              {course.outline.map((module, i) => {
                const moduleMinutes = module.lessons.reduce((sum, l) => sum + (l.minutes ?? 0), 0)
                return (
                  <li key={i}>
                    <details className="outline-module" open={i === 0}>
                      <summary>
                        {/* Authors often number their modules themselves; the page does only for those who do not. */}
                        {!/^\d/.test(module.title) && <span className="outline-n">{String(i + 1).padStart(2, '0')}</span>}
                        <span className="outline-title">{module.title}{module.kind === 'project' && <span className="oc-pill silver">Project</span>}</span>
                        <span className="outline-meta">{plural(module.lessons.length, module.kind === 'project' ? 'part' : 'lesson')}{moduleMinutes ? ` · ${moduleMinutes} min` : ''}</span>
                        <ChevronDown aria-hidden className="outline-caret" />
                      </summary>
                      <ol className="outline-lessons">
                        {module.lessons.map((lesson, j) => (
                          <li key={j}><span className="outline-dot" aria-hidden="true" /><span>{lesson.title}</span>{lesson.minutes ? <span className="outline-mins">{lesson.minutes} min</span> : null}</li>
                        ))}
                      </ol>
                    </details>
                  </li>
                )
              })}
            </ol>
          </section>
          {versions.length > 0 && (
            <section className="course-section oc-reveal">
              <h2>Versions</h2>
              <ol className="timeline">
                {versions.map((v) => (
                  <li key={v.version} className={v.status === 'current' ? 'current' : ''}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <div className="timeline-head">
                      <strong>{v.version}</strong>
                      {v.status === 'current' && <span className="oc-pill ok"><span className="dot" />Current</span>}
                      <time dateTime={v.publishedAt}>{date(v.publishedAt)}</time>
                    </div>
                    {v.releaseNote && <p className="timeline-note">{v.releaseNote}</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <aside className="course-aside">
          <div className="oc-panel oc-edge aside-card">
            <span className="oc-eyebrow"><SparklesIcon aria-hidden />Add this course</span>
            <ol className="mini-steps">
              <li>Open <strong>OpenCourse</strong> on your Mac.</li>
              <li>In <strong>Settings ▸ Servers</strong>, connect to this server.</li>
              <li>Find <strong>{course.title}</strong> in the <strong>Course catalog</strong> tab and add it.</li>
            </ol>
            <div className="server-address">
              <code>{server.publicUrl.replace(/^https?:\/\//, '')}</code>
              <CopyButton text={server.publicUrl} />
            </div>
            <a className="oc-btn secondary aside-get" href={server.appUrl}><Download aria-hidden />Get the app</a>
          </div>
        </aside>
      </div>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add this course in OpenCourse" description="Add the course to the Mac app to read its lessons and save your progress locally." footer={<><a className="oc-btn secondary" href={server.appUrl}><Download aria-hidden />Get the app</a><button type="button" className="oc-btn" onClick={() => setAdding(false)}>Done</button></>}>
        <ol className="dialog-steps">
          <li><span className="how-n">1</span><div><strong>Open OpenCourse</strong><p>Download and install the Mac app if needed.</p></div></li>
          <li><span className="how-n">2</span><div><strong>Connect to this server</strong><p>Go to <strong>Settings ▸ Servers ▸ Connect to a server</strong> and enter:</p><div className="server-address"><code>{server.publicUrl.replace(/^https?:\/\//, '')}</code><CopyButton text={server.publicUrl} /></div></div></li>
          <li><span className="how-n">3</span><div><strong>Add the course</strong><p>Open the <strong>Course catalog</strong> tab, find “{course.title}” and choose <strong>Add</strong>.</p></div></li>
        </ol>
      </Dialog>
    </article>
  )
}
