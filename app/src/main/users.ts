/**
 * User persistence and the current session.
 *
 * The renderer never passes a user id to anything that builds a path - main
 * resolves it from `currentUserId()`. `switchUser` is the one channel that
 * takes an id, and it only accepts one that is already in users.json.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addUser, findUser, normalizeUsers, pickActive, removeUser, renameUser as renameIn } from '../core/users'
import type { Session, UserProfile, UsersIndex } from '../core/types'
import { userCoursesDir, userDir, userProfileFile, userProgressDir, userWorkspaceRoot, usersFile } from './paths'

let session: string | null = null

function readIndex(): UsersIndex {
  try {
    return normalizeUsers(JSON.parse(readFileSync(usersFile(), 'utf8')))
  } catch {
    return normalizeUsers(null)
  }
}

/** Atomic, like the progress writer: a truncated users.json loses everyone. */
function writeIndex(index: UsersIndex): UsersIndex {
  mkdirSync(join(usersFile(), '..'), { recursive: true })
  const tmp = `${usersFile()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(index, null, 2))
  renameSync(tmp, usersFile())
  return index
}

function makeUserDirs(user: UserProfile): void {
  for (const dir of [userCoursesDir(user.id), userProgressDir(user.id), userWorkspaceRoot(user.id)]) {
    mkdirSync(dir, { recursive: true })
  }
  // A self-describing directory: users.json can be rebuilt from these if lost.
  writeFileSync(userProfileFile(user.id), JSON.stringify(user, null, 2))
}

export function listUsers(): UserProfile[] {
  return readIndex().users
}

export function currentUserId(): string | null {
  return session
}

export function currentUser(): UserProfile | null {
  return session ? (findUser(readIndex(), session) ?? null) : null
}

/** Every per-user path goes through here, so an unset session fails loudly. */
export function requireUser(): string {
  if (!session) throw new Error('no user selected')
  return session
}

export function getSession(): Session {
  return { user: currentUser(), users: listUsers() }
}

export function createUser(name: string): UserProfile {
  const { index, user } = addUser(readIndex(), name)
  makeUserDirs(user)
  writeIndex(pickActive(index, user.id))
  session = user.id
  return user
}

export function switchUser(id: string): UserProfile {
  const index = readIndex()
  const user = findUser(index, id)
  if (!user) throw new Error(`unknown user: ${id}`)
  makeUserDirs(user)
  writeIndex(pickActive(index, id))
  // No cache to clear: the course cache is keyed by user id, so it can never
  // serve one user's library to another.
  session = id
  return user
}

/**
 * Renames whoever is selected. Deliberately takes no id: a rename rewrites
 * profile.json, which is a path this module builds, so the user it applies to
 * comes from the session rather than from the renderer. makeUserDirs already
 * writes that mirror and is idempotent - there is no second writer for it.
 */
export function renameUser(name: string): UserProfile {
  const { index, user } = renameIn(readIndex(), requireUser(), name)
  writeIndex(index)
  makeUserDirs(user)
  return user
}

/** Removes the user and everything they own: courses, progress, work, venvs. */
export function deleteUser(id: string): void {
  const index = readIndex()
  if (!findUser(index, id)) throw new Error(`unknown user: ${id}`)
  writeIndex(removeUser(index, id))
  rmSync(userDir(id), { recursive: true, force: true })
  if (session === id) session = null
}
