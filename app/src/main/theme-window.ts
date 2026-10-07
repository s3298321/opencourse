/**
 * What a theme does to the window itself, as opposed to its contents: which
 * appearance macOS draws it in (and so which vibrancy material shows through),
 * whether there is vibrancy at all, and the colour behind everything when
 * there is not.
 *
 * With no theme this is exactly what the app always did: dark, vibrancy unless
 * the system asks for reduced transparency or more contrast, and the brand
 * background otherwise.
 */
import { BrowserWindow, nativeTheme } from 'electron'
import { BRAND } from '../core/brand'
import { activeThemeNative } from './themes'

interface WindowLook { appearance: 'dark' | 'light'; vibrancy: boolean; background: string }

const DEFAULT_LOOK: WindowLook = { appearance: 'dark', vibrancy: true, background: BRAND.background }

/** macOS's own accessibility settings switch glass off, whatever the theme says. */
function glassAllowed(): boolean {
  return process.platform === 'darwin' && !nativeTheme.prefersReducedTransparency && !nativeTheme.shouldUseHighContrastColors
}

export function currentLook(): WindowLook {
  try {
    return activeThemeNative() ?? DEFAULT_LOOK
  } catch {
    // A theme that cannot be read is the default look, never a broken window.
    return DEFAULT_LOOK
  }
}

/** The construction options that depend on the look, for `new BrowserWindow`. */
export function windowLookOptions(): { backgroundColor: string; vibrancy: 'under-window' | undefined } {
  const look = currentLook()
  const glass = look.vibrancy && glassAllowed()
  return { backgroundColor: glass ? '#00000000' : look.background, vibrancy: glass ? 'under-window' : undefined }
}

export function applyWindowLook(win: BrowserWindow): void {
  const look = currentLook()
  // Only when it changes: setting it fires nativeTheme 'updated', which calls back here.
  if (nativeTheme.themeSource !== look.appearance) nativeTheme.themeSource = look.appearance
  const glass = look.vibrancy && glassAllowed()
  win.setVibrancy(glass ? 'under-window' : null)
  win.setBackgroundColor(glass ? '#00000000' : look.background)
}

export function applyWindowLookEverywhere(): void {
  for (const win of BrowserWindow.getAllWindows()) applyWindowLook(win)
}
