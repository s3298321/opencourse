/** Runtime location is configured by Electron; Node integration tests use the same development tree. */
import { join, resolve } from 'node:path'
import lock from '../../python-runtime.lock.json'

export const BUNDLED_PYTHON_VERSION = lock.version
export const BUNDLED_PYTHON_ID = `${lock.version}+${lock.release}:${lock.sha256}:${lock.licenses.sha256}`
let runtimeDir = resolve(__dirname, '../../resources/python')

export function pythonResourcesDir(packaged: boolean, appPath: string, resourcesPath: string): string {
  return join(packaged ? resourcesPath : join(appPath, 'resources'), 'python')
}

export function configureBundledPython(directory: string): void { runtimeDir = directory }
export function bundledPythonDir(): string { return runtimeDir }
export function bundledPythonPath(directory = runtimeDir): string { return join(directory, 'bin', 'python3') }
