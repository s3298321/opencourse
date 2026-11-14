/** Pick a default name for a newly authored block, independent of its UUID. */
export function availableBlockSlug(base: string, used: Iterable<string | undefined>): string {
  const taken = new Set(used)
  let slug = base
  for (let suffix = 2; taken.has(slug); suffix++) slug = `${base}-${suffix}`
  return slug
}
