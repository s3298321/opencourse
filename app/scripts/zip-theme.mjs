/**
 * Packs a theme directory into the importable archive the app expects.
 *
 *   npm run zip:theme paper-and-ink    one theme
 *   npm run zip:theme neon-afterhours  one built-in theme
 *   npm run zip:theme                  every local and built-in theme
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
const builtinThemesDir = join(repoDir, 'app', 'resources', 'themes')
const outDir = join(repoDir, 'themes-zip')

function themeSlugs(root) {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .filter((name) => existsSync(join(root, name, 'theme.json')))
}

// A bundled theme wins a name collision with a local working copy.
const sources = new Map([
  ...themeSlugs(themesDir).map(slug => [slug, join(themesDir, slug)]),
  ...themeSlugs(builtinThemesDir).map(slug => [slug, join(builtinThemesDir, slug)])
])
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const slugs = requested.length ? requested : [...sources.keys()]

if (!slugs.length) {
  console.error(`no themes found in ${themesDir} or ${builtinThemesDir}`)
  process.exit(1)
}

for (const slug of slugs) {
  if (!sources.has(slug)) {
    console.error(`${slug}: no local or built-in theme with this name`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
for (const slug of slugs) {
  const archive = join(outDir, `${slug}.zip`)
  rmSync(archive, { force: true })
  execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', sources.get(slug), archive])
  const kb = Math.round(statSync(archive).size / 1024)
  console.log(`${archive}  (${kb} KB)`)
}
console.log(`\nImport these with Settings ▸ Import Theme…`)
