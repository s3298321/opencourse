import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as notebooks from './writing-notebooks'
import * as chat from './writing-notebook-chat'
import { selectWritingNotebookChat } from './writing-notebook-chatdb'
import { assertNotebookWindow, notebookWindowIdentity, openWritingNotebook, registerWritingWindowIpc } from './writing-notebook-windows'
import { currentUserId, requireUser } from './users'
import { MAX_IMAGE_BYTES, validateImage } from './image-import'
import { readNotebookSketch, saveNotebookSketch } from './writing-notebook-sketch'
import { readPreferences, writePreferences } from './preferences'
import { sketchSettings, validSketchSize, validShortcut, type SketchSettings } from '../core/writing-notebooks/sketch'
import { whenSenderGone } from './senders'
import { resolveWritingTreePath } from './writing-notebook-tree'

export function registerWritingNotebookIpc(): void {
  registerWritingWindowIpc()
  // All notebook operations resolve paths from the selected user in main.
  const handlers = {
    list: notebooks.listWritingNotebooks, search: notebooks.searchWritingNotebooks, create: notebooks.createWritingNotebook,
    association: notebooks.resolveNotebookAssociation, get: notebooks.getWritingNotebook, page: notebooks.getWritingPage,
    update: notebooks.updateWritingNotebook, save: notebooks.saveWritingPage, addPage: notebooks.addWritingPage,
    renamePage: notebooks.renameWritingPage, reorder: notebooks.reorderWritingPages, deletePage: notebooks.deleteWritingPage,
    createFolder: notebooks.createWritingFolder, deleteFolder: notebooks.deleteWritingFolder, deleteFile: notebooks.deleteWritingFile,
    move: notebooks.moveWritingEntry,
    // Files dropped from outside are copied into the tree folder; the preload sends absolute paths.
    importFiles: notebooks.importWritingFiles,
    // Reveal resolves the caller's relative path inside the notebook tree in main; '' is the tree root.
    reveal: (id: string, path: string) => shell.showItemInFolder(resolveWritingTreePath(id, path)),
    delete: notebooks.deleteWritingNotebook, open: openWritingNotebook
  }
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`writing:${name}`, (event, ...args: unknown[]) => {
    requireUser(); assertNotebookWindow(event.sender, ['list', 'search', 'create', 'association', 'open'].includes(name) ? undefined : args[0] as string)
    return (handler as (...args: unknown[]) => unknown)(...args)
  })
  for (const [name, handler] of Object.entries({ readSketch: readNotebookSketch, saveSketch: saveNotebookSketch })) {
    ipcMain.handle(`writing:${name}`, (event, id: string, ...args: unknown[]) => {
      if (!notebookWindowIdentity(event.sender)) throw new Error('Open the notebook to access its sketches.')
      assertNotebookWindow(event.sender, id)
      return (handler as (id: string, ...args: unknown[]) => unknown)(id, ...args)
    })
  }
  // Let the recorder receive reserved combinations so Settings can explain the conflict.
  ipcMain.on('writing:recordSketchShortcut', (event, recording: boolean) => {
    if (typeof recording === 'boolean') event.sender.setIgnoreMenuShortcuts(recording)
  })
  ipcMain.handle('writing:sketchSettings', event => {
    requireUser(); assertNotebookWindow(event.sender)
    return sketchSettings(readPreferences().notebookSketch)
  })
  ipcMain.handle('writing:setSketchSettings', (event, value: SketchSettings) => {
    requireUser(); assertNotebookWindow(event.sender)
    if (!validSketchSize(value?.width) || !validSketchSize(value?.height) || !validShortcut(value?.shortcut)) throw new Error('Invalid notebook sketch settings.')
    const normalized = sketchSettings(value)
    writePreferences({ ...readPreferences(), notebookSketch: normalized })
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('writing:sketchSettingsChanged', normalized)
  })
  ipcMain.handle('writing:image', async (event, id: string, bytes: Uint8Array) => {
    assertNotebookWindow(event.sender, id); notebooks.getWritingNotebook(id)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Use an image of at most 20 MiB.')
    const owner = requireUser(), controller = new AbortController(), off = whenSenderGone(event.sender, () => controller.abort())
    try {
      const extension = await validateImage(Buffer.from(bytes), controller.signal)
      if (owner !== currentUserId()) throw new Error('The selected user changed.')
      notebooks.getWritingNotebook(id)
      const directory = join(notebooks.writingNotebookDirectory(id), 'assets'); mkdirSync(directory, { recursive: true })
      const name = `${randomUUID()}.${extension}`; writeFileSync(join(directory, name), bytes, { flag: 'wx' }); return `assets/${name}`
    } finally { off() }
  })
  // The native picker runs in main; the renderer only sees the chosen path, and
  // create re-validates it. A user switch during the dialog invalidates the pick.
  ipcMain.handle('writing:pickFolder', async event => {
    const owner = requireUser(); assertNotebookWindow(event.sender)
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: 'Choose a notebook folder', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (requireUser() !== owner) throw new Error('The selected user changed.')
    if (picked.canceled || !picked.filePaths[0]) return null
    return picked.filePaths[0]
  })
  const chatHandlers = {
    list: chat.listWritingNotebookChats, get: chat.getWritingNotebookChat, create: chat.createWritingNotebookChat, remove: chat.deleteWritingNotebookChat,
    cancel: chat.cancelWritingNotebookChat, model: chat.setWritingNotebookChatModel, reasoning: chat.setWritingNotebookChatReasoning,
    provider: chat.setWritingNotebookChatProvider, icons: chat.writingSourceIcons
  }
  for (const [name, handler] of Object.entries(chatHandlers)) ipcMain.handle(`writingChat:${name}`, (event, ...args: unknown[]) => {
    requireUser()
    const notebookId = name === 'list' || name === 'create' ? args[0] as string : selectWritingNotebookChat(args[0] as string)?.notebookId
    if (!notebookId) throw new Error('This notebook chat no longer exists.')
    assertNotebookWindow(event.sender, notebookId)
    return (handler as (...args: unknown[]) => unknown)(...args)
  })
  ipcMain.handle('writingChat:send', (event, id, text, quote, page) => {
    const found = selectWritingNotebookChat(id)
    if (!found) throw new Error('This notebook chat no longer exists.')
    assertNotebookWindow(event.sender, found.notebookId)
    return chat.sendWritingNotebookMessage(event.sender, id, text, quote, page)
  })
  notebooks.writingNotebookEvents.on('changed', id => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('writing:changed', id) })
}
