// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ paths: new Set<string>(), execute: vi.fn(), save: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: (path: string) => mocked.paths.has(path) }))
vi.mock('node:os', () => ({ homedir: () => '/Users/Learner' }))
vi.mock('node:child_process', () => ({ execFile: mocked.execute }))
vi.mock('../src/main/preferences', () => ({ readPreferences: () => ({ chatModels: ['gpt-5.6-sol'] }), writePreferences: mocked.save }))
const { installedEditors, launchProjectEditor } = await import('../src/main/editors')
beforeEach(() => {
  mocked.paths.clear(); mocked.execute.mockReset(); mocked.save.mockReset()
  mocked.execute.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
})
describe('project editor launching', () => {
  it('detects supported system and user app bundles in preference order', () => {
    mocked.paths.add('/Applications/Zed.app')
    mocked.paths.add('/Users/Learner/Applications/Visual Studio Code.app')
    expect(installedEditors().map(e => e.id)).toEqual(['zed', 'vscode'])
  })
  it('passes the workspace as a literal argument and preserves other preferences', async () => {
    mocked.paths.add('/Applications/Zed.app')
    const directory = '/Users/Learner/Project with spaces $(echo bad)'
    await launchProjectEditor(directory, 'zed')
    expect(mocked.execute).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/Applications/Zed.app', directory], { timeout: 10000, maxBuffer: 8192 }, expect.any(Function))
    expect(mocked.save).toHaveBeenCalledWith({ chatModels: ['gpt-5.6-sol'], projectEditor: 'zed' })
  })
  it('rejects arbitrary editor commands and does not save a failed launch', async () => {
    await expect(launchProjectEditor('/project', 'zed; echo bad')).rejects.toThrow('no longer installed')
    expect(mocked.execute).not.toHaveBeenCalled()
    mocked.paths.add('/Applications/Zed.app')
    mocked.execute.mockImplementation((_file, _args, _options, callback) => callback(new Error('Launch failed')))
    await expect(launchProjectEditor('/project', 'zed')).rejects.toThrow('Launch failed')
    expect(mocked.save).not.toHaveBeenCalled()
  })
})
