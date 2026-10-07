/**
 * Applying a theme in the window: its compiled stylesheet, its fonts, its
 * appearance and its mark.
 *
 * Everything here is mechanical. Main compiled the theme into values for the
 * stylesheet's own tokens (core/theme/compile.ts); this injects them after
 * styles.css, so they win where they say something and the stylesheet's rules
 * - which no theme can change - do the rest. No theme is the empty stylesheet:
 * the app's own look is the absence of a theme, not a theme.
 *
 * Fonts arrive as bytes and become FontFace objects, so the renderer never
 * fetches one and the CSP has no font-src to widen. They are loaded before the
 * stylesheet is swapped in, so text does not flash through a fallback.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { ActiveTheme } from '@core/types'
import { scaleAlpha } from '@core/theme/assets'
import { announceThemeApplied } from './events'

const STYLE_ID = 'opencourse-theme'

interface Applied {
  active: ActiveTheme
  faces: FontFace[]
}

let applied: Applied = { active: { id: null }, faces: [] }
/** Each apply takes a ticket; a slower, older one never overwrites a newer theme. */
let generation = 0

async function loadFaces(active: ActiveTheme): Promise<FontFace[]> {
  if (active.id === null) return []
  const loaded = await Promise.all(active.faces.map(async (face, index) => {
    try {
      const bytes = await window.opencourse.themeFontData(active.id, index)
      const font = new FontFace(face.family, new Uint8Array(bytes), { weight: face.weight, style: face.style, display: 'swap' })
      // Chromium runs every font through its sanitizer here; one it refuses
      // costs that face, and the theme's fallbacks take over.
      return await font.load()
    } catch (err) {
      console.warn(`Theme font ${face.family} could not be loaded: ${(err as Error).message}`)
      return null
    }
  }))
  return loaded.filter((face): face is FontFace => face !== null)
}

/**
 * A grain texture at another strength than its own: CSS cannot fade a single
 * background layer, so the texture is drawn on a canvas with its alpha scaled
 * and handed back as a data: URL (which img-src already allows). Done here, in
 * the sandboxed renderer that decodes the theme's pictures anyway - main never
 * parses one. A texture that cannot be drawn is used as it is.
 */
async function fadeTextures(css: string): Promise<string> {
  const wanted = new Set([...css.matchAll(/url\("([^"?]+)\?strength=([0-9.]+)"\)/g)].map((m) => m[0]))
  let out = css
  for (const reference of wanted) {
    const [, base, strength] = /url\("([^"?]+)\?strength=([0-9.]+)"\)/.exec(reference)!
    let replacement = `url("${base}")`
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = base!
      await img.decode()
      if (img.naturalWidth && img.naturalHeight) {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const g = canvas.getContext('2d')!
        g.drawImage(img, 0, 0)
        const pixels = g.getImageData(0, 0, canvas.width, canvas.height)
        scaleAlpha(pixels.data, Number(strength))
        g.putImageData(pixels, 0, 0)
        replacement = `url("${canvas.toDataURL('image/png')}")`
      }
    } catch (err) {
      console.warn(`A theme texture could not be faded: ${(err as Error).message}`)
    }
    out = out.split(reference).join(replacement)
  }
  return out
}

/** Puts a theme on the page. Resolves once its fonts are in and its values are live. */
export async function applyThemeToDocument(active: ActiveTheme): Promise<boolean> {
  const ticket = ++generation
  const [faces, css] = await Promise.all([loadFaces(active), active.id === null ? '' : fadeTextures(active.css)])
  if (ticket !== generation) {
    // A newer theme was asked for while these loaded; it wins.
    return false
  }
  for (const face of faces) document.fonts.add(face)

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (active.id === null) {
    style?.remove()
    delete document.documentElement.dataset['appearance']
  } else {
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
    }
    style.textContent = css
    // Last in <head>, so it follows styles.css (and Vite's injected sheets in dev).
    document.head.append(style)
    document.documentElement.dataset['appearance'] = active.appearance
  }

  for (const face of applied.faces) document.fonts.delete(face)
  applied = { active, faces }
  announceThemeApplied()
  return true
}

/** Before the first render, so the first frame is already themed (after a reload, say). */
export async function bootTheme(): Promise<void> {
  try {
    await applyThemeToDocument(await window.opencourse.getActiveTheme())
  } catch (err) {
    console.warn(`The theme could not be applied: ${(err as Error).message}`)
  }
}

interface ThemeState {
  active: ActiveTheme
}

const ThemeContext = createContext<ThemeState>({ active: { id: null } })

/** Follows main: a theme applied from Settings, from View → Theme, or a different user. */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<ThemeState>({ active: applied.active })
  useEffect(() => {
    let live = true
    const refresh = async (): Promise<void> => {
      try {
        const active = await window.opencourse.getActiveTheme()
        if (live && (await applyThemeToDocument(active)) && live) setState({ active })
      } catch (err) {
        console.warn(`The theme could not be applied: ${(err as Error).message}`)
      }
    }
    const off = window.opencourse.onThemeChanged(() => void refresh())
    return () => { live = false; off() }
  }, [])
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>
}

export function useActiveTheme(): ActiveTheme {
  return useContext(ThemeContext).active
}

/** The applied theme's mark, or null for the app's own. */
export function useThemeLogo(): string | null {
  const active = useActiveTheme()
  return active.id === null ? null : active.logo
}
