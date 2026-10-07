import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CoachFileNode, CoachModel, CoachProject as Project, CoachSessionSummary, UserProfile } from '@core/types'
import { VOICES } from '@core/coach/models'
import CoachFileTree from '../components/CoachFileTree'
import CoachSession from '../components/CoachSession'
import CoachSessions from '../components/CoachSessions'
import CoachFileView from '../components/CoachFileView'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'

interface Props {
  projectId: string
  user: UserProfile | null
  navigate: (r: Route) => void
  route: Screen
}

export default function CoachProject({ projectId, user, navigate, route }: Props): JSX.Element {
  const [project, setProject] = useState<Project | null>(null)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tree, setTree] = useState<CoachFileNode[] | null>(null)
  const [viewing, setViewing] = useState<CoachFileNode | null>(null)
  const [models, setModels] = useState<CoachModel[] | null>(null)
  const [sessions, setSessions] = useState<CoachSessionSummary[] | null>(null)

  const refresh = useCallback(() => {
    void window.opencourse.getCoachProject(projectId).then((found) => {
      if (found) setProject(found)
      else setMissing(true)
    })
  }, [projectId])

  const refreshFiles = useCallback(() => {
    void window.opencourse
      .listCoachFiles(projectId)
      .then(setTree)
      .catch(() => setTree([]))
  }, [projectId])

  const refreshSessions = useCallback(() => {
    void window.opencourse
      .listCoachSessions(projectId)
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [projectId])

  useEffect(refresh, [refresh])
  useEffect(refreshFiles, [refreshFiles])
  useEffect(refreshSessions, [refreshSessions])

  // Falls back to a curated list when the key is missing or OpenAI is not
  // reachable, so the picker is never empty.
  useEffect(() => {
    let cancelled = false
    void window.opencourse.listCoachModels().then(({ models: found }) => {
      if (!cancelled) setModels(found)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Another window can end a session or rename the project underneath this one.
  useEffect(
    () =>
      window.opencourse.onCoachChanged(() => {
        refresh()
        refreshSessions()
      }),
    [refresh, refreshSessions]
  )

  // The coach writes files while you are talking to it, so the tree has to
  // follow along - watching a note appear mid-sentence is the whole point.
  useEffect(
    () => window.opencourse.onCoachFilesChanged((changed) => { if (changed === projectId) refreshFiles() }),
    [projectId, refreshFiles]
  )

  if (missing) {
    return (
      <>
        <TitleBar
          user={user}
          navigate={navigate}
          route={route}
          back={{ label: 'All coaches', onClick: () => navigate({ name: 'coach' }) }}
        />
        <div className="body">
          <div className="content scroll">
            <div className="empty">That coach is gone.</div>
          </div>
        </div>
      </>
    )
  }

  if (!project) return <div className="empty">Loading…</div>

  const patch = async (change: Parameters<typeof window.opencourse.updateCoachProject>[1]): Promise<void> => {
    try {
      setProject(await window.opencourse.updateCoachProject(projectId, change))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const saveBrief = async (): Promise<void> => {
    try {
      setProject(await window.opencourse.updateCoachProject(projectId, { instructions: draft }))
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <TitleBar
        user={user}
        navigate={navigate}
        route={route}
        back={{ label: 'All coaches', onClick: () => navigate({ name: 'coach' }) }}
      />
      <div className="body">
        <div className="content scroll">
          <div className="coach-project">
            <div className="library-head">
              <div>
                <h1>{project.name}</h1>
                <div className="coach-settings">
                  <label>
                    <span className="meta">Model</span>
                    <select
                      value={project.model}
                      onChange={(e) => void patch({ model: e.target.value })}
                    >
                      {/* The stored model may predate the list; never drop it silently. */}
                      {(models ?? []).every((m) => m.id !== project.model) && (
                        <option value={project.model}>{project.model}</option>
                      )}
                      {models?.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="meta">Voice</span>
                    <select value={project.voice} onChange={(e) => void patch({ voice: e.target.value })}>
                      {VOICES.map((voice) => (
                        <option key={voice} value={voice}>
                          {voice}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="coach-toggle">
                    <input
                      type="checkbox"
                      checked={project.allowDelete}
                      onChange={(e) => void patch({ allowDelete: e.target.checked })}
                    />
                    <span className="meta">Let the coach delete its own files</span>
                  </label>
                </div>
              </div>
              <div className="actions">
                <button className="secondary" onClick={() => void window.opencourse.revealCoachProject(projectId)}>
                  Show files in Finder
                </button>
              </div>
            </div>

            {error && <p className="import-note error">{error}</p>}

            <CoachSession project={project} onSessionChanged={refreshSessions} />

            <CoachSessions
              sessions={sessions}
              onOpen={(session) => navigate({ name: 'coachSession', projectId, sessionId: session.id })}
              onDelete={(session) => {
                if (!window.confirm('Delete this transcript?\n\nThe files the coach wrote are kept.')) return
                void window.opencourse.deleteCoachSession(session.id).then(refreshSessions)
              }}
            />

            <CoachFileTree projectId={projectId} tree={tree} onChanged={refreshFiles} onOpen={setViewing} />

            <details className="panel coach-brief">
              <summary>
                <svg className="brief-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m9 5 7 7-7 7" />
                </svg>
                The coach's brief
              </summary>
              {editing ? (
                <>
                  <textarea value={draft} rows={16} onChange={(e) => setDraft(e.target.value)} />
                  <div className="actions">
                    <button onClick={() => void saveBrief()}>Save</button>
                    <button className="secondary" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                  <p className="meta">
                    Sessions already recorded keep the brief they ran with, so an old transcript still shows
                    the coach it actually had.
                  </p>
                </>
              ) : (
                <>
                  <pre className="coach-brief-text">{project.instructions}</pre>
                  <button
                    className="ghost"
                    onClick={() => {
                      setDraft(project.instructions)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </button>
                </>
              )}
            </details>

          </div>
        </div>
      </div>

      {viewing && (
        <CoachFileView projectId={projectId} node={viewing} onClose={() => setViewing(null)} />
      )}
    </>
  )
}
