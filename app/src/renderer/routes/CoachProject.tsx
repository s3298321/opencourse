import ActionButton from '../components/ActionButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CoachFileNode, CoachModel, CoachProject as Project, CoachSessionSummary, ReasoningEffort, UserProfile } from '@core/types'
import { VOICES, backendReasoningEffortsFor } from '@core/coach/models'
import { REASONING_LABELS } from '@core/sidechat/models'
import CoachFileTree from '../components/CoachFileTree'
import CoachSession from '../components/CoachSession'
import CoachSessions from '../components/CoachSessions'
import CoachFileView from '../components/CoachFileView'
import TitleBar from '../components/TitleBar'
import ScreenPlaceholder from '../components/ScreenPlaceholder'
import { useActiveTheme } from '../theme/ThemeProvider'
import { WHITE_THEME_ID } from '@core/theme/builtin-ids'
import type { Route, Screen } from '../routes'

interface Props {
  projectId: string
  user: UserProfile | null
  navigate: (r: Route) => void
  route: Screen
}

export default function CoachProject({ projectId, user, navigate, route }: Props): JSX.Element {
  const theme = useActiveTheme()
  const [project, setProject] = useState<Project | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tree, setTree] = useState<CoachFileNode[] | null>(null)
  const [viewing, setViewing] = useState<CoachFileNode | null>(null)
  const [models, setModels] = useState<CoachModel[] | null>(null)
  const [backendModels, setBackendModels] = useState<readonly CoachModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState(false)
  const [modelsRetry, setModelsRetry] = useState(0)
  const [sessions, setSessions] = useState<CoachSessionSummary[] | null>(null)

  const refresh = useCallback(() => {
    void window.opencourse.getCoachProjectRunState(projectId).then(state => setBusy(state.busy)).catch(() => setBusy(true))
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

  useEffect(() => {
    let cancelled = false
    let revision = 0
    const load = () => {
      const request = ++revision
      setModelsLoading(true)
      setModelsError(false)
      void Promise.allSettled([window.opencourse.listCoachModels(), window.opencourse.listCoachBackendModels()]).then(([voice, background]) => {
        if (cancelled || request !== revision) return
        setModels(voice.status === 'fulfilled' ? voice.value.models : [])
        setBackendModels(background.status === 'fulfilled' ? background.value.models : [])
        setModelsError(voice.status === 'rejected' || background.status === 'rejected' || !!voice.value.error || !!background.value.error)
        setModelsLoading(false)
      })
    }
    load()
    const unsubscribe = window.opencourse.onAIChanged(load)
    return () => { cancelled = true; unsubscribe() }
  }, [modelsRetry])

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

  const lastSourceRequest = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!tree || route.name !== 'coachProject' || !route.sourceRequest || lastSourceRequest.current === route.sourceRequest) return
    lastSourceRequest.current = route.sourceRequest
    const find = (nodes: CoachFileNode[]): CoachFileNode | undefined => { for (const node of nodes) { if (node.path === route.sourcePath) return node; const child = node.children && find(node.children); if (child) return child } return undefined }
    if (route.sourcePath) { const file = find(tree); if (file) setViewing(file); else setError('The referenced coach note is no longer available.') }
  }, [tree, route])

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

  if (!project) return <ScreenPlaceholder />

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
                <div className="coach-settings" aria-busy={modelsLoading}>
                  {modelsLoading ? <span className="coach-models-status meta" role="status"><span className="sidechat-connection-spinner" aria-hidden="true" />Loading Coach models…</span> : <>
                  {modelsError && <span className="coach-models-status meta" role="status">Couldn’t load all models. <button type="button" className="text-button" onClick={() => setModelsRetry(value => value + 1)}>Retry</button></span>}
                  {!!models?.length && <label>
                    <span className="meta">Voice model</span>
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
                  </label>}
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
                  {!!models?.length && <label>
                    <span className="meta">Background model</span>
                    <select value={project.backendModel} disabled={!backendModels.length}
                      onChange={(e) => void patch({ backendModel: e.target.value })}>
                      {backendModels.every(m => m.id !== project.backendModel) && (
                        <option value={project.backendModel} disabled>{project.backendModel} (saved)</option>
                      )}
                      {backendModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                    </select>
                  </label>}
                  {!!models?.length && <label>
                    <span className="meta">Background reasoning</span>
                    <select value={project.backendReasoning ?? ''} disabled={!backendReasoningEffortsFor(project.backendModel).length}
                      onChange={event => void patch({ backendReasoning: (event.target.value || null) as ReasoningEffort | null })}>
                      <option value="">Model default</option>
                      {backendReasoningEffortsFor(project.backendModel).map(level => <option key={level} value={level}>{REASONING_LABELS[level]}</option>)}
                    </select>
                  </label>}
                  </>}
                </div>
              </div>
              <div className="actions">
                <ActionButton icon="folder" className="secondary" onClick={() => void window.opencourse.revealCoachProject(projectId)}>
                  Show files in Finder
                </ActionButton>
                <ActionButton icon="trash" className="danger coach-delete" data-builtin-theme={theme.id === null || theme.id === WHITE_THEME_ID ? '' : undefined} disabled={busy || deleting}
                  title={busy ? 'Finish the session before deleting this coach' : undefined}
                  onClick={() => {
                    if (!window.confirm(`Delete “${project.name}”?\n\nThis permanently deletes its sessions, transcripts and workspace files.`)) return
                    setDeleting(true)
                    void window.opencourse.deleteCoachProject(projectId).then(() => navigate({ name: 'coach' }))
                      .catch(error => { setError(error.message); setDeleting(false) })
                  }}>Delete coach</ActionButton>
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
                    <ActionButton icon="save" onClick={() => void saveBrief()}>Save</ActionButton>
                    <ActionButton icon="close" className="secondary" onClick={() => setEditing(false)}>
                      Cancel
                    </ActionButton>
                  </div>
                  <p className="meta">
                    Sessions already recorded keep the brief they ran with, so an old transcript still shows
                    the coach it actually had.
                  </p>
                </>
              ) : (
                <>
                  <pre className="coach-brief-text">{project.instructions}</pre>
                  <ActionButton icon="edit"
                    className="secondary"
                    onClick={() => {
                      setDraft(project.instructions)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </ActionButton>
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
