import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from './db'
import { log } from './log'
import { closeLogSinks, installLogSinks } from './logging'
import { BRAND } from '../core/brand'
import { cspFor } from './csp'
import { registerIpc } from './ipc'
import { endWindowReviews } from './review'
import { buildMenu } from './menu'
import { wantsMic } from './mic'
import { registerProtocolHandler, registerSchemePrivileges } from './protocol'
import { applyWindowLook, windowLookOptions } from './theme-window'
import { isolatedRun } from './run-mode'
import { quitVetoed, runPendingInstall, startUpdates } from './updates'

// Must happen before the app is ready.
app.setName(BRAND.displayName)
nativeTheme.themeSource = 'dark'
app.setPath('userData', join(app.getPath('appData'), BRAND.name))
registerSchemePrivileges()

// A smoke run must not inherit - or disturb - the real data directory. Every
// path the app owns hangs off userData (see main/paths.ts), so this one line
// isolates users, courses, progress, exercise files and virtualenvs together.
if (isolatedRun) {
  // Recorded so the run can delete it on the way out: these profiles hold a
  // virtualenv apiece and quietly filled a disk before anyone noticed.
  const profile = mkdtempSync(join(tmpdir(), 'opencourse-run-'))
  process.env['OPENCOURSE_RUN_PROFILE'] = profile
  app.setPath('userData', profile)
}
const primary = isolatedRun || app.requestSingleInstanceLock()
if (!primary) app.quit()

// After userData is settled, before anything has a reason to log.
installLogSinks()
const appLog = log.child('app')
if (primary) {
  appLog.info('OpenCourse started', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
    packaged: app.isPackaged
  })
}
// A monitor observes without changing what Electron does with the exception.
process.on('uncaughtExceptionMonitor', (error, origin) => appLog.error('Uncaught exception in main', { origin, error }))
process.on('unhandledRejection', (reason) => appLog.error('Unhandled promise rejection in main', { reason }))
app.on('render-process-gone', (_e, _wc, details) => appLog.error('A renderer went away', { reason: details.reason, exitCode: details.exitCode }))
app.on('child-process-gone', (_e, details) => {
  // A utility process exiting cleanly is not news.
  if (details.reason !== 'clean-exit') appLog.warn('A helper process went away', { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? null })
})
// An update the learner asked for is swapped in by a helper once the app has
// gone. will-quit is the first moment the quit can no longer be refused (a
// course with unsaved edits can refuse it), and this is registered before the
// log closes so what it says is kept.
app.on('will-quit', runPendingInstall)
// will-quit, not before-quit: other modules stop their work on before-quit, and
// what that stopping logs should make it to disk too.
app.on('will-quit', closeLogSinks)
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window?.isMinimized()) window.restore()
  window?.focus()
})

/**
 * Deny by default. Electron hands geolocation, notifications, MIDI and display
 * capture to any renderer that asks for them; this app needs none of that. It
 * needs fullscreen, for the visualization button, and audio capture - and audio
 * only while a coaching session is actually live (see main/mic.ts).
 */
function allowPermission(permission: string, details?: unknown): boolean {
  if (permission === 'fullscreen') return true
  if (permission !== 'media') return false

  // The request handler reports `mediaTypes: string[]`; the check handler
  // reports a single `mediaType`. Accept either, and refuse an empty one -
  // "media, unspecified" must never be read as "audio".
  const d = (details ?? {}) as { mediaTypes?: unknown; mediaType?: unknown }
  const types = Array.isArray(d.mediaTypes)
    ? (d.mediaTypes as unknown[])
    : typeof d.mediaType === 'string'
      ? [d.mediaType]
      : []
  return types.length > 0 && types.every((t) => t === 'audio') && wantsMic()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    title: BRAND.displayName,
    // Vibrancy and the colour behind it follow the applied theme (and macOS's
    // reduced-transparency and contrast settings) - main/theme-window.ts.
    ...windowLookOptions(),
    visualEffectState: 'followWindow',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Automated layout/selection checks must receive animation frames even
      // while the user switches to another app. Normal launches stay throttled.
      backgroundThrottling: !Boolean(process.env['OPENCOURSE_SMOKE'] || process.env['OPENCOURSE_SHOTS'] || process.env['OPENCOURSE_FLASHCARD_SMOKE'])
    }
  })
  const updateGlass = (): void => applyWindowLook(win)
  nativeTheme.on('updated', updateGlass)
  const reviewWindowId = win.webContents.id
  win.webContents.on('destroyed', () => endWindowReviews(reviewWindowId))
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) endWindowReviews(reviewWindowId) })
  win.once('closed', () => nativeTheme.off('updated', updateGlass))
  // The course editor refuses to unload while it holds unsaved changes. Closing
  // or quitting asks once; Discard lets the window go, and the edit session
  // goes with it (ipc.ts releases what a destroyed window held). Automated runs
  // have nobody to answer, so they always discard.
  win.webContents.on('will-prevent-unload', (event) => {
    if (isolatedRun) { event.preventDefault(); return }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      message: 'Discard unsaved changes?',
      detail: 'Your edits to this course have not been saved. Discarding them leaves the course as it was last saved.'
    })
    if (choice === 0) event.preventDefault()
    // Kept editing: if this quit was an update's restart, it is not one any
    // more - the next ordinary quit installs it, without opening the app again.
    else quitVetoed()
  })

  win.once('ready-to-show', () => {
    // Fill the window's display on launch. Automated runs keep their fixed
    // dimensions for screenshots and responsive layout checks.
    if (!process.env['OPENCOURSE_SMOKE'] && !process.env['OPENCOURSE_SHOTS'] && !process.env['OPENCOURSE_FLASHCARD_SMOKE']) win.maximize()
    win.show()
    if (process.env['OPENCOURSE_SMOKE']) void import('./smoke').then(({ runSmoke }) => runSmoke(win))
    else if (process.env['OPENCOURSE_SHOTS']) void import('./shots').then(({ runShots }) => runShots(win))
    else if (process.env['OPENCOURSE_FLASHCARD_SMOKE']) void import('./flashcard-smoke').then(({ runFlashcardSmoke }) => runFlashcardSmoke(win))
  })

  // Nothing in this app should ever navigate away or open a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Renderer problems reach the log in every build, not only the terminal in
  // dev - a packaged app's console is somewhere nobody is looking. Warnings and
  // errors only: the rest is React and Vite chatter.
  const rendererLog = log.child('renderer')
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return
    const source = details.sourceId ? { source: `${details.sourceId}:${details.lineNumber}` } : {}
    if (details.level === 'error') rendererLog.error(details.message, source)
    else rendererLog.warn(details.message, source)
  })
  win.webContents.on('did-finish-load', () => rendererLog.debug('did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) rendererLog.error('The window failed to load', { url, description, code })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

app.whenReady().then(async () => {
  if (!primary) return
  const icon = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources/icon.png')
  app.setAboutPanelOptions({ applicationName: BRAND.displayName, applicationVersion: app.getVersion(), iconPath: icon })
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
  registerProtocolHandler()
  registerIpc()
  buildMenu()

  const csp = cspFor(process.env['ELECTRON_RENDERER_URL'])
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermission(permission, details))
  })
  // The synchronous path, which is what getUserMedia consults in a sandboxed
  // renderer. Without it Chromium can refuse without ever asking, which reads
  // like a bug in the app rather than the policy decision it is.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    allowPermission(permission, details)
  )

  // The one database handle the app holds, released the way pty.ts releases shells.
  app.on('before-quit', closeDb)

  createWindow()
  startUpdates()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  dialog.showErrorBox('OpenCourse could not start', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
