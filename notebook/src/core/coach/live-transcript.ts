import type { CoachTranscriptFragment, TranscriptTurn } from '../types'

export function validFragment(value: unknown): value is CoachTranscriptFragment {
  if (!value || typeof value !== 'object') return false
  const f = value as CoachTranscriptFragment
  return typeof f.eventId === 'string' && f.eventId.length > 0 && f.eventId.length <= 200 &&
    (f.role === 'user' || f.role === 'assistant') && typeof f.text === 'string' && f.text.length <= 16_384 &&
    Number.isFinite(f.startMs) && Number.isFinite(f.endMs) && f.startMs >= 0 && f.endMs >= f.startMs
}

/** Timeline order, not network delivery order. Each speaker owns independent bubbles. */
export function liveTranscript(fragments: readonly CoachTranscriptFragment[], startedAt: string): TranscriptTurn[] {
  const seen = new Map<string, CoachTranscriptFragment>()
  for (const fragment of fragments) if (validFragment(fragment) && !seen.has(fragment.eventId)) seen.set(fragment.eventId, fragment)
  const sorted = [...seen.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const bubbles: { role: 'user' | 'assistant'; text: string; start: number; end: number }[] = []
  const last: Partial<Record<'user' | 'assistant', typeof bubbles[number]>> = {}
  for (const fragment of sorted) {
    if (!fragment.text) continue
    let bubble = last[fragment.role]
    if (!bubble || fragment.startMs - bubble.end > 1000) {
      bubble = { role: fragment.role, text: '', start: fragment.startMs, end: fragment.endMs }
      bubbles.push(bubble)
      last[fragment.role] = bubble
    }
    bubble.text += fragment.text
    bubble.end = Math.max(bubble.end, fragment.endMs)
  }
  const start = Date.parse(startedAt) || 0
  return bubbles.sort((a, b) => a.start - b.start).map((b, seq) => ({
    seq, role: b.role, text: b.text, at: new Date(start + b.start).toISOString()
  }))
}
