import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CoachProjectSummary, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'
import type { Route, Screen } from '../routes'

interface Props {
  user: UserProfile | null
  navigate: (r: Route) => void
  newSignal: number
  route: Screen
}

function whenLast(iso?: string): string {
  if (!iso) return 'no sessions yet'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'last session today'
  if (days === 1) return 'last session yesterday'
  if (days < 30) return `last session ${days} days ago`
  return `last session ${new Date(iso).toLocaleDateString()}`
}

export default function Coach({ user, navigate, newSignal, route }: Props): JSX.Element {
  const [projects, setProjects] = useState<CoachProjectSummary[] | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key, setKeyState] = useState<{ has: boolean; hint: string | null } | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(() => {
    void window.opencourse
      .listCoachProjects()
      .then(setProjects)
      .catch((err: Error) => {
        setProjects([])
        setError(err.message)
      })
  }, [])

  const refreshKey = useCallback(() => {
    void window.opencourse.hasOpenAIKey().then(setKeyState)
  }, [])

  useEffect(refresh, [refresh])
  useEffect(refreshKey, [refreshKey])
  useEffect(() => window.opencourse.onCoachChanged(refresh), [refresh])

  // Coach ▸ New Coach… lands here, the way Import Course… lands in the library.
  useEffect(() => {
    if (newSignal > 0) setNaming(true)
  }, [newSignal])

  useEffect(() => {
    if (naming) nameInput.current?.focus()
  }, [naming])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const project = await window.opencourse.createCoachProject({ name })
      setName('')
      setNaming(false)
      navigate({ name: 'coachProject', projectId: project.id })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (project: CoachProjectSummary): Promise<void> => {
    const ok = window.confirm(
      `Delete “${project.name}”?\n\n` +
        `This deletes its ${project.sessions} session${project.sessions === 1 ? '' : 's'} and their ` +
        `transcripts, and the ${project.files} file${project.files === 1 ? '' : 's'} the coach wrote. ` +
        `It cannot be undone.`
    )
    if (!ok) return
    try {
      await window.opencourse.deleteCoachProject(project.id)
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const empty = projects?.length === 0

  return (
    <>
      <TitleBar user={user} navigate={navigate} route={route} />
      <div className="body">
        <div className="content content-glass scroll">
          <div className="coach">
            <div className="library-head">
              <div>
                <h1>Your coaches</h1>
                <p className="lede">Learn something by talking about it.</p>
              </div>
              <div className="actions">
                <button disabled={busy || naming} onClick={() => setNaming(true)}>
                  New coach…
                </button>
              </div>
            </div>

            {error && <p className="import-note error">{error}</p>}

            {key?.has === false && (
              <div className="key-banner">
                <div>
                  <strong>No OpenAI key yet.</strong> You can set a coach up without one, but starting a
                  session needs it.
                </div>
                <button className="ghost" onClick={() => navigate({ name: 'settings', from: route })}>
                  Open settings
                </button>
              </div>
            )}

            {projects === null && <p className="meta">Loading…</p>}

            {naming && (
              <div className="coach-card new">
                <div>
                  <h3>What will this coach help you with?</h3>
                  <input
                    ref={nameInput}
                    type="text"
                    value={name}
                    placeholder="French vocabulary"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && name.trim()) void create()
                      if (e.key === 'Escape') setNaming(false)
                    }}
                  />
                  <p className="meta">You can change the name, the model and the coach's brief afterwards.</p>
                </div>
                <div className="actions">
                  <button disabled={busy || !name.trim()} onClick={() => void create()}>
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setNaming(false)
                      setName('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {empty && !naming && (
              <div className="empty-library">
                <h3>No coaches yet</h3>
                <p>
                  A coach is a voice conversation with a purpose. Tell it what you want to get better at, talk
                  to it, and it keeps notes between sessions so the next one picks up where this one stopped.
                </p>
                <p className="meta">Add your OpenAI API key in Settings before starting a session.</p>
              </div>
            )}

            {projects?.map((project) => (
              <div
                key={project.id}
                className="coach-card"
                onClick={() => navigate({ name: 'coachProject', projectId: project.id })}
              >
                <div>
                  <h3>{project.name}</h3>
                  <div className="meta">
                    {project.sessions} session{project.sessions === 1 ? '' : 's'} · {project.files} file
                    {project.files === 1 ? '' : 's'} · {whenLast(project.lastSessionAt)}
                  </div>
                  <span className="tag">{project.model}</span>
                </div>
                <button
                  className="ghost card-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove(project)
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
