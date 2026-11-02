import type { WebContents } from 'electron'
import { VOICES } from '../core/coach/models'
import { readKey } from './coachkey'
import { createLiveVoicePreview } from './openai'
import { getDefaultCoachModel } from './preferences'
import { requireUser } from './users'

const pending = new Set<number>()

export async function previewCoachVoice(sender: WebContents, voice: string, offerSdp: string): Promise<{ answerSdp: string }> {
  requireUser()
  if (typeof voice !== 'string' || !VOICES.includes(voice)) throw new Error('Choose a supported coach voice.')
  if (typeof offerSdp !== 'string' || offerSdp.length > 100_000 || !offerSdp.startsWith('v=0')) throw new Error('Invalid preview connection.')
  const key = readKey()
  if (!key) throw new Error('Add an OpenAI API key in Connections to preview voices.')
  if (pending.has(sender.id)) throw new Error('Wait for the current voice preview to finish connecting.')
  pending.add(sender.id)
  try { return await createLiveVoicePreview(key, getDefaultCoachModel(), voice, offerSdp) }
  finally { pending.delete(sender.id) }
}
