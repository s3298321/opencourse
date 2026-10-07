import { describe, expect, it } from 'vitest'
import { assertSafeSegment } from '@core/scaffold'
import {
  addUser,
  newUserId,
  normalizeName,
  normalizeUsers,
  pickActive,
  removeUser,
  renameUser,
  USERS_VERSION
} from '@core/users'
import type { UsersIndex } from '@core/types'

function seeded(...names: string[]): UsersIndex {
  return names.reduce<UsersIndex>((index, name) => addUser(index, name).index, normalizeUsers(null))
}

describe('newUserId', () => {
  it('is always safe to use as a directory name', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newUserId()
      expect(() => assertSafeSegment(id, 'user id')).not.toThrow()
    }
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newUserId))
    expect(ids.size).toBe(200)
  })
})

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeName('  Ada   Lovelace \n')).toBe('Ada Lovelace')
  })

  it('caps the length', () => {
    expect(normalizeName('x'.repeat(200))).toHaveLength(40)
  })

  it('refuses a name that is only whitespace', () => {
    expect(() => normalizeName('   ')).toThrow(/needs a name/)
    expect(() => normalizeName(undefined)).toThrow(/needs a name/)
  })
})

describe('normalizeUsers', () => {
  it('turns nonsense into an empty index instead of throwing', () => {
    for (const raw of [null, undefined, 42, 'nope', [], { users: 'no' }]) {
      expect(normalizeUsers(raw)).toEqual({ version: USERS_VERSION, users: [] })
    }
  })

  it('drops entries with an unusable id and keeps the rest', () => {
    const index = normalizeUsers({
      users: [
        { id: '../escape', name: 'bad' },
        { id: 'u_abcdef123456', name: 'Good', color: '#3b82f6', createdAt: '2026-01-01T00:00:00.000Z' }
      ]
    })
    expect(index.users.map((u) => u.name)).toEqual(['Good'])
  })

  it('de-duplicates ids', () => {
    const one = { id: 'u_abcdef123456', name: 'One', color: '#3b82f6', createdAt: 'x' }
    expect(normalizeUsers({ users: [one, { ...one, name: 'Two' }] }).users).toHaveLength(1)
  })

  it('gives a user with a broken name and colour usable ones', () => {
    const [user] = normalizeUsers({ users: [{ id: 'u_abcdef123456', name: '  ', color: 'rebeccapurple' }] }).users
    expect(user?.name).toBe('u_abcdef123456')
    expect(user?.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('forgets an active id that no longer exists', () => {
    const index = normalizeUsers({ users: [], lastActiveUserId: 'u_abcdef123456' })
    expect(index.lastActiveUserId).toBeUndefined()
  })
})

describe('addUser', () => {
  it('assigns distinct colours to consecutive users', () => {
    const index = seeded('One', 'Two', 'Three')
    expect(new Set(index.users.map((u) => u.color)).size).toBe(3)
  })

  it('keeps existing users', () => {
    expect(seeded('One', 'Two').users.map((u) => u.name)).toEqual(['One', 'Two'])
  })
})

describe('renameUser', () => {
  it('renames in place and leaves the id alone', () => {
    const index = seeded('Ada', 'Grace')
    const before = index.users[0]!
    const { index: after, user } = renameUser(index, before.id, 'Ada L')
    expect(user.id).toBe(before.id)
    expect(user.name).toBe('Ada L')
    expect(after.users[0]!.name).toBe('Ada L')
  })

  it('normalizes the new name the way creating one does', () => {
    const index = seeded('Ada')
    const { user } = renameUser(index, index.users[0]!.id, '  Ada   Lovelace  ')
    expect(user.name).toBe('Ada Lovelace')
    expect(renameUser(index, index.users[0]!.id, 'x'.repeat(80)).user.name).toHaveLength(40)
  })

  it('refuses a name that is only whitespace', () => {
    const index = seeded('Ada')
    expect(() => renameUser(index, index.users[0]!.id, '   ')).toThrow(/needs a name/)
  })

  it('refuses a user who is not there', () => {
    expect(() => renameUser(seeded('Ada'), 'u_nope', 'Grace')).toThrow(/unknown user/)
  })

  it('leaves everybody else and the active pointer alone', () => {
    const seed = seeded('Ada', 'Grace')
    const index = pickActive(seed, seed.users[1]!.id)
    const target = index.users[0]!.id
    const { index: after } = renameUser(index, target, 'Ada L')
    expect(after.users[1]!.name).toBe('Grace')
    expect(after.lastActiveUserId).toBe(index.lastActiveUserId)
    expect(after.users).toHaveLength(2)
  })
})

describe('removeUser', () => {
  it('drops the user', () => {
    const index = seeded('One', 'Two')
    expect(removeUser(index, index.users[0]!.id).users.map((u) => u.name)).toEqual(['Two'])
  })

  it('clears the active pointer when the active user is the one going', () => {
    const index = seeded('One', 'Two')
    const active = pickActive(index, index.users[0]!.id)
    expect(removeUser(active, active.users[0]!.id).lastActiveUserId).toBeUndefined()
  })

  it('keeps the active pointer when somebody else goes', () => {
    const index = seeded('One', 'Two')
    const active = pickActive(index, index.users[0]!.id)
    expect(removeUser(active, active.users[1]!.id).lastActiveUserId).toBe(active.users[0]!.id)
  })
})

describe('pickActive', () => {
  it('records who is active and when they were last here', () => {
    const index = seeded('One')
    const now = new Date('2026-03-04T05:06:07.000Z')
    const active = pickActive(index, index.users[0]!.id, now)
    expect(active.lastActiveUserId).toBe(index.users[0]!.id)
    expect(active.users[0]!.lastUsedAt).toBe(now.toISOString())
  })

  it('refuses a user who is not there', () => {
    expect(() => pickActive(seeded('One'), 'u_ffffffffffff')).toThrow(/unknown user/)
  })
})
