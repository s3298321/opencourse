/**
 * Coach ids. Both are directory names or database keys, so both match
 * SAFE_SEGMENT in scaffold.ts - containment stays structural, exactly as it is
 * for user ids and exercise dirs.
 */

function hex12(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function newProjectId(): string {
  return `cp_${hex12()}`
}

export function newSessionId(): string {
  return `cs_${hex12()}`
}

const PROJECT_ID_RE = /^cp_[a-f0-9]{6,32}$/

/** Guards normalizeProject, so a hand-edited mirror cannot name a stray directory. */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_RE.test(value)
}
