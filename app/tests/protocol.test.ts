import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach } from 'vitest'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (request: { url: string }) => Promise<Response>>(),
  privileges: vi.fn(), fetch: vi.fn(), root: ''
}))
vi.mock('electron', () => ({ protocol: {
  registerSchemesAsPrivileged: fake.privileges,
  handle: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => fake.handlers.set(scheme, handler)
}, net: { fetch: fake.fetch } }))
vi.mock('../src/main/courses', () => ({ getCourse: (slug: string) => slug === 'demo' ? { root: fake.root } : null }))
// The theme store decides which file a theme URL names; the handler decides how it is served.
vi.mock('../src/main/themes', () => ({
  themeImageFile: (id: string, path: string) => id !== '11111111-1111-4111-8111-111111111111' ? null
    : path === 'images/desk.svg' ? join(fake.root, 'desk.svg') : path === 'images/grain.png' ? join(fake.root, 'grain.png') : null
}))
import { registerProtocolHandler, registerSchemePrivileges } from '../src/main/protocol'

beforeEach(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'opencourse-protocol-'))
  fake.handlers.clear(); fake.privileges.mockClear()
  fake.fetch.mockReset().mockImplementation(async () => new Response('<body><h1>Course content</h1></body>'))
  mkdirSync(join(fake.root, 'assets/viz/demo'), { recursive: true })
  writeFileSync(join(fake.root, 'assets/viz/demo/index.html'), '<body>demo</body>')
  registerProtocolHandler()
})
afterEach(() => rmSync(fake.root, { recursive: true, force: true }))

describe('theme pictures', () => {
  const theme = 'opencourse://themes/11111111-1111-4111-8111-111111111111'
  it('are served from the reserved host, locked down even if opened directly', async () => {
    const response = await fake.handlers.get('opencourse')!({ url: `${theme}/images/desk.svg` })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(fake.fetch).toHaveBeenCalledOnce()
  })
  it('refuse anything the theme store does not name, before reading a file', async () => {
    for (const path of ['images/other.svg', 'theme.json', '%E0%A4%A', '../files/images/desk.svg']) {
      expect((await fake.handlers.get('opencourse')!({ url: `${theme}/${path}` })).status, path).toBe(404)
    }
    expect((await fake.handlers.get('opencourse')!({ url: 'opencourse://themes/' })).status).toBe(404)
    expect(fake.fetch).not.toHaveBeenCalled()
  })
  it('serve bytes only: a strength in the URL is the renderer\'s to apply', async () => {
    const response = await fake.handlers.get('opencourse')!({ url: `${theme}/images/grain.png?strength=0.5` })
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(fake.fetch).toHaveBeenCalledOnce()
    expect(String(fake.fetch.mock.calls[0]![0])).toMatch(/grain\.png$/)
  })
  it('never fall through to a course, even one named like the host', async () => {
    const response = await fake.handlers.get('opencourse')!({ url: 'opencourse://themes/assets/viz/demo/index.html' })
    expect(response.status).toBe(404)
  })
})

describe('OpenCourse asset protocol', () => {
  it('registers only the current scheme with secure capabilities', () => {
    registerSchemePrivileges()
    expect(fake.privileges.mock.calls[0]?.[0].map((entry: { scheme: string }) => entry.scheme)).toEqual(['opencourse'])
    const [current] = fake.privileges.mock.calls[0]![0]
    expect(current.privileges.secure).toBe(true)
    expect([...fake.handlers.keys()]).toEqual(['opencourse'])
    for (const retired of ['localcrs', 'pycrs']) expect(fake.handlers.has(retired)).toBe(false)
  })
  for (const scheme of ['opencourse']) {
    it(`${scheme} serves sandboxed visualizations with the current bridge`, async () => {
      const response = await fake.handlers.get(scheme)!({ url: `${scheme}://demo/assets/viz/demo/index.html` })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(await response.text()).toContain('/__opencourse/viz-bridge.js')
    })
    it(`${scheme} refuses unknown courses and escaped paths`, async () => {
      expect((await fake.handlers.get(scheme)!({ url: `${scheme}://missing/assets/a.png` })).status).toBe(404)
      expect((await fake.handlers.get(scheme)!({ url: `${scheme}://demo/%2e%2e%2foutside` })).status).toBe(404)
      expect(fake.fetch).not.toHaveBeenCalled()
    })
    it(`${scheme} serves its bridge without consulting course files`, async () => {
      const response = await fake.handlers.get(scheme)!({ url: `${scheme}://demo/__opencourse/viz-bridge.js` })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('opencourse-viz')
      expect(fake.fetch).not.toHaveBeenCalled()
    })
    it(`${scheme} does not serve the retired bridge aliases`, async () => {
      for (const brand of ['localcrs', 'pycrs']) {
        const response = await fake.handlers.get(scheme)!({ url: `${scheme}://demo/__${brand}/viz-bridge.js` })
        expect(response.status).toBe(404)
      }
      expect(fake.fetch).not.toHaveBeenCalled()
    })
  }
})
