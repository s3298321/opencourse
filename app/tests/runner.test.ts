/**
 * What is left of the runner once nothing about it is language-specific.
 * Everything Python moved to toolchain-python.test.ts, with the same expectations.
 */
import { describe, expect, it } from 'vitest'
import { childEnv, mergePath } from '@core/runner'

describe('mergePath', () => {
  it('prepends in order and drops duplicates and blanks', () => {
    expect(mergePath(['/venv/bin', '/opt/homebrew/bin'], '/usr/bin:/opt/homebrew/bin::/bin')).toBe(
      '/venv/bin:/opt/homebrew/bin:/usr/bin:/bin'
    )
  })

  it('survives an empty base PATH', () => {
    expect(mergePath(['/venv/bin'], '')).toBe('/venv/bin')
  })
})

describe('childEnv', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_OVERRIDE_DIST_PATH: '/cache/electron',
    NODE_OPTIONS: '--max-old-space-size=4096',
    npm_config_prefix: '/opt',
    npm_lifecycle_event: 'smoke'
  }

  it('strips the Electron and npm runtime out of the child', () => {
    const env = childEnv({ base })
    for (const key of Object.keys(base).filter((k) => k.startsWith('npm_') || k.startsWith('ELECTRON_'))) {
      expect(env[key]).toBeUndefined()
    }
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['HOME']).toBe('/Users/me')
  })

  it('prepends the given dirs to PATH in order', () => {
    const env = childEnv({ base, pathDirs: ['/w/course/.venv/bin', '/opt/homebrew/bin'] })
    expect(env['PATH']).toBe('/w/course/.venv/bin:/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('defaults LANG, because a Finder-launched app has none', () => {
    expect(childEnv({ base })['LANG']).toBe('en_US.UTF-8')
    expect(childEnv({ base: { ...base, LANG: 'C' } })['LANG']).toBe('C')
  })

  it('gives a TERM only to a pty', () => {
    expect(childEnv({ base })['TERM']).toBeUndefined()
    expect(childEnv({ base, term: 'xterm-256color' })['TERM']).toBe('xterm-256color')
  })

  it('lets a toolchain both set and unset a variable', () => {
    const env = childEnv({
      base: { ...base, PYTHONHOME: '/opt/weird' },
      extra: { VIRTUAL_ENV: '/w/course/.venv', PYTHONHOME: null }
    })
    expect(env['VIRTUAL_ENV']).toBe('/w/course/.venv')
    expect(env['PYTHONHOME']).toBeUndefined()
  })
})
