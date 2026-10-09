import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { findProject, itemSiblings } from '@core/manifest'
import type { CourseItemRef, CourseProgress, CourseView, ProjectWorkspace, UserProfile } from '@core/types'
import { itemRoute, type Route, type Screen } from '../routes'
import { useChatPanel } from '../sidechat/useChat'
import ChatPanel from '../components/ChatPanel'
import Html from '../components/Html'
import Sidebar from '../components/Sidebar'
import TitleBar from '../components/TitleBar'
import Menu from '../components/Menu'
interface Props {
  courseId: string
  moduleId: string
  user: UserProfile | null
  navigate: (route: Route) => void
  route: Screen
  active: boolean
  navSignal: { action: 'prev' | 'next'; n: number } | null
}
export default function Project({ courseId, moduleId, user, navigate, route, active, navSignal }: Props): JSX.Element {
  const target = useMemo(() => ({ courseId: courseId, moduleId }), [courseId, moduleId])
  const [course, setCourse] = useState<CourseView | null>(null)
  const [progress, setProgress] = useState<CourseProgress | null>(null)
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null)
  const [editorId, setEditorId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [openingEditor, setOpeningEditor] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const panel = useChatPanel(courseId, undefined, moduleId, active)
  useEffect(() => window.opencourse.onCoursesChanged(() => setAttempt((n) => n + 1)), [])
  useEffect(() => {
    let alive = true
    setError(null)
    void (async () => {
      try {
        const nextCourse = await window.opencourse.getCourse(courseId)
        if (!alive) return
        setCourse(nextCourse)
        const opened = await window.opencourse.openCourseProject(target)
        const nextProgress = await window.opencourse.getProgress(courseId)
        if (!alive) return
        setWorkspace(opened)
        setProgress(nextProgress)
        setEditorId(opened.editors.some((e) => e.id === opened.preferredEditor) ? opened.preferredEditor! : opened.editors[0]?.id ?? '')
      } catch (err) { if (alive) setError((err as Error).message) }
    })()
    return () => { alive = false }
  }, [courseId, target, attempt])
  useEffect(() => {
    if (!active) return
    let alive = true
    void window.opencourse.getProgress(courseId).then((p) => { if (alive) setProgress(p) })
    return () => { alive = false }
  }, [active, panel.thread, courseId])
  const module = course && findProject(course, moduleId)
  const neighbours = course ? itemSiblings(course, moduleId) : {}
  const go = useCallback((item?: CourseItemRef) => { if (item) navigate(itemRoute(courseId, item)) }, [navigate, courseId])
  useEffect(() => {
    if (!active || !navSignal) return
    go(navSignal.action === 'prev' ? neighbours.prev : neighbours.next)
    // Menu actions are events, not something to replay when data or visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSignal?.n])
  const openEditor = async (): Promise<void> => {
    setOpeningEditor(true); setError(null)
    try { await window.opencourse.openProjectEditor(target, editorId) } catch (err) { setError((err as Error).message) }
    finally { setOpeningEditor(false) }
  }
  const recreate = async (): Promise<void> => {
    try { setWorkspace(await window.opencourse.openCourseProject(target, true)); setError(null) }
    catch (err) { setError((err as Error).message) }
  }
  const completed = !!progress?.projects[moduleId]?.completedAt
  const changedSinceReview = !!workspace && !!progress?.projects[moduleId]?.reviewedFingerprint && progress.projects[moduleId]!.reviewedFingerprint !== workspace.fingerprint
  return <>
    <TitleBar user={user} navigate={navigate} route={route} back={{ label: 'All courses', onClick: () => navigate({ name: 'library' }) }} />
    <div className="body project-body">
      {course && progress && <Sidebar course={course} progress={progress} current={{ moduleId }} navigate={navigate} />}
      <div className="content project-brief scroll">
        <div className="content-inner">
          {error && <div className="sidechat-error" role="alert">{error}<button className="secondary" onClick={() => setAttempt((n) => n + 1)}>Retry</button></div>}
          {!module ? <p>{error ? 'The project could not be opened.' : 'Loading project…'}</p> : <>
            <div className="meta">Course project{module.project.estimated_minutes ? ` · about ${module.project.estimated_minutes} minutes` : ''}</div>
            <h1>{module.title}</h1>
            {!!module.project.objectives?.length && <div className="objectives"><h2>What you will practice</h2><ul>{module.project.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul></div>}
            <Html className="prose" source={module.project.definition} />
            <section className="project-requirements"><h2>Requirements</h2><ol>{module.project.requirements.map((r) => <li key={r.id}><Html className="prose" source={r.description} /></li>)}</ol></section>
            <section className="project-deliverables"><h2>Deliverables</h2>{module.project.deliverables.map((d) => <div className="panel" key={d.id}>
              <h3>{d.title}</h3><Html className="prose" source={d.description} />
              {!!d.paths?.length && <div className="project-paths">{d.paths.map((p) => <code key={p}>{p}</code>)}</div>}
              <ul>{d.acceptance_criteria.map((criterion, i) => <li key={i}><Html className="prose" source={criterion} /></li>)}</ul>
            </div>)}</section>
            <section className="project-location panel"><h2>Your workspace</h2>
              {workspace ? <>
                <code className="project-directory">{workspace.directory}</code>
                {workspace.missing ? <><p>The project folder is missing. Recreate it to start again from the course files.</p><button onClick={() => void recreate()}>Recreate workspace</button></> : <>
                  <div className="project-editor-actions">
                    {!!workspace.editors.length && <><Menu
                      className="project-editor-picker"
                      title="Project editor"
                      ariaLabel="Project editor"
                      align="left"
                      label={<span className="project-editor-label">{workspace.editors.find((e) => e.id === editorId)?.label ?? 'Choose editor'}</span>}
                      items={workspace.editors.map((editor) => ({
                        id: editor.id,
                        label: editor.label,
                        checked: editor.id === editorId,
                        onSelect: () => setEditorId(editor.id)
                      }))}
                    />
                      <button disabled={openingEditor || !editorId} onClick={() => void openEditor()}>{openingEditor ? 'Opening' : `Open in ${workspace.editors.find((e) => e.id === editorId)?.label ?? 'editor'}`}</button></>}
                    <button className="secondary" onClick={() => void window.opencourse.revealProject(target).catch((err: Error) => setError(err.message))}>Reveal in Finder</button>
                  </div>
                  {!workspace.editors.length && <p className="meta">Install Zed, Visual Studio Code, Cursor or Sublime Text to open the folder directly.</p>}
                </>}
              </> : <p>Creating your workspace…</p>}
            </section>
            {changedSinceReview && <p className="project-review-note">The requirements changed since your last review. Request fresh feedback.</p>}
            <div className="project-review-actions">
              <button className="project-request-review" disabled={!workspace || workspace.missing || !panel.activeId || panel.busy.has(panel.activeId)} onClick={() => void panel.send('', undefined, true)}>Request review</button>
              <button className={completed ? 'secondary' : 'ghost'} onClick={() => void window.opencourse.setProjectDone(target, !completed).then(setProgress).catch((err: Error) => setError(err.message))}>{completed ? '✓ Project completed · Reopen' : 'Mark project complete'}</button>
            </div>
            <p className="meta">The assistant gives feedback against your deliverables. You decide when to mark the project complete.</p>
            <div className="lesson-nav">{neighbours.prev ? <button className="secondary" onClick={() => go(neighbours.prev)}>← {neighbours.prev.title}</button> : <span />}
              <span className="spacer" />{neighbours.next && <button onClick={() => go(neighbours.next)}>{neighbours.next.title} →</button>}</div>
          </>}
        </div>
      </div>
      <ChatPanel variant="project" panel={panel} quote={null} onQuoteUsed={() => {}} onAddKey={() => navigate({ name: 'settings', from: route })} />
    </div>
  </>
}
