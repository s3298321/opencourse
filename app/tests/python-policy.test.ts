// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '@core/schema'
import { getToolchain, hasToolchain, resolveRuntime, TOOLCHAIN_IDS } from '@core/toolchains'
import { projectCourse } from './helpers/project'
import { bundledPythonPath, pythonResourcesDir } from '../src/main/bundled-python'
import type { ExerciseBlock } from '@core/types'

const exercise: ExerciseBlock = { type: 'exercise', slug: 'exercise', id: 'exercise', title: 'Print', prompt: 'Print 1', verification_instructions: 'Prints 1', expected_output: '1\n' }
function course() {
  const course = projectCourse()
  course.modules[0].lessons![0].blocks = [exercise]
  return course
}

describe('Python exercise policy', () => {
  it('requires a course version in format 1.6', () => {
    expect(validateManifest({ ...course(), schema_version: '1.6' }).join(' ')).toContain('/version')
    expect(validateManifest({ ...course(), schema_version: '1.6', version: '0.1.0' })).toEqual([])
  })
  it('has only the Python toolchain', () => {
    expect(TOOLCHAIN_IDS).toEqual(['python'])
    for (const language of ['c', 'llvm-ir', 'rust']) {
      expect(hasToolchain(language)).toBe(false)
      expect(() => getToolchain(language)).toThrow('Only Python exercises are supported')
    }
  })
  it.each(['c', 'llvm-ir', 'rust'])('rejects %s at either runtime scope even in an old archive', language => {
    const inherited = course(); inherited.runtime = { language }
    expect(validateManifest(inherited).join(' ')).toContain('/runtime/language: Only Python exercises are supported')
    const own = course(); own.modules[0].lessons![0].blocks = [{ ...exercise, runtime: { language } }]
    expect(validateManifest(own).join(' ')).toContain('/blocks/0/runtime/language: Only Python exercises are supported')
  })
  it('keeps the former C course as a rejection fixture', () => {
    const old = JSON.parse(readFileSync(join(__dirname, 'fixtures/rejected-courses/intro-to-c/course.json'), 'utf8'))
    expect(validateManifest(old).join(' ')).toContain('Only Python exercises are supported')
  })
  it('allows arbitrary project starter languages and courses without exercises', () => {
    const project = projectCourse()
    const module = project.modules[1]
    if (module.type !== 'project') throw new Error('Expected a project fixture')
    module.project.starter_files = [{ path: 'src/main.c', content: 'int main(void) { return 0; }' }, { path: 'main.rs', content: 'fn main() {}' }]
    expect(validateManifest(project)).toEqual([])
  })
  it('preserves minimum overrides and merged legacy packages', () => {
    const c = course(); c.python_version = '3.11'; c.runtime = { version: '>=3.12.1', packages: ['httpx'] }
    expect(resolveRuntime(c).version).toBe('>=3.12.1')
    expect(resolveRuntime(c, { ...exercise, runtime: { version: '3.14.8', packages: ['httpx', 'numpy'] }, packages: ['pytest-asyncio'] })).toMatchObject({ language: 'python', version: '3.14.8', packages: ['httpx', 'numpy', 'pytest-asyncio'] })
  })
  it.each(['3.14.8', '>=3.14.8', '>= 3.11', '3.11'])('accepts minimum %s', version => {
    const c = course(); c.runtime = { version }; c.python_version = version
    expect(validateManifest(c)).toEqual([])
  })
  it.each(['==3.14.8', '<3.15', '>=3.11,<3.15', 'garbage'])('rejects ambiguous version %s at every scope', version => {
    const c = course(); c.runtime = { version }; c.python_version = version
    c.modules[0].lessons![0].blocks = [{ ...exercise, runtime: { version } }]
    const errors = validateManifest(c).join(' ')
    expect(errors).toContain('/python_version: Minimum Python version')
    expect(errors).toContain('/runtime/version: Minimum Python version')
    expect(errors).toContain('/blocks/0/runtime/version: Minimum Python version')
  })
  it('resolves packaged and development resources without consulting PATH', () => {
    expect(pythonResourcesDir(true, '/ignored/app.asar', '/Applications/OpenCourse.app/Contents/Resources')).toBe('/Applications/OpenCourse.app/Contents/Resources/python')
    expect(bundledPythonPath(pythonResourcesDir(false, '/repo/app', '/ignored'))).toBe('/repo/app/resources/python/bin/python3')
  })
})
