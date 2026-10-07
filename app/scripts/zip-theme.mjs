/**
 * Packs a theme directory into the importable archive the app expects.
 *
 *   npm run zip:theme paper-and-ink    one theme
 *   npm run zip:theme                  every theme in themes/
 *
 * Archives land in themes-zip/ (git-ignored - build output, like content-zip/).
 * `ditto` is used because it puts theme.json at the archive root rather than
 * wrapping it in a folder.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const themesDir = join(repoDir, 'themes')
const outDir = join(repoDir, 'themes-zip')

function themeSlugs() {
  if (!existsSync(themesDir)) return []
  return readdirSync(themesDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(themesDir, name)).isDirectory())
    .filter((name) => existsSync(join(themesDir, name, 'theme.json')))
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const slugs = requested.length ? requested : themeSlugs()

if (!slugs.length) {
  console.error(`no themes found in ${themesDir}`)
  process.exit(1)
}

for (const slug of slugs) {
  const source = join(themesDir, slug)
  if (!existsSync(join(source, 'theme.json'))) {
    console.error(`${slug}: no theme.json in ${source}`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
for (const slug of slugs) {
  const archive = join(outDir, `${slug}.zip`)
  rmSync(archive, { force: true })
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', join(themesDir, slug), archive])
  const kb = Math.round(statSync(archive).size / 1024)
  console.log(`${archive}  (${kb} KB)`)
}
console.log(`\nImport these with Settings ▸ Import Theme…`)
