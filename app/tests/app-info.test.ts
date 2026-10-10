import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getVersion: () => '9.8.7' } }))
import { appInfo, bundledPythonInfo } from '../src/main/app-info'

const directories: string[] = []
const directory = (): string => { const path = mkdtempSync(join(tmpdir(), 'opencourse-about-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
describe('About metadata', () => {
  it('uses Electron app metadata and the running Node version', () => {
    expect(appInfo()).toMatchObject({ name: 'OpenCourse', version: '9.8.7', node: process.versions.node, platform: process.platform, architecture: process.arch, license: 'MIT' })
  })
  it('reads the shipped Python version and matching distribution stamp', () => {
    const path = directory()
    writeFileSync(join(path, 'PYTHON.json'), JSON.stringify({ python_version: '3.15.2' }))
    writeFileSync(join(path, '.opencourse-runtime'), '3.15.2+20270101:hash:licenses')
    expect(bundledPythonInfo(path)).toEqual({ version: '3.15.2', release: '20270101' })
    writeFileSync(join(path, '.opencourse-runtime'), '3.14.1+20260101:hash:licenses')
    expect(bundledPythonInfo(path)).toEqual({ version: '3.15.2', release: null })
  })
  it('handles missing, malformed and incomplete metadata', () => {
    const path = directory()
    expect(bundledPythonInfo(path)).toBeNull()
    writeFileSync(join(path, 'PYTHON.json'), '{')
    expect(bundledPythonInfo(path)).toBeNull()
    writeFileSync(join(path, 'PYTHON.json'), '{}')
    expect(bundledPythonInfo(path)).toBeNull()
    writeFileSync(join(path, 'PYTHON.json'), '{"python_version":"3.14.8"}')
    expect(bundledPythonInfo(path)).toEqual({ version: '3.14.8', release: null })
  })
})
