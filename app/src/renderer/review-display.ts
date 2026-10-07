import type { ReviewRating, ReviewSummary } from '@core/types'

export const ratingLabels: Record<ReviewRating, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }
export const ratingDescriptions: Record<ReviewRating, string> = {
  again: 'Forgot or answered incorrectly', hard: 'Recalled with difficulty', good: 'Recalled correctly', easy: 'Recalled effortlessly'
}
export function reviewTime(at: string, now = new Date()): string {
  const date = new Date(at), minutes = Math.max(1, Math.round((date.getTime() - now.getTime()) / 60000))
  if (date <= now) return 'now'
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  if (minutes < 24 * 60) { const hours = Math.round(minutes / 60); return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}` }
  return `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}`
}
export function reviewRecommendation(summary: ReviewSummary): string {
  if (!summary.total) return 'This course has no flashcards yet.'
  if (!summary.eligible) return 'Complete a lesson with flashcards to unlock review.'
  if (summary.due) return 'Review now'
  if (summary.new) return 'New cards ready'
  return summary.nextDue ? `Next review ${reviewTime(summary.nextDue)}` : 'Ready for review'
}
