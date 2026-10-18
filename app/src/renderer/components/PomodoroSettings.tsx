import { useEffect, useState } from 'react'
import { validPomodoroMinutes } from '@core/pomodoro'
import ActionButton from './ActionButton'
import { POMODORO_SETTINGS_CHANGED } from './Pomodoro'

export default function PomodoroSettings() {
  const [study, setStudy] = useState('40')
  const [rest, setRest] = useState('5')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setError('')
    void window.opencourse.getPomodoroSettings().then(value => {
      if (alive) { setStudy(String(value.studyMinutes)); setRest(String(value.breakMinutes)); setLoaded(true) }
    }).catch(err => { if (alive) setError((err as Error).message) })
    return () => { alive = false }
  }, [attempt])
  const valid = validPomodoroMinutes(Number(study)) && validPomodoroMinutes(Number(rest))
  const save = async () => {
    setBusy(true); setError(''); setSaved(false)
    try {
      await window.opencourse.setPomodoroSettings({ studyMinutes: Number(study), breakMinutes: Number(rest) })
      window.dispatchEvent(new Event(POMODORO_SETTINGS_CHANGED))
      setSaved(true)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="settings-section">
    <h2>Study and break timers</h2>
    <p className="meta">Start a session with the tomato in the title bar. When study time ends, choose whether to start your break.</p>
    <form onSubmit={event => { event.preventDefault(); if (loaded && valid && !busy) void save() }}>
      <div className="pomodoro-settings-fields">
        <label>Study session <span className="meta">minutes</span><input type="number" min="1" max="180" step="1" required value={study} disabled={!loaded || busy}
          onChange={event => { setStudy(event.target.value); setSaved(false) }} /></label>
        <label>Break <span className="meta">minutes</span><input type="number" min="1" max="180" step="1" required value={rest} disabled={!loaded || busy}
          onChange={event => { setRest(event.target.value); setSaved(false) }} /></label>
      </div>
      <p className="meta">Choose 1–180 minutes. Changes apply to the next study session and its break.</p>
      <ActionButton icon="save" type="submit" disabled={!loaded || !valid || busy}>{busy ? 'Saving' : 'Save'}</ActionButton>
      {saved && <p role="status" className="import-note">Saved.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!loaded && error && <button type="button" className="secondary" onClick={() => setAttempt(n => n + 1)}>Retry</button>}
    </form>
  </section>
}
