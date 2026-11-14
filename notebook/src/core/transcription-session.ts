import type { TranscriptionConfig } from './transcription'

export function validTranscriptionOffer(sdp: unknown): sdp is string {
  return typeof sdp === 'string' && sdp.length <= 65536 && sdp.startsWith('v=0') &&
    /^m=audio /m.test(sdp) && /^m=application /m.test(sdp) && !/^m=video /m.test(sdp)
}

/** Runs only in Electron main or the account server. Never forward an upstream error body. */
export async function negotiateTranscription(key: string, config: TranscriptionConfig, sdp: string,
  request: (url: string, options: RequestInit) => Promise<Response>, signal?: AbortSignal): Promise<{ answerSdp: string }> {
  if (!key) throw new Error('Add an OpenAI API key in Settings to dictate.')
  if (!validTranscriptionOffer(sdp)) throw new Error('Invalid microphone connection offer.')
  const base = 'https://api.openai.com/v1/realtime'
  const timeout = AbortSignal.timeout(20000)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
  async function post(path: string, credential: string, contentType: string, body: string) {
    const response = await request(base + path, {
      method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': contentType },
      body, redirect: 'error', signal: abort
    }).catch(() => { throw new Error('Could not reach OpenAI to start dictation. Check your connection and try again.') })
    if (!response.ok) throw new Error('OpenAI could not start dictation (' + response.status +
      '). Check your API key, credits, and access to ' + config.model + ' in Settings.')
    return response
  }
  // Bind the short-lived credential to a transcription-only session. Both
  // credentials stay in this process; the renderer receives only the SDP answer.
  const secret = await post('/client_secrets', key, 'application/json', JSON.stringify({
    expires_after: { anchor: 'created_at', seconds: 60 },
    session: { type: 'transcription', audio: { input: {
      transcription: { model: config.model, delay: 'low' }, turn_detection: null
    } } }
  }))
  const value = (await secret.json().catch(() => null))?.value
  if (typeof value !== 'string' || !value) throw new Error('OpenAI could not authorize the microphone connection.')
  const response = await post('/calls', value, 'application/sdp', sdp)
  const answerSdp = await response.text()
  if (!answerSdp.startsWith('v=0')) throw new Error('OpenAI returned an invalid microphone connection.')
  return { answerSdp }
}
