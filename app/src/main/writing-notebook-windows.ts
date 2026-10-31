import { BrowserWindow, dialog, ipcMain, screen, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { getCourse } from './courses'
import { getDocument } from './documents'
import { getProject } from './coach'
import { currentUserId, requireUser } from './users'
import { getWritingNotebook, touchWritingNotebook, updateWritingNotebook, writingNotebookEvents } from './writing-notebooks'
import type { ReadingSource } from '../core/documents/types'
interface Entry { window: BrowserWindow; owner: string; notebookId: string; closing: boolean; ready: boolean; preparing?: boolean; page?: string; flushes: string[] }
const windows = new Map<number, Entry>()
let factory: (notebookId?: string) => BrowserWindow
let mainWindow: BrowserWindow | undefined
let mainReady = false
const mainMessages: { channel: string; payload: unknown; owner: string | null }[] = []
const pending = new Map<string, { sender: number; resolve: (ok: boolean) => void }>()
export function configureNotebookWindows(create: typeof factory): void { factory = create }
export function registerMainWindow(window: BrowserWindow): void { mainWindow = window; mainReady = false; window.webContents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) mainReady = false }); window.once('closed', () => { if (mainWindow === window) mainWindow = undefined }) }
export function focusMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = factory()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus(); return mainWindow
}
export function sendToMainWindow(channel: string, payload: unknown): void {
  const window = focusMainWindow()
  if (mainReady) window.webContents.send(channel, payload)
  else mainMessages.push({ channel, payload, owner: currentUserId() })
}
export function notebookWindowIdentity(sender: WebContents): Entry | undefined { return windows.get(sender.id) }
export function assertNotebookWindow(sender: WebContents, notebookId?: string): void {
  const entry = windows.get(sender.id)
  if (entry && (entry.owner !== requireUser() || (notebookId !== undefined && entry.notebookId !== notebookId))) throw new Error('This notebook window no longer belongs to the selected user or notebook.')
}
function flushWindow(entry: Entry): Promise<boolean> {
  if (entry.window.isDestroyed()) return Promise.resolve(true)
  return new Promise(resolve => {
    const id = randomUUID(), timeout = setTimeout(() => { pending.delete(id); resolve(false) }, 15_000)
    pending.set(id, { sender: entry.window.webContents.id, resolve: ok => { clearTimeout(timeout); pending.delete(id); resolve(ok) } })
    if (entry.ready) entry.window.webContents.send('writing:flush', id)
    else entry.flushes.push(id)
  })
}
export async function closeWritingWindows(): Promise<void> {
  const entries = [...windows.values()]
  for (const entry of entries) if (!await flushWindow(entry)) { for (const open of entries) if (!open.window.isDestroyed()) open.window.webContents.send('writing:resume'); entry.window.focus(); throw new Error('Save the notebook changes before changing users or quitting.') }
  await Promise.all(entries.map(entry => new Promise<void>((resolve, reject) => {
    if (entry.window.isDestroyed()) { resolve(); return }
    const timeout = setTimeout(() => { entry.closing = false; if (!entry.window.isDestroyed()) entry.window.webContents.send('writing:resume'); reject(new Error('A notebook window could not close.')) }, 5000)
    entry.window.once('closed', () => { clearTimeout(timeout); resolve() })
    entry.closing = true; entry.window.close()
  })))
}
export async function openWritingNotebook(id: string, pageId?: string): Promise<void> {
  const notebook = getWritingNotebook(id), owner = requireUser()
  if (pageId && !notebook.pages.some(p => p.id === pageId)) throw new Error('This notebook page no longer exists.')
  const existing = [...windows.values()].find(e => e.owner === owner && e.notebookId === id)
  if (existing) {
    if (existing.window.isMinimized()) existing.window.restore()
    existing.window.show(); existing.window.focus()
    if (pageId) { if (existing.ready) existing.window.webContents.send('writing:selectPage', pageId); else existing.page = pageId }
    return
  }
  if (pageId) updateWritingNotebook(id, { selectedPageId: pageId })
  const window = factory(id), entry: Entry = { window, owner, notebookId: id, closing: false, ready: false, flushes: [] }
  windows.set(window.webContents.id, entry)
  window.setTitle(notebook.title)
  if (notebook.bounds) {
    const bounds = { ...notebook.bounds, width: Math.max(720, notebook.bounds.width), height: Math.max(520, notebook.bounds.height) }
    if (screen.getAllDisplays().some(d => bounds.x < d.workArea.x + d.workArea.width && bounds.x + bounds.width > d.workArea.x && bounds.y < d.workArea.y + d.workArea.height && bounds.y + bounds.height > d.workArea.y)) window.setBounds(bounds)
  }
  const remember = () => { if (owner === currentUserId() && !window.isDestroyed()) { try { updateWritingNotebook(id, { bounds: window.getNormalBounds() }) } catch { /* Deleted notebook. */ } } }
  window.on('resized', remember); window.on('moved', remember)
  window.on('focus', () => { if (owner === currentUserId()) { try { touchWritingNotebook(id) } catch { /* Deleted. */ } } })
  window.webContents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) entry.ready = false })
  window.on('close', event => {
    if (entry.closing) return
    event.preventDefault()
    if (entry.preparing) return
    entry.preparing = true
    void flushWindow(entry).then(async ok => {
      if (window.isDestroyed()) return
      if (!ok) {
        const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Notebook changes could not be saved.', detail: 'Keep editing to retry, or discard the unsaved changes.', buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0 })
        if (result.response !== 1) { entry.preparing = false; window.webContents.send('writing:resume'); return }
        entry.closing = true; window.destroy(); return
      }
      entry.closing = true; window.close()
    })
  })
  window.once('closed', () => { for (const [key, value] of windows) if (value === entry) windows.delete(key) })
  touchWritingNotebook(id)
}
export function registerWritingWindowIpc(): void {
  ipcMain.on('writing:mainReady', event => {
    if (mainWindow?.webContents.id !== event.sender.id) return
    mainReady = true
    for (const message of mainMessages.splice(0)) if (message.owner === currentUserId()) event.sender.send(message.channel, message.payload)
  })
  ipcMain.on('writing:ready', event => {
    const entry = windows.get(event.sender.id)
    if (!entry || entry.owner !== currentUserId()) return
    entry.ready = true
    if (entry.page) { event.sender.send('writing:selectPage', entry.page); entry.page = undefined }
    for (const id of entry.flushes.splice(0)) if (pending.has(id)) event.sender.send('writing:flush', id)
  })
  ipcMain.on('writing:flushed', (event, id: string, ok: boolean) => { const request = pending.get(id); if (request?.sender === event.sender.id) request.resolve(ok === true) })
  ipcMain.handle('writing:settings', event => { assertNotebookWindow(event.sender); sendToMainWindow('app:navigate', 'settings') })
  ipcMain.handle('writing:source', (event, source: ReadingSource) => {
    assertNotebookWindow(event.sender)
    if (source.kind === 'writing-notebook') return openWritingNotebook(source.notebookId, source.pageId)
    if (source.kind === 'course' && !getCourse(source.courseId)) throw new Error('This course is no longer available locally.')
    if (source.kind === 'document') getDocument(source.documentId)
    if (source.kind === 'coach' && !getProject(source.projectId)) throw new Error('This coach is no longer available.')
    sendToMainWindow('writing:source', source)
  })
  writingNotebookEvents.on('changed', id => { for (const entry of windows.values()) if (entry.notebookId === id && entry.owner === currentUserId() && !entry.window.isDestroyed()) { try { entry.window.setTitle(getWritingNotebook(id).title) } catch { /* Deleted. */ } } })
  writingNotebookEvents.on('removing', id => { for (const entry of windows.values()) if (entry.notebookId === id && entry.owner === currentUserId()) { entry.closing = true; entry.window.destroy() } })
}
