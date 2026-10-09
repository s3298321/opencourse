// Checks the built site the way a visitor - and its CSP - would meet it.
// Fails (exit 1) when:
//  - a file in ../docs produced no page;
//  - a link inside the site points at a page, a file or an #anchor that does not exist;
//  - a page carries an inline script or style the CSP would refuse
//    (JSON-LD data blocks are not scripts, and are allowed);
//  - the download button points anywhere but the release permalink or /download;
//  - a download the docs offer is missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const site = resolve(import.meta.dirname, '..')
const dist = join(site, 'dist')
const problems = []
const PERMALINK = 'https://github.com/s3298321/opencourse/releases/latest/download/OpenCourse-mac-arm64.dmg'

const html = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? (name === 'pagefind' || name === '_astro' ? [] : html(path)) : name.endsWith('.html') ? [path] : []
})
const pages = new Map(html(dist).map((file) => [file, readFileSync(file, 'utf8')]))
const pageFor = (pathname) => {
  const clean = decodeURIComponent(pathname.split('?')[0]).replace(/\/$/, '')
  for (const candidate of [join(dist, clean, 'index.html'), join(dist, `${clean}.html`), join(dist, clean)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}
const ids = (text) => new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

for (const doc of readdirSync(join(site, '..', 'docs')).filter((f) => f.endsWith('.md'))) {
  if (!pageFor(`/docs/${doc.replace(/\.md$/, '')}`)) problems.push(`docs/${doc} has no page`)
}

for (const [file, text] of pages) {
  const where = file.slice(dist.length)
  for (const tag of text.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\bsrc=/.test(tag) && !/type="application\/ld\+json"/.test(tag)) problems.push(`${where}: inline script ${tag}`)
  }
  if (/<style\b/.test(text)) problems.push(`${where}: inline <style>`)
  if (/\sstyle="/.test(text)) problems.push(`${where}: style attribute`)
  for (const [, href] of text.matchAll(/\shref="([^"]+)"/g)) {
    if (/^(https?:|mailto:)/.test(href)) {
      if (href.includes('/releases/latest/download/') && href !== PERMALINK) problems.push(`${where}: download link ${href}`)
      continue
    }
    const [path, hash] = href.split('#')
    const target = path ? pageFor(path) : file
    if (!target) { problems.push(`${where}: broken link ${href}`); continue }
    if (hash && target.endsWith('.html') && !ids(pages.get(target) ?? readFileSync(target, 'utf8')).has(decodeURIComponent(hash))) problems.push(`${where}: missing anchor ${href}`)
  }
  for (const [, href] of text.matchAll(/<a[^>]*data-download[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*data-download/g)) {
    if (href && href !== PERMALINK && href !== '/download') problems.push(`${where}: download button points at ${href}`)
  }
}

for (const file of ['course-schema.json', 'theme-schema.json', 'opencourse-example-course.zip', 'opencourse-default-theme.zip', 'opencourse-example-theme.zip']) {
  if (!existsSync(join(dist, 'downloads', file))) problems.push(`downloads/${file} is missing`)
}
if (!existsSync(join(dist, 'pagefind', 'pagefind.js'))) problems.push('pagefind/ is missing: build with `npm run build`, which indexes the docs')

if (problems.length) {
  console.error(`verify-dist: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`verify-dist: ${pages.size} pages, every link and anchor resolves, no inline script or style.`)
