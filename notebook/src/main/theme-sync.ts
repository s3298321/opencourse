/**
 * Telling everything that the look changed. One place, because three things
 * follow a theme - the window (vibrancy, appearance), every renderer's
 * stylesheet, and the View → Theme menu - and they must follow it together,
 * whether the change came from Settings, from that menu, or from a new user.
 */
import { BrowserWindow } from 'electron'
import { applyTheme } from './themes'
import { applyWindowLookEverywhere } from './theme-window'
import { buildMenu } from './menu'

function broadcast(channel: string): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send(channel)
}

/** The installed list changed (an import or a removal), but not the look. */
export function themesListChanged(): void {
  buildMenu()
  broadcast('themes:changed')
}

/**
 * The look changed: a theme was applied, removed while applied, replaced in
 * place, or the user changed. The window follows first, then every renderer
 * re-reads the stylesheet, then the menu's ticks.
 */
export function themeChanged(): void {
  applyWindowLookEverywhere()
  broadcast('theme:changed')
  themesListChanged()
}

/** From the native menu - which works however unreadable a theme has made the page. */
export function pickTheme(id: string | null): void {
  applyTheme(id)
  themeChanged()
}
