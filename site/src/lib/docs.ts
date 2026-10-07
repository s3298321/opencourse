/**
 * The documentation is the repository's own docs/ folder, read at build time.
 * Each top-level .md file becomes /docs/<name>. The files stay plain Markdown
 * with no front matter, so GitHub shows them exactly as well as this site does.
 *
 * Rendering is markdown-it - the library the app uses - with:
 *  - heading ids made by github-slugger, so an anchor written for GitHub
 *    (`#versions-and-server-identity`) works here too, plus a hover "#" link;
 *  - Prism for code: classes, not inline styles, which the CSP would refuse;
 *  - links rewritten: `./x.md` to `/docs/x`, anything else in the repo to its
 *    page on GitHub, so nothing points at a file the site does not serve;
 *  - tables wrapped so a wide one scrolls inside itself, not the page.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import GithubSlugger from 'github-slugger'
import Prism from 'prismjs'
import loadLanguages from 'prismjs/components/index.js'
import { SITE } from '../site.config'

loadLanguages(['json', 'bash', 'typescript', 'javascript', 'python', 'c', 'diff', 'yaml', 'markdown', 'toml', 'llvm'])

const DOCS_DIR = resolve(process.env.DOCS_DIR ?? join(process.cwd(), '..', 'docs'))

/** Order and grouping. A doc not listed here still appears, under Reference, by its title. */
export const DOC_GROUPS: { title: string; slugs: string[] }[] = [
  { title: 'Getting started', slugs: ['getting-started'] },
  { title: 'Reference', slugs: ['course-format', 'theme-format', 'server-api'] },
  { title: 'Servers', slugs: ['self-hosting'] }
]

/** How the navigation names each doc; a doc not listed here is named by its first heading. */
export const DOC_TITLES: Record<string, string> = {
  'getting-started': 'Getting started',
  'course-format': 'Course format',
  'theme-format': 'Theme format',
  'server-api': 'Server API',
  'self-hosting': 'Hosting a catalog'
}

/** Downloads offered beside the doc they belong to (scripts/build-resources.mjs makes them). */
export const DOC_RESOURCES: Record<string, { label: string; href: string; note: string }[]> = {
  'course-format': [
    { label: 'course-schema.json', href: '/downloads/course-schema.json', note: 'JSON Schema for course.json' },
    { label: 'opencourse-example-course.zip', href: '/downloads/opencourse-example-course.zip', note: 'Every block type, ready to import' }
  ],
  'theme-format': [
    { label: 'theme-schema.json', href: '/downloads/theme-schema.json', note: 'JSON Schema for theme.json' },
    { label: 'opencourse-default-theme.zip', href: '/downloads/opencourse-default-theme.zip', note: 'The app\'s own look, as a theme' },
    { label: 'opencourse-example-theme.zip', href: '/downloads/opencourse-example-theme.zip', note: 'Paper & Ink, with pictures and a font' }
  ]
}

export interface Heading { depth: number; text: string; id: string }
export interface Doc {
  slug: string
  file: string
  /** The doc's own first heading. */
  title: string
  /** What the navigation calls it. */
  navTitle: string
  description: string
  group: string
  html: string
  headings: Heading[]
  editUrl: string
}

