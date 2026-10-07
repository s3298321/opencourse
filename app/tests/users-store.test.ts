/**
 * main/users.ts and main/paths.ts against a real directory. Electron is stubbed
 * down to the one call they make - app.getPath - which is what lets the whole
 * per-user layout to be tested without accessing real profiles.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'opencourse-userdata-'))
let dataDir = join(root, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? dataDir : join(root, name)),
    getAppPath: () => root,
    isPackaged: false
  }
}))

const {
  createUser,
  currentUserId,
  deleteUser,
  getSession,
  listUsers,
  renameUser,
  requireUser,
  switchUser
} = await import('../src/main/users')
const { userCoursesDir, userProfileFile, userProgressDir, userWorkspaceRoot, usersFile } =
  await import('../src/main/paths')

afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
beforeEach(() => {
  // The session is module state, so clear it while the old data directory is
  // still the current one - deleting the selected user is what resets it.
  for (const user of listUsers()) deleteUser(user.id)
  n += 1
  dataDir = join(root, `data-${n}`)
  mkdirSync(dataDir, { recursive: true })
})

describe('creating and switching users', () => {
  it('lays out the four directories a user owns', () => {
    const user = createUser('Ada')
    for (const dir of [userCoursesDir(user.id), userProgressDir(user.id), userWorkspaceRoot(user.id)]) {
      expect(existsSync(dir)).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(dataDir, 'users', user.id, 'profile.json'), 'utf8')).name).toBe('Ada')
  })

  it('selects the user it just created', () => {
    const user = createUser('Ada')
    expect(currentUserId()).toBe(user.id)
    expect(getSession().user?.name).toBe('Ada')
  })

  it('keeps each user in their own directory', () => {
    const ada = createUser('Ada')
    const grace = createUser('Grace')
    expect(userProgressDir(ada.id)).not.toBe(userProgressDir(grace.id))
    expect(requireUser()).toBe(grace.id)
    switchUser(ada.id)
    expect(requireUser()).toBe(ada.id)
  })

  it('refuses a user that is not in the index', () => {
    createUser('Ada')
    expect(() => switchUser('u_ffffffffffff')).toThrow(/unknown user/)
  })

  it('refuses to resolve a path with nobody selected', () => {
    expect(() => requireUser()).toThrow(/no user selected/)
  })

  it('survives a corrupt users.json instead of failing to launch', () => {
    createUser('Ada')
    writeFileSync(usersFile(), '{ not json')
    expect(listUsers()).toEqual([])
  })
})

describe('renaming', () => {
  it('rewrites users.json and the profile.json mirror together', () => {
    const user = createUser('Ada')
    const renamed = renameUser('Ada Lovelace')
    expect(renamed.id).toBe(user.id)
    expect(listUsers()[0]!.name).toBe('Ada Lovelace')
    // The mirror is what users.json could be rebuilt from, so it must not lag.
    expect(JSON.parse(readFileSync(userProfileFile(user.id), 'utf8')).name).toBe('Ada Lovelace')
  })

  it('renames the selected user, never another one', () => {
    const ada = createUser('Ada')
    const grace = createUser('Grace')
    renameUser('Grace H')
    const byId = Object.fromEntries(listUsers().map((u) => [u.id, u.name]))
    expect(byId[grace.id]).toBe('Grace H')
    expect(byId[ada.id]).toBe('Ada')
  })

  it('refuses with nobody selected', () => {
    const user = createUser('Ada')
    deleteUser(user.id)
    expect(() => renameUser('Ada')).toThrow(/no user selected/)
  })

  it('leaves every directory the user owns exactly where it was', () => {
    const user = createUser('Ada')
    writeFileSync(join(userProgressDir(user.id), 'demo.json'), '{}')
    renameUser('Ada Lovelace')
    expect(existsSync(join(userProgressDir(user.id), 'demo.json'))).toBe(true)
  })
})

describe('deleting', () => {
  it('deletes everything the user owned', () => {
    const user = createUser('Ada')
    writeFileSync(join(userProgressDir(user.id), 'demo.json'), '{}')
    mkdirSync(join(userWorkspaceRoot(user.id), 'demo', '.venv'), { recursive: true })
    deleteUser(user.id)
    expect(existsSync(join(dataDir, 'users', user.id))).toBe(false)
    expect(listUsers()).toEqual([])
  })

  it('deselects a user it deleted', () => {
    const user = createUser('Ada')
    deleteUser(user.id)
    expect(currentUserId()).toBeNull()
    expect(getSession().user).toBeNull()
  })

  it('leaves the other user selected when somebody else goes', () => {
    const ada = createUser('Ada')
    const grace = createUser('Grace')
    deleteUser(ada.id)
    expect(currentUserId()).toBe(grace.id)
  })
})
