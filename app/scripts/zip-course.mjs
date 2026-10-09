/**
 * Packs a course directory into the importable archive the app expects.
 *
 *   npm run zip:course <slug>            one course
 *   npm run zip:course                   every course in content/
 *
 * Archives land in content-zip/ (git-ignored - they are build output, and the
 * asyncio one is ~95 KB of duplicated course.json). `ditto` is used because it
 * puts course.json at the archive root rather than wrapping it in a folder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const contentDir = join(repoDir, 'content')
const outDir = join(repoDir, 'content-zip')

function courseSlugs() {
  return readdirSync(contentDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(contentDir, name)).isDirectory())
    .filter((name) => existsSync(join(contentDir, name, 'course.json')))
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const slugs = requested.length ? requested : courseSlugs()

if (!slugs.length) {
  console.error(`no courses found in ${contentDir}`)
  process.exit(1)
}

for (const slug of slugs) {
  const source = join(contentDir, slug)
  if (!existsSync(join(source, 'course.json'))) {
    console.error(`${slug}: no course.json in ${source}`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
for (const slug of slugs) {
  const archive = join(outDir, `${slug}.zip`)
  rmSync(archive, { force: true })
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', join(contentDir, slug), archive])
  const kb = Math.round(statSync(archive).size / 1024)
  console.log(`${archive}  (${kb} KB)`)
}
console.log(`\nImport these with Library ▸ Import course…`)