const ALIASES: Record<string, string> = { jsonc: 'json', json5: 'json', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', ts: 'typescript', js: 'javascript', py: 'python', ll: 'llvm', yml: 'yaml', md: 'markdown' }
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function highlight(code: string, lang: string): string {
  const name = ALIASES[lang] ?? lang
  const grammar = name ? Prism.languages[name] : undefined
  const body = grammar ? Prism.highlight(code, grammar, name) : escapeHtml(code)
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
  return `<pre class="code language-${escapeHtml(name || 'text')}">${label}<code>${body}</code></pre>`
}

const plain = (s: string): string => s.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').trim()

function renderer(slugs: Set<string>, slugger: GithubSlugger, headings: Heading[]) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, highlight })

  // Headings: GitHub's ids, collected for the page's table of contents.
  md.core.ruler.push('heading_ids', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i]!
      if (open.type !== 'heading_open') continue
      const inline = tokens[i + 1]!
      const text = (inline.children ?? []).filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('')
      const id = slugger.slug(text)
      open.attrSet('id', id)
      headings.push({ depth: Number(open.tag.slice(1)), text, id })
    }
    return true
  })
  // The "#" link follows the heading's text, so an invisible one never indents it.
  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    const open = tokens[idx - 2]!
    const id = open.type === 'heading_open' ? open.attrGet('id') : null
    const anchor = Number(open.tag.slice(1)) > 1 && id ? `<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''
    return anchor + self.renderToken(tokens, idx, options)
  }

  // Links: other docs become pages here, everything else in the repo goes to GitHub.
  const linkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const href = String(token.attrGet('href') ?? '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      token.attrSet('rel', 'noopener noreferrer')
    } else if (href && !href.startsWith('#')) {
      const [path = '', hash = ''] = href.split('#')
      const target = posix.normalize(posix.join('docs', path))
      const doc = /^docs\/([^/]+)\.md$/.exec(target)?.[1]
      if (doc && slugs.has(doc)) token.attrSet('href', `/docs/${doc}${hash ? `#${hash}` : ''}`)
      else {
        token.attrSet('href', `${SITE.repoUrl}/${target.endsWith('/') || !target.includes('.') ? 'tree' : 'blob'}/${SITE.docsBranch}/${target}${hash ? `#${hash}` : ''}`)
        token.attrSet('rel', 'noopener noreferrer')
      }
    }
    return linkOpen(tokens, idx, options, env, self)
  }

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>'
  md.renderer.rules.table_close = () => '</table></div>'
  return md
}

let cache: Doc[] | null = null

export function loadDocs(): Doc[] {
  if (cache) return cache
  const files = readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md')).sort()
  const slugs = new Set(files.map((file) => file.replace(/\.md$/, '')))
  const groupOf = (slug: string): string => DOC_GROUPS.find((g) => g.slugs.includes(slug))?.title ?? 'Reference'
  const docs = files.map((file): Doc => {
    const slug = file.replace(/\.md$/, '')
    const source = readFileSync(join(DOCS_DIR, file), 'utf8')
    const headings: Heading[] = []
    const md = renderer(slugs, new GithubSlugger(), headings)
    const html = md.render(source)
    const title = plain(/^#\s+(.+)$/m.exec(source)?.[1] ?? slug)
    const paragraph = source.split(/\n\s*\n/).map((block) => block.trim()).find((block) => block && !/^[#|`>\-*\d]/.test(block)) ?? ''
    const navTitle = DOC_TITLES[slug] ?? (title.replace(/^OpenCourse\s+/, '').replace(/\s+[—-]\s+v[\d.]+$/, '').replace(/^./, (c) => c.toUpperCase()))
    return {
      slug, file, title, navTitle, group: groupOf(slug), html, headings,
      description: plain(paragraph.replace(/\s+/g, ' ')).slice(0, 220),
      editUrl: `${SITE.repoUrl}/edit/${SITE.docsBranch}/docs/${file}`
    }
  })
  const order = DOC_GROUPS.flatMap((g) => g.slugs)
  const rank = (slug: string): number => (order.includes(slug) ? order.indexOf(slug) : order.length)
  cache = docs.sort((a, b) => rank(a.slug) - rank(b.slug) || a.title.localeCompare(b.title))
  return cache
}

export function docGroups(): { title: string; docs: Doc[] }[] {
  const docs = loadDocs()
  const titles = [...new Set([...DOC_GROUPS.map((g) => g.title), ...docs.map((d) => d.group)])]
  return titles.map((title) => ({ title, docs: docs.filter((d) => d.group === title) })).filter((g) => g.docs.length)
}

/** Release notes and other short Markdown from outside the repo: no HTML, no ids. */
export function renderNotes(markdown: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, highlight })
  const linkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx]!.attrSet('rel', 'noopener noreferrer nofollow')
    return linkOpen(tokens, idx, options, env, self)
  }
  // The release workflow's unsigned notice sits between markers; the download
  // page shows its own, so it is dropped here rather than said twice.
  const notes = markdown.replace(/<!--\s*opencourse:unsigned\s*-->[\s\S]*?<!--\s*\/opencourse:unsigned\s*-->/g, '')
  return md.render(notes.replace(/<!--[\s\S]*?-->/g, ''))
}
