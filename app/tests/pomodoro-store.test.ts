// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const session = vi.hoisted(() => ({ directory: '', user: 'first' }))
vi.mock('../src/main/paths', () => ({ userPreferencesFile: (id: string) => join(session.directory, id, 'preferences.json') }))
vi.mock('../src/main/users', () => ({ requireUser: () => session.user }))
import { getPomodoroSettings, readPreferences, setPomodoroSettings, writePreferences } from '../src/main/preferences'

beforeEach(() => { session.directory = mkdtempSync(join(tmpdir(), 'pomodoro-test-')); session.user = 'first' })
afterEach(() => rmSync(session.directory, { recursive: true, force: true }))
it('persists durations per user and preserves unrelated preferences', () => {
  writePreferences({ readingScale: 1.25, webSearch: true })
  expect(getPomodoroSettings()).toEqual({ studyMinutes: 40, breakMinutes: 5 })
  setPomodoroSettings({ studyMinutes: 55, breakMinutes: 12 })
  expect(JSON.parse(readFileSync(join(session.directory, 'first/preferences.json'), 'utf8')).pomodoro).toEqual({ studyMinutes: 55, breakMinutes: 12 })
  expect(readPreferences()).toMatchObject({ readingScale: 1.25, webSearch: true })
  session.user = 'second'
  expect(getPomodoroSettings()).toEqual({ studyMinutes: 40, breakMinutes: 5 })
  setPomodoroSettings({ studyMinutes: 20, breakMinutes: 4 })
  session.user = 'first'
  expect(getPomodoroSettings()).toEqual({ studyMinutes: 55, breakMinutes: 12 })
})
it('rejects invalid writes without overwriting saved settings', () => {
  setPomodoroSettings({ studyMinutes: 40, breakMinutes: 10 })
  for (const value of [0, 181, -5, 0.5, Infinity, '40', null]) {
    expect(() => setPomodoroSettings({ studyMinutes: value as number, breakMinutes: 10 })).toThrow('whole minutes')
  }
  expect(getPomodoroSettings()).toEqual({ studyMinutes: 40, breakMinutes: 10 })
})
