/**
 * Local users. No passwords, no accounts, no server - a user is a display name
 * and a generated id, and the id is what every per-user directory is named
 * after. The name is never a path segment, so it stays free text.
 *
 * Pure: the persistence lives in src/main/users.ts.
 */
import type { UserProfile, UsersIndex } from './types'

export const USERS_VERSION = 1
export const MAX_NAME_LENGTH = 40

/** Enough hues to tell a household apart at a glance; index picks, order repeats. */
export const USER_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308'] as const

/** Matches SAFE_SEGMENT in scaffold.ts, so a user id is always a safe directory name. */
export function newUserId(): string {
  return `u_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Trims and collapses whitespace. Throws when nothing is left. */
export function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : ''
  if (!name) throw new Error('a user needs a name')
  return name
}

function normalizeProfile(raw: unknown, fallbackColor: string): UserProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<UserProfile>
  if (typeof value.id !== 'string' || !/^u_[a-f0-9]{6,32}$/.test(value.id)) return null
  let name: string
  try {
    name = normalizeName(value.name)
  } catch {
    name = value.id
  }
  return {
    id: value.id,
    name,
    color: typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : fallbackColor,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {})
  }
}

/**
 * Defensive, like normalizeProgress: a hand-edited or half-written users.json
 * must degrade to "the users I can still read", never to a crash on launch.
 */
export function normalizeUsers(raw: unknown): UsersIndex {
  const source = raw && typeof raw === 'object' ? (raw as Partial<UsersIndex>) : {}
  const users: UserProfile[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(source.users) ? source.users : []) {
    const profile = normalizeProfile(entry, USER_COLORS[users.length % USER_COLORS.length]!)
    if (profile && !seen.has(profile.id)) {
      seen.add(profile.id)
      users.push(profile)
    }
  }
  const lastActiveUserId =
    typeof source.lastActiveUserId === 'string' && seen.has(source.lastActiveUserId)
      ? source.lastActiveUserId
      : undefined
  return { version: USERS_VERSION, users, ...(lastActiveUserId ? { lastActiveUserId } : {}) }
}

export function findUser(index: UsersIndex, id: string): UserProfile | undefined {
  return index.users.find((user) => user.id === id)
}

export function addUser(index: UsersIndex, name: string, now = new Date()): { index: UsersIndex; user: UserProfile } {
  const user: UserProfile = {
    id: newUserId(),
    name: normalizeName(name),
    color: USER_COLORS[index.users.length % USER_COLORS.length]!,
    createdAt: now.toISOString()
  }
  return { index: { ...index, users: [...index.users, user] }, user }
}

/**
 * Renames one user in place. The id never changes, so every directory they own
 * stays exactly where it is - a name is a label, not a path segment. Goes
 * through normalizeName so a rename is capped and trimmed the same way a
 * creation is, or profile.json and users.json would disagree about the name.
 */
export function renameUser(
  index: UsersIndex,
  id: string,
  name: string
): { index: UsersIndex; user: UserProfile } {
  const existing = findUser(index, id)
  if (!existing) throw new Error(`unknown user: ${id}`)
  const user: UserProfile = { ...existing, name: normalizeName(name) }
  return { index: { ...index, users: index.users.map((u) => (u.id === id ? user : u)) }, user }
}

/** Also drops the active pointer: a deleted user must not stay selected. */
export function removeUser(index: UsersIndex, id: string): UsersIndex {
  const users = index.users.filter((user) => user.id !== id)
  const keepActive = index.lastActiveUserId && index.lastActiveUserId !== id ? index.lastActiveUserId : undefined
  return { version: index.version, users, ...(keepActive ? { lastActiveUserId: keepActive } : {}) }
}

/** Marks a user as the one to open next time, and stamps when they were last here. */
export function pickActive(index: UsersIndex, id: string, now = new Date()): UsersIndex {
  if (!findUser(index, id)) throw new Error(`unknown user: ${id}`)
  return {
    ...index,
    lastActiveUserId: id,
    users: index.users.map((user) => (user.id === id ? { ...user, lastUsedAt: now.toISOString() } : user))
  }
}
