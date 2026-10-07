// Everything the site needs that is not its own source, gathered before Astro
// runs (npm's prebuild/predev):
//
//  - the brand pictures, from design/assets/brand (one export of the app's mark);
//  - the format downloads the docs offer: both JSON Schemas, and the example
//    course and themes zipped - the same files, under the same names, as the
//    app's own app/scripts/build-spec-resources.mjs, but zipped with fflate so
//    a Linux build needs no `ditto`;
//  - from GitHub's API: the stars and the newest release;
//  - from the catalog's API: its most-added courses, covers copied in, so the
//    page never loads a picture from another host.
//
// Network failures are not build failures: the page shows less, never wrong.
// GitHub answers are cached in .cache/ for an hour outside CI.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { zipSync } from 'fflate'

const site = resolve(import.meta.dirname, '..')
const repo = resolve(site, '..')
const pub = join(site, 'public')
const REPO = 's3298321/opencourse'
const ASSET = 'OpenCourse-mac-arm64.dmg'
const catalogUrl = (process.env.PUBLIC_CATALOG_URL ?? 'https://catalog.opencourse.dev').replace(/\/+$/, '')

/* ---------- brand ---------- */
const brand = join(repo, 'design', 'assets', 'brand')
rmSync(join(pub, 'brand'), { recursive: true, force: true })
cpSync(brand, join(pub, 'brand'), { recursive: true })
for (const file of ['favicon-32.png', 'apple-touch-icon.png']) cpSync(join(brand, file), join(pub, file))

/* ---------- format downloads ---------- */
const downloads = join(pub, 'downloads')
rmSync(downloads, { recursive: true, force: true })
mkdirSync(downloads, { recursive: true })
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (name === '.DS_Store') return []
  return statSync(path).isDirectory() ? files(path) : [path]
})
// A fixed timestamp: the same docs make byte-identical zips, so a deploy only uploads what changed.
const zipDir = (dir, name) => {
  const entries = Object.fromEntries(files(dir).map((file) => [relative(dir, file).split('\\').join('/'), [readFileSync(file), { mtime: new Date('2026-01-01T00:00:00Z') }]]))
  writeFileSync(join(downloads, name), zipSync(entries, { level: 9 }))
}
zipDir(join(repo, 'docs', 'example-course'), 'opencourse-example-course.zip')
zipDir(join(repo, 'docs', 'default-theme'), 'opencourse-default-theme.zip')
zipDir(join(repo, 'docs', 'example-theme'), 'opencourse-example-theme.zip')
cpSync(join(repo, 'app', 'src', 'core', 'course-schema.json'), join(downloads, 'course-schema.json'))
cpSync(join(repo, 'app', 'src', 'core', 'theme', 'theme-schema.json'), join(downloads, 'theme-schema.json'))

/* ---------- GitHub ---------- */
const cacheFile = join(site, '.cache', 'github.json')
async function json(url, headers = {}, timeout = 8000) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.json()
}

async function github() {
  const fresh = existsSync(cacheFile) && !process.env.CI && Date.now() - statSync(cacheFile).mtimeMs < 60 * 60_000
  if (fresh) return JSON.parse(readFileSync(cacheFile, 'utf8'))
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'opencourse.dev build', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  const result = { repo: null, release: null }
  try {
    const r = await json(`https://api.github.com/repos/${REPO}`, headers)
    result.repo = { stars: r.stargazers_count, forks: r.forks_count, description: r.description, license: r.license?.spdx_id ?? null }
  } catch (error) { console.warn(`  GitHub repository: ${error.message}`) }
  try {
    const r = await json(`https://api.github.com/repos/${REPO}/releases/latest`, headers)
    const asset = r.assets?.find((a) => a.name === ASSET)
    result.release = {
      version: String(r.tag_name ?? '').replace(/^v/, ''),
      tag: r.tag_name, url: r.html_url, publishedAt: r.published_at, notes: r.body ?? '',
      // The release workflow marks a build it could not sign; the download page explains Gatekeeper then.
      unsigned: /<!--\s*opencourse:unsigned\s*-->/.test(r.body ?? ''),
      asset: asset ? { size: asset.size, downloads: asset.download_count } : null
    }
  } catch (error) { console.warn(`  GitHub release: ${error.message.includes('404') ? 'none published yet' : error.message}`) }
  if (result.repo || result.release) {
    mkdirSync(join(site, '.cache'), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(result))
  } else if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8'))
  }
  return result
}

/* ---------- catalog ---------- */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' }
async function featured() {
  const out = join(pub, 'featured')
  rmSync(out, { recursive: true, force: true })
  try {
    const page = await json(`${catalogUrl}/api/v1/courses?sort=downloads`, {}, 5000)
    const courses = (page.courses ?? []).slice(0, 6)
    mkdirSync(out, { recursive: true })
    for (const course of courses) {
      course.cover = null
      if (!course.hasCover) continue
      try {
        const response = await fetch(`${catalogUrl}/api/v1/courses/${encodeURIComponent(course.id)}/cover`, { signal: AbortSignal.timeout(5000) })
        const ext = EXT[(response.headers.get('content-type') ?? '').split(';')[0]]
        if (!response.ok || !ext) continue
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > 2 * 1024 * 1024) continue
        writeFileSync(join(out, `${course.id}.${ext}`), bytes)
        course.cover = `/featured/${course.id}.${ext}`
      } catch { /* no picture: the card draws one */ }
    }
    return courses.map(({ id, title, description, subject, difficulty, lessonCount, publisher, downloads, tags, cover }) =>
      ({ id, title, description: description ?? '', subject: subject ?? '', difficulty: difficulty ?? '', lessonCount, publisher, downloads, tags, cover }))
  } catch (error) {
    console.warn(`  Catalog at ${catalogUrl}: ${error.message}`)
    return []
  }
}

const [gh, courses] = await Promise.all([github(), featured()])
mkdirSync(join(site, 'src', 'data'), { recursive: true })
writeFileSync(join(site, 'src', 'data', 'generated.json'), JSON.stringify({ ...gh, featured: courses, builtAt: new Date().toISOString() }, null, 2))
console.log(`Site resources: ${gh.repo ? `${gh.repo.stars} stars` : 'no repository data'}, ${gh.release ? `release ${gh.release.version}` : 'no release'}, ${courses.length} catalog courses.`)
