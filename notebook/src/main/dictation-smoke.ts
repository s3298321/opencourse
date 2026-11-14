import { BrowserWindow, net, safeStorage, systemPreferences } from 'electron'
import { answerDictationOffer } from '../../tests/helpers/dictation-peer'
import { createWritingNotebook, updateWritingNotebook } from './writing-notebooks'
import { openWritingNotebook, closeWritingWindows, notebookWindowIdentity } from './writing-notebook-windows'
import { wantsMic } from './mic'

/** Uses Chromium's synthetic microphone and a local WebRTC peer in a disposable smoke profile. */
export async function dictationSmoke(main: BrowserWindow, connectKey: () => Promise<void>) {
  const notebook = createWritingNotebook('Dictation smoke')
  updateWritingNotebook(notebook.id, { chatOpen: true })
  await openWritingNotebook(notebook.id)
  const window = BrowserWindow.getAllWindows().find(w => notebookWindowIdentity(w.webContents)?.notebookId === notebook.id)!
  const originalFetch = net.fetch
  const originalStorage = safeStorage.isEncryptionAvailable
  const originalPermission = systemPreferences.askForMediaAccess
  try {
    // Keep the synthetic key in memory without asking Keychain to unlock.
    safeStorage.isEncryptionAvailable = () => false
    systemPreferences.askForMediaAccess = async () => true
    net.fetch = async (url, init) => {
      if (String(url).endsWith('/realtime/client_secrets')) return Response.json({ value: 'ek_test' })
      if (String(url) !== 'https://api.openai.com/v1/realtime/calls') return originalFetch(url, init)
      const offer = String(init?.body)
      if (!wantsMic(window.webContents.id) || wantsMic(main.webContents.id)) throw new Error('Incorrect capture owner.')
      const answer = await window.webContents.executeJavaScript('(' + answerDictationOffer.toString() + ')(' + JSON.stringify(offer) + ')')
      return new Response(answer)
    }
    await connectKey()
    await window.webContents.executeJavaScript(`(async () => {
      const wait = async test => {
        for (let n = 0; n < 400; n++) {
          const result = test(); if (result) return result;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Dictation timed out: ' + document.querySelector('.sidechat-composer')?.innerText);
      };
      const button = name => document.querySelector('[aria-label="' + name + '"]');
      (await wait(() => button('Start dictation'))).click();
      const field = document.querySelector('.sidechat-input');
      await wait(() => field.value === 'Check my draft' && field.readOnly);
      field.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      button('Stop dictation').click();
      await wait(() => field.value === 'Check my draft.' && !field.readOnly && button('Send') && !button('Send').disabled);
      const origin = document.querySelector('.sidechat-tab.active');
      document.querySelector('.sidechat-new').click();
      await wait(() => field.value === '' && button('Start dictation'));
      origin.click();
      await wait(() => field.value === 'Check my draft.');

    })()`)
    if (wantsMic()) throw new Error('Capture permission survived Stop.')
    return [{ name: 'Packaged notebook dictates live, stops and leaves an editable draft', ok: true, detail: 'Synthetic microphone and local WebRTC transcription peer' }]
  } finally {
    safeStorage.isEncryptionAvailable = originalStorage
    systemPreferences.askForMediaAccess = originalPermission
    net.fetch = originalFetch
    await closeWritingWindows()
  }
}
