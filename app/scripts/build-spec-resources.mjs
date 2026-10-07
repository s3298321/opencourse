/**
 * Generates the format bundles the app hands to authors:
 *
 *   resources/spec/course-format.md          the written spec
 *   resources/spec/course-schema.json        the machine-readable contract
 *   resources/spec/opencourse-example-course.zip  a working course, ready to import
 *
 *   resources/spec/theme-format.md           the theme spec
 *   resources/spec/theme-schema.json         its schema
 *   resources/spec/opencourse-default-theme.zip   the app's own look, as a theme
 *   resources/spec/opencourse-example-theme.zip   a theme using every feature
 *
 * Generated rather than checked in so the spec, the schema and the example can
 * never drift from the ones the app validates against. `ditto` is used for the
 * zip because it puts course.json at the archive root (no wrapping folder) and
 * ships with every macOS - this app is macOS-only.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(appDir, '..')
const out = join(appDir, 'resources', 'spec')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

copyFileSync(join(repoDir, 'docs', 'course-format.md'), join(out, 'course-format.md'))
copyFileSync(join(appDir, 'src', 'core', 'course-schema.json'), join(out, 'course-schema.json'))

const zip = (from, to) => execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', from, join(out, to)])

zip(join(repoDir, 'docs', 'example-course'), 'opencourse-example-course.zip')

copyFileSync(join(repoDir, 'docs', 'theme-format.md'), join(out, 'theme-format.md'))
copyFileSync(join(appDir, 'src', 'core', 'theme', 'theme-schema.json'), join(out, 'theme-schema.json'))
zip(join(repoDir, 'docs', 'default-theme'), 'opencourse-default-theme.zip')
zip(join(repoDir, 'docs', 'example-theme'), 'opencourse-example-theme.zip')

console.log(`spec resources written to ${out}`)
