import type { CourseManifest, ImageAttribution } from './types'

/** Credits are external links, never executable URLs or credential-bearing URLs. */
export function creditUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return
  try {
    const url = new URL(value)
    if (['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href
  } catch { /* Invalid metadata is not a link. */ }
}

export function attributionIssues(value: ImageAttribution): string[] {
  const issues: string[] = []
  for (const key of ['source_url', 'author_url', 'license_url'] as const) {
    if ((key === 'source_url' || value[key] !== undefined) && !creditUrl(value[key])) issues.push(`${key}: use an HTTP(S) URL without credentials`)
  }
  return issues
}

export function parseImageAttribution(raw: unknown): ImageAttribution {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Supply image attribution with an original source_url.')
  const fields = ['source_url', 'title', 'author', 'author_url', 'license', 'license_url']
  const result = raw as ImageAttribution
  for (const [key, value] of Object.entries(result)) {
    if (fields.includes(key) && key !== 'source_url' && value === undefined) continue
    if (!fields.includes(key) || typeof value !== 'string' || !value.trim() || value.length > (key.endsWith('_url') ? 2048 : 1000)) throw new Error(`Invalid attribution ${key}.`)
  }
  const issues = attributionIssues(result)
  if (issues.length) throw new Error(issues.join('; '))
  return structuredClone(result)
}

export function imageCreditsByPath(manifest: CourseManifest): Map<string, ImageAttribution> {
  const credits = new Map<string, ImageAttribution>()
  for (const module of manifest.modules) if (module.type !== 'project') for (const lesson of module.lessons) for (const block of lesson.blocks) {
    if (block.type === 'image' && block.attribution && !credits.has(block.src)) credits.set(block.src, block.attribution)
  }
  return credits
}
