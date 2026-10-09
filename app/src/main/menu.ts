import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { BRAND } from '../core/brand'
import type { NavAction } from '../core/types'
import { saveSpecBundle, saveThemeSpecBundle } from './spec'
import { listThemes } from './themes'
import { pickTheme } from './theme-sync'
import { currentUserId } from './users'

function send(action: NavAction): void {
  // The app has one window; an accelerator can still fire while it is not key.
  ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send('app:navigate', action)
}

/**
 * Course ▸ Save Course is enabled only while a course editor is open. A
 * disabled item does not claim ⌘S, so the exercise workbench keeps its own.
 * Kept here rather than in the template because the menu is rebuilt whenever
 * the theme list changes.
 */
let editorActive = false
export function setEditorActive(active: boolean): void {
  editorActive = active
  const item = Menu.getApplicationMenu()?.getMenuItemById('save-course')
  if (item) item.enabled = active
}

/**
 * View → Theme. The native menu is the one surface no theme can restyle, so
 * this is the way back from a theme that made the page hard to read. Rebuilt
 * whenever the list, the choice or the user changes (theme-sync.ts).
 */
function themeMenu(): MenuItemConstructorOptions {
  let themes: ReturnType<typeof listThemes> = []
  try {
    if (currentUserId()) themes = listThemes()
  } catch { /* an unreadable themes folder still leaves the default */ }
  const anyActive = themes.some((theme) => theme.active)
  return {
    label: 'Theme',
    enabled: Boolean(currentUserId()),
    submenu: [
      { label: `${BRAND.displayName} Dark (default)`, type: 'radio', checked: !anyActive, click: () => pickTheme(null) },
      ...(themes.length ? [{ type: 'separator' } as const] : []),
      ...themes.map((theme): MenuItemConstructorOptions => ({
        label: theme.name,
        type: 'radio',
        checked: theme.active,
        enabled: !theme.error,
        click: () => pickTheme(theme.id)
      })),
      { type: 'separator' },
      { label: 'Manage Themes', click: () => send('settings') }
    ]
  }
}

export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Course',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: () => send('library') },
        { label: 'Create Course', accelerator: 'CmdOrCtrl+N', click: () => send('courseNew') },
        { label: 'Import Course', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { label: 'Switch User', accelerator: 'CmdOrCtrl+Shift+U', click: () => send('users') },
        { type: 'separator' },
        { id: 'save-course', label: 'Save Course', accelerator: 'CmdOrCtrl+S', enabled: editorActive, click: () => send('saveCourse') },
        { type: 'separator' },
        { label: 'Find in Course', accelerator: 'CmdOrCtrl+F', click: () => send('search') },
        { type: 'separator' },
        { label: 'Previous Lesson', accelerator: 'CmdOrCtrl+[', click: () => send('prev') },
        { label: 'Next Lesson', accelerator: 'CmdOrCtrl+]', click: () => send('next') }
      ]
    },
    {
      label: 'Coach',
      submenu: [
        { label: 'Coaches', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('coach') },
        { label: 'New Coach', click: () => send('coachNew') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        themeMenu()
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    },
    {
      role: 'help',
      submenu: [
        {
          // The app ships no courses and is tied to no one subject, so the only
          // help worth a menu item is how to write one.
          label: 'Get the course format',
          click: () => void saveSpecBundle()
        },
        {
          label: 'Get the theme format',
          click: () => void saveThemeSpecBundle()
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
