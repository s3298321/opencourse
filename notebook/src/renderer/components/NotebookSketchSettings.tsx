import { useEffect, useState } from 'react'
import ActionButton, { Icon } from './ActionButton'
import { MAX_SKETCH_SIZE, MIN_SKETCH_SIZE, validShortcut, type SketchSettings } from '@core/writing-notebooks/sketch'

export default function NotebookSketchSettings() {
  const [settings, setSettings] = useState<SketchSettings | null>(null)
  const [recording, setRecording] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  useEffect(() => {
    void window.opencourse.writing?.sketchSettings?.().then(setSettings).catch(e => setMessage(e.message))
  }, [])
  useEffect(() => {
    if (!recording) return
    window.opencourse.writing.recordSketchShortcut(true)
    const end = () => setRecording(false)
    window.addEventListener('blur', end)
    window.addEventListener('pagehide', end)
    return () => {
      window.opencourse.writing.recordSketchShortcut(false)
      window.removeEventListener('blur', end)
      window.removeEventListener('pagehide', end)
    }
  }, [recording])
  return <form className="settings-section sketch-settings" onSubmit={async event => {
    event.preventDefault()
    if (!settings || busy) return
    setBusy(true)
    try { await window.opencourse.writing.setSketchSettings(settings); setMessage('Saved.') }
    catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }}>
    <h2>Notebook sketches</h2>
    {settings && <>
      <div className="sketch-settings-fields">
        <div className="sketch-setting">
          <label htmlFor="sketch-shortcut">Insert sketch shortcut</label>
          <button id="sketch-shortcut" type="button" className="secondary sketch-shortcut" aria-label="Record insert sketch shortcut"
            aria-pressed={recording} onClick={() => { setRecording(true); setMessage('') }}
            onBlur={() => setRecording(false)} onKeyDown={e => {
              if (!recording || e.key === 'Tab') return
              e.preventDefault(); e.stopPropagation()
              if (e.key === 'Escape') { setRecording(false); return }
              if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return
              const key = e.code.replace(/^(Key|Digit)/, '').toLowerCase()
              const combo = [e.metaKey ? 'Mod' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('-')
              if (e.ctrlKey || !validShortcut(combo)) { setMessage('Choose an available ⌘ shortcut with a letter or number.'); return }
              setSettings({ ...settings, shortcut: combo }); setRecording(false); setMessage('')
            }}>
            <span>{recording ? 'Press shortcut…' : settings.shortcut.replace('Mod-', '⌘').replace('Alt-', '⌥').replace('Shift-', '⇧').toUpperCase()}</span>
            <Icon name="edit" />
          </button>
        </div>
        {(['width', 'height'] as const).map(key => <label className="sketch-setting" key={key}>
          Default {key}
          <span className="sketch-dimension">
            <input type="number" required min={MIN_SKETCH_SIZE} max={MAX_SKETCH_SIZE} value={settings[key] || ''}
              onChange={event => { setSettings({ ...settings, [key]: Number(event.target.value) }); setMessage('') }} />
            <span className="meta">px</span>
          </span>
        </label>)}
      </div>
      <div className="actions sketch-settings-actions">
        <ActionButton icon="save" type="submit" disabled={busy || recording}>{busy ? 'Saving…' : 'Save'}</ActionButton>
        {message && <span role="status" className="meta">{message}</span>}
      </div>
    </>}
    {!settings && message && <p role="status" className="error">{message}</p>}
  </form>
}
