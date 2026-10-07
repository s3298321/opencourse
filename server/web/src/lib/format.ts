/** Numbers, dates and words as the pages show them. */

export const plural = (n: number, word: string, many = `${word}s`): string => `${n.toLocaleString('en')} ${n === 1 ? word : many}`

export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

const dateFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' })
const dateTimeFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export const date = (iso: string): string => dateFormat.format(new Date(iso))
export const dateTime = (iso: string): string => dateTimeFormat.format(new Date(iso))

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
/** "3 days ago", "just now"; a date once it is over a month old. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), 'hour')
  if (abs < 30 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), 'day')
  return date(iso)
}

export function hours(course: { estimatedHours?: number; totalMinutes?: number }): string {
  if (course.estimatedHours) return `~${course.estimatedHours} h`
  if (course.totalMinutes) return course.totalMinutes < 90 ? `~${course.totalMinutes} min` : `~${Math.round(course.totalMinutes / 60)} h`
  return ''
}

export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A short, stable number for a string: picks a fallback cover or an avatar shade. */
export function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** What a user agent string means to a person: "Safari on macOS", "OpenCourse app". */
export function device(userAgent: string, kind: 'app' | 'web'): string {
  if (kind === 'app' || /^OpenCourse\//.test(userAgent)) {
    const version = /^OpenCourse\/([\w.-]+)/.exec(userAgent)?.[1]
    return version && version !== 'dev' ? `OpenCourse app ${version}` : 'OpenCourse app'
  }
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /OPR\//.test(userAgent) ? 'Opera'
    : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'A browser'
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
    : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}
