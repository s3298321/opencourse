/**
 * content/ is authoring input and gitignored: a clean clone - CI - has none of
 * it. A test about a particular course runs when the course is here and fails
 * loudly when a developer's copy lacks it, as it always has. Only under CI,
 * where its absence is expected, does it skip instead - visibly, as skipped.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const CONTENT_DIR = join(__dirname, '..', '..', '..', 'content')

export const hasCourse = (slug: string): boolean => existsSync(join(CONTENT_DIR, slug, 'course.json'))

/** True when these courses are absent and this is CI: skip rather than fail. */
export function skipWithoutContent(...slugs: string[]): boolean {
  return Boolean(process.env['CI']) && slugs.some((slug) => !hasCourse(slug))
}
