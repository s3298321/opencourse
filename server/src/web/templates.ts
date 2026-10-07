/**
 * The web catalog's pages, as template literals.
 *
 * Read-only and script-free: every value is escaped through `esc`, a course's
 * description goes through markdown-it with raw HTML off, and the CSP the
 * routes send (`script-src` absent, so nothing runs) is the backstop for
 * anything this file gets wrong. Search is a GET form; nothing needs JS.
 */
import MarkdownIt from 'markdown-it'
import type { CatalogCourse, CatalogPage, CatalogTag, CourseOverview } from '@core/catalog/api'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('rel', 'nofollow ugc noopener noreferrer')
  return defaultLink(tokens, idx, options, env, self)
}

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export interface Site { name: string; description: string; publicUrl: string; registration: 'open' | 'closed' }

function layout(site: Site, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="/">${esc(site.name)}</a><span class="tagline">${esc(site.description)}</span></div></header>
<main class="wrap">
${body}
</main>
<footer class="wrap"><p>To learn a course, open the <strong>OpenCourse</strong> app, go to <strong>Settings → Servers</strong>, connect to <code>${esc(site.publicUrl)}</code>, then add it from the <strong>Course catalog</strong> tab.${site.registration === 'closed' ? ' This server is not accepting new accounts.' : ''}</p></footer>
</body>
</html>
`
}

function query(params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) for (const v of Array.isArray(value) ? value : value ? [value] : []) search.append(key, v)
  const text = search.toString()
  return text ? `?${text}` : ''
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`

function card(course: CatalogCourse): string {
  const meta = [course.subject, course.difficulty, plural(course.lessonCount, 'lesson'), course.projectCount ? plural(course.projectCount, 'project') : '', course.estimatedHours ? `~${course.estimatedHours}h` : ''].filter(Boolean)
  return `<li class="card">
  <a href="/courses/${esc(course.id)}">
    ${course.hasCover ? `<img src="/api/v1/courses/${esc(course.id)}/cover" alt="">` : '<div class="cover-blank" aria-hidden="true"></div>'}
    <div class="card-body">
      <h2>${esc(course.title)}</h2>
      <p class="meta">${meta.map(esc).join(' · ')}</p>
      ${course.description ? `<p class="summary">${esc(course.description.replace(/[#*_`>[\]()]/g, '').slice(0, 220))}</p>` : ''}
      <p class="stats"><span>v${esc(course.version)}</span><span>${plural(course.downloads, 'download')}</span><span>by ${esc(course.publisher)}</span></p>
      ${course.tags.length ? `<p class="tags">${course.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    </div>
  </a>
</li>`
}

export function catalogHtml(site: Site, page: CatalogPage, tags: CatalogTag[], params: { q: string; tags: string[]; sort: string }): string {
  const selected = new Set(params.tags.map((t) => t.toLowerCase()))
  const chips = tags.map((t) => {
    const on = selected.has(t.tag)
    const next = on ? params.tags.filter((x) => x.toLowerCase() !== t.tag) : [...params.tags, t.tag]
    return `<a class="chip${on ? ' on' : ''}" href="/${query({ q: params.q, tag: next, sort: params.sort })}"${on ? ' aria-current="true"' : ''}>${esc(t.tag)} <span>${t.count}</span></a>`
  }).join('')
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize))
  const nav = pages > 1 ? `<nav class="pager">${page.page > 1 ? `<a href="/${query({ q: params.q, tag: params.tags, sort: params.sort, page: String(page.page - 1) })}">← Previous</a>` : ''}<span>Page ${page.page} of ${pages}</span>${page.page < pages ? `<a href="/${query({ q: params.q, tag: params.tags, sort: params.sort, page: String(page.page + 1) })}">Next →</a>` : ''}</nav>` : ''
  const body = `
<form class="search" method="get" action="/" role="search">
  <input type="search" name="q" value="${esc(params.q)}" placeholder="Search courses" aria-label="Search courses">
  ${params.tags.map((t) => `<input type="hidden" name="tag" value="${esc(t)}">`).join('')}
  <select name="sort" aria-label="Sort">
    ${[['', 'Best match'], ['downloads', 'Most downloaded'], ['recent', 'Recently updated'], ['title', 'Title']].map(([v, l]) => `<option value="${v}"${params.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
  </select>
  <button type="submit">Search</button>
</form>
${chips ? `<div class="chips" aria-label="Filter by tag">${chips}</div>` : ''}
<p class="count">${page.total ? plural(page.total, 'course') : 'No courses match.'}${params.q || params.tags.length ? ` <a href="/">Clear</a>` : ''}</p>
<ul class="cards">${page.courses.map(card).join('')}</ul>
${nav}`
  return layout(site, site.name, body)
}

export function courseHtml(site: Site, course: CourseOverview): string {
  const meta = [course.subject, course.difficulty, course.estimatedHours ? `~${course.estimatedHours}h` : course.totalMinutes ? `~${Math.round(course.totalMinutes / 60)}h` : '', course.author ? `by ${course.author}` : ''].filter(Boolean)
  const counts = [plural(course.lessonCount, 'lesson'), course.projectCount ? plural(course.projectCount, 'project') : '', course.quizCount ? plural(course.quizCount, 'quiz', 'quizzes') : '', course.exerciseCount ? plural(course.exerciseCount, 'exercise') : '', course.flashcardCount ? plural(course.flashcardCount, 'flashcard') : ''].filter(Boolean)
  const versions = course.versions.filter((v) => v.status === 'current' || v.status === 'available')
  const body = `
<p class="back"><a href="/">← All courses</a></p>
<article class="course">
  ${course.hasCover ? `<img class="cover" src="/api/v1/courses/${esc(course.id)}/cover" alt="">` : ''}
  <h1>${esc(course.title)}</h1>
  <p class="meta">${meta.map(esc).join(' · ')}</p>
  <p class="stats"><span>Version ${esc(course.version)}</span><span>${plural(course.downloads, 'download')}</span><span>Published by ${esc(course.publisher)}</span><span>Updated ${esc(course.updatedAt.slice(0, 10))}</span></p>
  ${course.tags.length ? `<p class="tags">${course.tags.map((t) => `<a class="tag" href="/${query({ tag: t.toLowerCase() })}">${esc(t)}</a>`).join('')}</p>` : ''}
  ${course.description ? `<section class="prose">${md.render(course.description)}</section>` : ''}
  ${course.prerequisites.length ? `<section><h2>Before you start</h2><ul>${course.prerequisites.map((p) => `<li>${md.renderInline(p)}</li>`).join('')}</ul></section>` : ''}
  <section><h2>Contents</h2><p class="meta">${counts.map(esc).join(' · ')}</p>
  <ol class="outline">${course.outline.map((m) => `<li><strong>${esc(m.title)}</strong>${m.kind === 'project' ? ' <span class="badge">Project</span>' : ''}${m.lessons.length ? `<ol>${m.lessons.map((l) => `<li>${esc(l.title)}${l.minutes ? ` <span class="mins">${l.minutes} min</span>` : ''}</li>`).join('')}</ol>` : ''}</li>`).join('')}</ol></section>
  <section><h2>Versions</h2><ul class="versions">${versions.map((v) => `<li><strong>${esc(v.version)}</strong>${v.status === 'current' ? ' <span class="badge">Current</span>' : ''} <span class="meta">${esc(v.publishedAt.slice(0, 10))}</span>${v.releaseNote ? `<p>${esc(v.releaseNote).replace(/\n/g, '<br>')}</p>` : ''}</li>`).join('')}</ul></section>
</article>`
  return layout(site, `${course.title} · ${site.name}`, body)
}

export function notFoundHtml(site: Site): string {
  return layout(site, `Not found · ${site.name}`, '<h1>Not found</h1><p>That course is not on this server. <a href="/">Browse the catalog</a>.</p>')
}
