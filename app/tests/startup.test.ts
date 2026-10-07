import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const fake = vi.hoisted(() => ({
  setName: vi.fn(), setPath: vi.fn(), getPath: vi.fn(), about: vi.fn(),
  quit: vi.fn(), error: vi.fn(), window: vi.fn(),
  makeProfile: vi.fn(), readFile: vi.fn(), listFiles: vi.fn(), stat: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('node:fs', () => ({
  default: {
    mkdtempSync: fake.makeProfile, readFileSync: fake.readFile,
    readdirSync: fake.listFiles, lstatSync: fake.stat
  },
  mkdtempSync: fake.makeProfile, readFileSync: fake.readFile,
  readdirSync: fake.listFiles, lstatSync: fake.stat
}))
vi.mock('node:child_process', () => ({ execFile: fake.spawn, execFileSync: fake.spawn }))
vi.mock('../src/main/db', () => ({ closeDb: vi.fn() }))
vi.mock('../src/main/ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('../src/main/menu', () => ({ buildMenu: vi.fn() }))
vi.mock('../src/main/mic', () => ({ wantsMic: () => false }))
vi.mock('../src/main/protocol', () => ({ registerProtocolHandler: vi.fn(), registerSchemePrivileges: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    setName: fake.setName, setPath: fake.setPath, getPath: fake.getPath,
    setAboutPanelOptions: fake.about, quit: fake.quit, on: vi.fn(),
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getAppPath: () => '/test/app', getVersion: () => '0.1.0', isPackaged: false
  },
  BrowserWindow: class {
    constructor(options: unknown) { fake.window(options) }
    static getAllWindows(): unknown[] { return [] }
    once = vi.fn()
    loadFile = vi.fn()
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
  },
  dialog: { showErrorBox: fake.error },
  nativeTheme: { on: vi.fn(), off: vi.fn(), prefersReducedTransparency: true },
  session: { defaultSession: {
    webRequest: { onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn()
  } },
  shell: { openExternal: vi.fn() }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  for (const name of ['OPENCOURSE_SMOKE', 'OPENCOURSE_SHOTS', 'OPENCOURSE_LIVE_CHECK', 'ELECTRON_RENDERER_URL']) {
    vi.stubEnv(name, '')
  }
  fake.getPath.mockImplementation((name: string) => {
    if (name !== 'appData') throw new Error(`Unexpected profile inspection: ${name}`)
    return '/test/Application Support'
  })
  fake.makeProfile.mockReturnValue('/test/isolated-profile')
})
afterEach(() => vi.unstubAllEnvs())

async function boot(): Promise<void> {
  await import('../src/main/index')
  await vi.waitFor(() => expect(fake.window).toHaveBeenCalledOnce())
  expect(fake.error).not.toHaveBeenCalled()
  expect(fake.quit).not.toHaveBeenCalled()
}

describe('OpenCourse startup', () => {
  it('starts a fresh profile without inspecting or migrating previous profiles', async () => {
    // Retired automation variables must not redirect the profile either.
    vi.stubEnv('LOCALCRS_SMOKE', '1')
    vi.stubEnv('LOCALCRS_SHOTS', '/retired/shots')
    vi.stubEnv('LOCALCRS_LIVE_CHECK', '1')
    await boot()
    expect(fake.setName).toHaveBeenCalledWith('OpenCourse')
    expect(fake.setPath.mock.calls).toEqual([['userData', join('/test/Application Support', 'opencourse')]])
    expect(fake.getPath.mock.calls).toEqual([['appData']])
    for (const operation of [fake.makeProfile, fake.readFile, fake.listFiles, fake.stat, fake.spawn]) {
      expect(operation).not.toHaveBeenCalled()
    }
    expect(fake.about).toHaveBeenCalledWith(expect.objectContaining({ applicationName: 'OpenCourse' }))
    expect(fake.window).toHaveBeenCalledWith(expect.objectContaining({ title: 'OpenCourse' }))
  })

  it.each(['OPENCOURSE_SMOKE', 'OPENCOURSE_SHOTS', 'OPENCOURSE_LIVE_CHECK'])('%s uses an isolated profile', async (name) => {
    vi.stubEnv(name, '1')
    vi.stubEnv('OPENCOURSE_RUN_PROFILE', '')
    await boot()
    expect(fake.makeProfile).toHaveBeenCalledWith(expect.stringMatching(/opencourse-run-$/))
    expect(fake.setPath).toHaveBeenLastCalledWith('userData', '/test/isolated-profile')
    expect(process.env['OPENCOURSE_RUN_PROFILE']).toBe('/test/isolated-profile')
    for (const operation of [fake.readFile, fake.listFiles, fake.stat, fake.spawn]) {
      expect(operation).not.toHaveBeenCalled()
    }
  })
})
