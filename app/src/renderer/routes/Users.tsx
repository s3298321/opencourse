import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Session, UserProfile } from '@core/types'
import TitleBar from '../components/TitleBar'

function initials(name: string): string {
  const words = name.split(' ').filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

function lastSeen(user: UserProfile): string {
  if (!user.lastUsedAt) return 'never opened'
  const when = new Date(user.lastUsedAt)
  if (Number.isNaN(when.getTime())) return 'never opened'
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000)
  if (days <= 0) return 'last opened today'
  if (days === 1) return 'last opened yesterday'
  if (days < 30) return `last opened ${days} days ago`
  return `last opened ${when.toLocaleDateString()}`
}

/**
 * The picker. No passwords - a user is a name and a folder, and everything
 * they own lives under it, which is what makes deleting one honest.
 */
export default function Users({
  session,
  onSessionChanged
}: {
  session: Session | null
  onSessionChanged: (session: Session, user: UserProfile | null) => void
}): JSX.Element {
  const [users, setUsers] = useState<UserProfile[] | null>(session?.users ?? null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.opencourse.listUsers().then(setUsers)
  }, [])

  useEffect(refresh, [refresh])

  // A first run has nobody, so go straight to the name field.
  useEffect(() => {
    if (users?.length === 0) setNaming(true)
  }, [users])

  const pick = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const user = await window.opencourse.switchUser(id)
      onSessionChanged(await window.opencourse.getSession(), user)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const user = await window.opencourse.createUser(name)
      onSessionChanged(await window.opencourse.getSession(), user)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const remove = async (user: UserProfile): Promise<void> => {
    const ok = window.confirm(
      `Delete ${user.name}?\n\nThis removes their courses, their progress, and every exercise file and ` +
        `virtualenv they have on this Mac. It cannot be undone.`
    )
    if (!ok) return
    await window.opencourse.deleteUser(user.id)
    setError(null)
    refresh()
  }

  return (
    <>
      <TitleBar />
      <div className="body">
        <div className="content content-glass scroll">
          <div className="users">
            <h1>Who's learning?</h1>
            <p className="lede">
              Courses, progress and exercise files are kept separately for each person on this Mac.
            </p>

            {error && <p className="import-note error">{error}</p>}
            {users === null && <p className="meta">Loading…</p>}

            <div className="user-grid">
              {users?.map((user) => (
                <div key={user.id} className="user-card">
                  <button className="user-pick" disabled={busy} onClick={() => void pick(user.id)}>
                    <span className="avatar" style={{ background: user.color }}>
                      {initials(user.name)}
                    </span>
                    <span className="user-name">{user.name}</span>
                    <span className="meta">{lastSeen(user)}</span>
                  </button>
                  <button className="ghost user-delete" disabled={busy} onClick={() => void remove(user)}>
                    Delete
                  </button>
                </div>
              ))}

              {users !== null &&
                (naming ? (
                  <div className="user-card new">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Name"
                      value={name}
                      maxLength={40}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void create()
                        if (e.key === 'Escape') setNaming(false)
                      }}
                    />
                    <div className="actions">
                      <button disabled={busy || !name.trim()} onClick={() => void create()}>
                        Create
                      </button>
                      {users.length > 0 && (
                        <button className="secondary" disabled={busy} onClick={() => setNaming(false)}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <button className="user-card add" disabled={busy} onClick={() => setNaming(true)}>
                    <span className="avatar blank" aria-hidden="true">+</span>
                    <span className="user-name">Add new user</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
