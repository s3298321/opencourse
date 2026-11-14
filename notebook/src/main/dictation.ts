import { ipcMain, net, systemPreferences, type WebContents } from 'electron'
import { DEFAULT_TRANSCRIPTION, isTranscriptionConfig } from '../core/transcription'
import { negotiateTranscription, validTranscriptionOffer } from '../core/transcription-session'
import { notifyAIChanged } from './ai'
import { readKey } from './coachkey'
import { learningRequest } from './learning'
import { bindingFor } from './learning-store'
import { holdMic } from './mic'
import { readPreferences, writePreferences } from './preferences'
import { requireUser } from './users'
import { assertNotebookWindow } from './writing-notebook-windows'

function settings() {
  return { config: readPreferences().transcription ?? DEFAULT_TRANSCRIPTION, configured: !!readKey() }
}

interface Capture {
  id: string
  owner: string
  sender: WebContents
  localId?: string
  serverAccount?: string
  controller: AbortController
  connecting: boolean
  release: () => void
}
let active: Capture | undefined

export function stopDictation(notify = true): void {
  const capture = active
  if (!capture) return
  active = undefined
  capture.controller.abort()
  capture.release()
  if (notify && !capture.sender.isDestroyed()) capture.sender.send('dictation:ended', capture.id)
}

export function checkDictationAccount(): void {
  if (active?.localId && bindingFor(active.localId)?.account_id !== active.serverAccount) stopDictation()
}

export function registerDictation(): void {
  ipcMain.handle('dictation:settings', settings)
  ipcMain.handle('dictation:configure', (_event, config: unknown) => {
    if (!isTranscriptionConfig(config)) throw new Error('Invalid transcription settings.')
    writePreferences({ ...readPreferences(), transcription: { model: config.model } })
    if (active && !active.localId) stopDictation()
    notifyAIChanged()
    return settings()
  })
  ipcMain.handle('dictation:begin', async (event, id: string, localId?: string) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id))
      throw new Error('Invalid dictation request.')
    const sender = event.sender
    assertNotebookWindow(sender)
    const owner = requireUser()
    const binding = localId ? bindingFor(localId) : null
    if (localId && !binding) throw new Error('Reconnect to the original server account in Settings.')
    if (!localId && !readKey())
      throw new Error('Add an OpenAI API key in Settings to dictate.')
    const releaseMic = holdMic(sender.id)
    const ended = () => { if (active === capture) stopDictation() }
    const navigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) ended()
    }
    const capture: Capture = { id, owner, sender, localId, serverAccount: binding?.account_id,
      connecting: false, controller: new AbortController(), release: () => {
        releaseMic()
        sender.removeListener('destroyed', ended)
        sender.removeListener('render-process-gone', ended)
        sender.removeListener('did-start-navigation', navigate)
      } }
    active = capture
    sender.once('destroyed', ended)
    sender.once('render-process-gone', ended)
    sender.on('did-start-navigation', navigate)
    try {
      if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('microphone'))
        throw new Error('Allow microphone access for OpenCourse in System Settings.')
      if (active !== capture || requireUser() !== owner) throw new Error('Dictation ended.')
    } catch (error) {
      if (active === capture) stopDictation(false)
      throw error
    }
  })
  ipcMain.handle('dictation:connect', async ({ sender }, id: string, sdp: string) => {
    const capture = active
    if (!capture || capture.sender !== sender || capture.id !== id || capture.owner !== requireUser() ||
        capture.connecting || !validTranscriptionOffer(sdp)) throw new Error('Invalid dictation connection.')
    capture.connecting = true
    if (capture.localId) {
      const binding = bindingFor(capture.localId)
      if (!binding || binding.account_id !== capture.serverAccount) throw new Error('The connected account changed.')
      return learningRequest(binding.connection_id, '/me/ai/transcription/session', 'POST', { sdp, account: binding.account_id })
    }
    return negotiateTranscription(readKey(), settings().config, sdp, net.fetch, capture.controller.signal)
  })
  ipcMain.handle('dictation:end', ({ sender }, id: string) => {
    if (active?.sender === sender && active.id === id) stopDictation(false)
  })
}
