/**
 * Settings → Appearance: the themes this user has imported, and the app's own
 * look first among them.
 *
 * The first card is not a theme. It is the absence of one - styles.css as it
 * ships - so it cannot be removed and choosing it removes nothing either; it
 * just stops applying whatever theme was on. Every other card is a theme the
 * user imported, applied by choosing it, the same way View → Theme does.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { BRAND } from '@core/brand'
import type { ThemeSummary } from '@core/types'

/**
 * How the app's own look is drawn on its card. These are styles.css :root
 * values (--bg, --card, --accent, --fg) - read here as literals because the
 * page around the card may be wearing a theme at the time.
 */
const DEFAULT_SWATCH = ['#111110', '#232323', '#e4e4e8', '#dedee3']

function Swatch({ colors }: { colors: string[] }): JSX.Element {
  const [bg, card, accent, fg] = colors
  return (
    <span className="theme-swatch" style={{ background: bg }} aria-hidden="true">
      <span className="theme-swatch-side" style={{ background: card }} />
      <span className="theme-swatch-page">
        <span className="theme-swatch-line" style={{ background: fg }} />
        <span className="theme-swatch-line short" style={{ background: fg }} />
        <span className="theme-swatch-button" style={{ background: accent }} />
      </span>
    </span>
  )
}

function ThemeCard({
  name, detail, active, swatch, preview, notes, error, onChoose, onRemove
}: {
  name: string
  detail: string
  active: boolean
  swatch: string[]
  preview: string | null
  notes: ThemeSummary['notes']
  error?: string
  onChoose?: () => void
  onRemove?: () => void
}): JSX.Element {
  const warnings = notes.filter((note) => note.level === 'warning')
  return (
    <div className={`theme-card${active ? ' active' : ''}${error ? ' broken' : ''}`}>
      <button
        className="theme-choose"
        aria-pressed={active}
        disabled={Boolean(error) || !onChoose}
        onClick={onChoose}
      >
        {preview ? <img className="theme-preview" src={preview} alt="" /> : <Swatch colors={swatch} />}
        <span className="theme-name">{name}</span>
        <span className="theme-detail">{error ?? detail}</span>
      </button>
      {(notes.length > 0 || onRemove) && (
        <div className="theme-card-foot">
          {notes.length > 0 && (
            <details className="theme-notes">
              <summary>{warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}</summary>
              <ul>{notes.map((note, i) => <li key={i} className={note.level}>{note.message}</li>)}</ul>
            </details>
          )}
          {onRemove && <button className="ghost theme-remove" onClick={onRemove}>Remove</button>}
        </div>
      )}
    </div>
  )
}

export default function ThemeSection(): JSX.Element {
  const [themes, setThemes] = useState<ThemeSummary[] | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setThemes(await window.opencourse.listThemes())
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    }
  }, [])

  useEffect(() => {
    void load()
    // The View menu can apply a theme, and another import can land, while this is open.
    const offList = window.opencourse.onThemesChanged(() => void load())
    const offLook = window.opencourse.onThemeChanged(() => void load())
    return () => { offList(); offLook() }
  }, [load])

  const choose = async (id: string | null): Promise<void> => {
    setNote(null)
    try {
      await window.opencourse.applyTheme(id)
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    }
  }

  const importOne = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const result = await window.opencourse.importTheme()
      if (result.status === 'ok') {
        const warnings = result.theme.notes.filter((n) => n.level === 'warning').length
        const tail = warnings ? ` It has ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} - see its card.` : ''
        setNote({
          text: result.replaced
            ? `Updated “${result.theme.name}”.${tail}`
            : `Imported “${result.theme.name}”. Choose it to apply it.${tail}`,
          error: false
        })
      } else if (result.status === 'rejected') {
        setNote({ text: `That theme was not imported: ${result.message}`, error: true })
      }
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (theme: ThemeSummary): Promise<void> => {
    const ok = window.confirm(
      `Remove “${theme.name}”?\n\nIts files are deleted from this user's themes. ${theme.active ? 'The app goes back to its own look. ' : ''}You can import it again from its archive.`
    )
    if (!ok) return
    setNote(null)
    try {
      await window.opencourse.removeTheme(theme.id)
    } catch (err) {
      setNote({ text: (err as Error).message, error: true })
    }
  }

  const noneActive = !themes?.some((theme) => theme.active)

  return (
    <section className="settings-section settings-appearance">
      <h2>Appearance</h2>
      <p className="meta">
        A theme changes how {BRAND.displayName} looks - colours, surfaces and their grain, pictures behind them,
        fonts and the mark in the titlebar - and never what it does. Themes you import are yours alone; another
        user on this Mac does not see them.
      </p>
      <div className="theme-grid">
        <ThemeCard
          name={BRAND.displayName}
          detail="The app's own look"
          active={noneActive}
          swatch={DEFAULT_SWATCH}
          preview={null}
          notes={[]}
          onChoose={() => void choose(null)}
        />
        {themes?.map((theme) => (
          <ThemeCard
            key={theme.id}
            name={theme.name}
            detail={[theme.author, theme.appearance === 'light' ? 'Light' : 'Dark'].filter(Boolean).join(' · ')}
            active={theme.active}
            swatch={theme.swatch}
            preview={theme.preview}
            notes={theme.notes}
            error={theme.error}
            onChoose={() => void choose(theme.id)}
            onRemove={() => void remove(theme)}
          />
        ))}
      </div>
      <div className="actions">
        <button className="secondary settings-import-theme" disabled={busy} onClick={() => void importOne()}>
          {busy ? 'Importing…' : 'Import Theme…'}
        </button>
        <button className="ghost" onClick={() => void window.opencourse.saveThemeSpec()}>Get the theme format…</button>
      </div>
      {note && <p className={`import-note${note.error ? ' error' : ''}`}>{note.text}</p>}
      <p className="meta">If a theme ever makes this page hard to read, View → Theme in the menu bar always works.</p>
    </section>
  )
}
