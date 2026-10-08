/**
 * The web app: one HTML shell for every page in shared/pages.ts, the built
 * assets beside it, and the two files crawlers ask for.
 *
 * The app's JavaScript talks to the same /api/v1 the desktop app does; this
 * file only decides what the first response says - status, title, link
 * previews and the boot data (shell.ts) - so a shared link previews properly
 * and the first paint needs no round trip.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PAGES, SOURCE_URL, matchPage, type Page } from '../../shared/pages'
import type { Boot, BootData, BootServer } from '../../shared/boot'
import type { Ctx } from '../context'
import { accountDetails } from '../auth/routes'
import { catalogPage, courseOverview, listedCourses, tagCounts } from '../catalog/catalog'
import { catalogQuery } from '../catalog/routes'
import { SERVER_VERSION } from '../version'
import { NO_WEB_APP, esc, renderShell, type ShellMeta } from './shell'

/** Script and style from this origin only, never inline; nothing framed, nothing posted elsewhere. */
export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'"
].join('; ')

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** A description's markdown reduced to its words, for a link preview. */
export function plainSummary(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}(#{1,6}|>)\s?/gm, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim()
}

export function securityHeaders(reply: FastifyReply): FastifyReply {
  return reply.header('Content-Security-Policy', PAGE_CSP).header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'strict-origin-when-cross-origin').header('X-Frame-Options', 'DENY')
    .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
}

export interface Shell {
  /** Answers with the page for this request; `status` overrides what the page would say. */
  send(request: FastifyRequest, reply: FastifyReply, status?: number): FastifyReply
}

export function createShell(ctx: Ctx): Shell {
  const { config, db: d } = ctx
  const template = config.webDir ? readFileSync(join(config.webDir, 'index.html'), 'utf8') : NO_WEB_APP
  const server: BootServer = {
    opencourse: 1, api: 1, name: config.name, description: config.description, registration: config.registration,
    version: SERVER_VERSION, publicUrl: config.publicUrl, appUrl: config.appUrl, sourceUrl: SOURCE_URL,
    privacyUrl: config.privacyUrl, legalUrl: config.legalUrl
  }
  const mark = `${config.publicUrl}/mark-512.png`

  const describe = (request: FastifyRequest, page: Page | null, params: Record<string, string>): { status: number; meta: ShellMeta; data: BootData | null } => {
    const url = new URL(request.url, 'http://x')
    const canonical = `${config.publicUrl}${url.pathname}${url.search}`
    const base: ShellMeta = { title: config.name, description: config.description, canonical, image: mark, index: false, type: 'website', siteName: config.name }
    if (!page) return { status: 404, meta: { ...base, title: `Not found · ${config.name}` }, data: null }
    if (page.key === 'catalog') {
      const query = catalogQuery(request.query as Record<string, unknown>)
      const data: BootData = { kind: 'catalog', page: catalogPage(d, query), tags: tagCounts(d) }
      // Only the plain catalog is indexed; a search is a view of it.
      const plain = !query.q && !query.tags.length && !query.sort && query.page === 1
      return { status: 200, meta: { ...base, index: plain, canonical: plain ? `${config.publicUrl}/` : canonical }, data }
    }
    if (page.key === 'course') {
      const course = courseOverview(d, params['id'] ?? '', null)
      if (!course) return { status: 404, meta: { ...base, title: `Not found · ${config.name}` }, data: null }
      const cover = course.hasCover ? d.prepare('SELECT cover_type FROM course_versions WHERE course_id = ? AND version = ?').get(course.id, course.version) as { cover_type: string | null } | undefined : undefined
      // Link previews do not draw SVG; those courses preview with the mark.
      const image = cover?.cover_type && cover.cover_type !== 'image/svg+xml' ? `${config.publicUrl}/api/v1/courses/${encodeURIComponent(course.id)}/cover` : mark
      const summary = plainSummary(course.description ?? `${course.lessonCount} lessons on ${config.name}.`)
      return {
        status: 200,
        meta: { ...base, title: `${course.title} · ${config.name}`, description: summary, image, index: true, type: 'article', canonical: `${config.publicUrl}/courses/${encodeURIComponent(course.id)}` },
        data: { kind: 'course', course }
      }
    }
    return { status: 200, meta: { ...base, title: `${page.title} · ${config.name}` }, data: null }
  }

  return {
    send(request, reply, status) {
      const url = new URL(request.url, 'http://x')
      const match = matchPage(url.pathname)
      const described = describe(request, match?.page ?? null, match?.params ?? {})
      const boot: Boot = {
        server,
        account: request.account ? accountDetails(d, request.account.id) : null,
        page: described.data ? { path: url.pathname, search: url.search, data: described.data } : null
      }
      const meta = status && status >= 500 ? { ...described.meta, title: `Something went wrong · ${config.name}`, index: false } : described.meta
      return securityHeaders(reply.code(status ?? described.status).type('text/html; charset=utf-8'))
        .header('Cache-Control', 'no-store').header('Vary', 'Cookie')
        .send(renderShell(template, meta, boot))
    }
  }
}

export function registerWebRoutes(app: FastifyInstance, ctx: Ctx, shell: Shell): void {
  const { config, db: d } = ctx

  for (const page of PAGES) app.get(page.path, async (request, reply) => shell.send(request, reply))

  if (config.webDir) {
    // Built files only; the shell itself is never served raw. Hashed files are
    // forever; the brand pictures for a day. A missing file falls through to
    // the app's not-found handler, which answers with the shell and a 404.
    void app.register(fastifyStatic, {
      root: config.webDir, prefix: '/', index: false, wildcard: true, serveDotFiles: false,
      allowedPath: (path) => path !== '/index.html',
      setHeaders: (res, path) => {
        res.header('Cache-Control', /[/\\]assets[/\\]/.test(path) ? IMMUTABLE : 'public, max-age=86400')
        res.header('X-Content-Type-Options', 'nosniff')
      }
    })
  }

  app.get('/robots.txt', async (_request, reply) => reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send([
    'User-agent: *',
    ...new Set(PAGES.filter((page) => !page.index).map((page) => `Disallow: ${page.path.replace(/\/:[^/]+.*$/, '/')}`)),
    'Disallow: /api/',
    '',
    `Sitemap: ${config.publicUrl}/sitemap.xml`,
    ''
  ].join('\n')))

  app.get('/sitemap.xml', async (_request, reply) => {
    const urls = [
      `<url><loc>${esc(`${config.publicUrl}/`)}</loc></url>`,
      ...listedCourses(d).map((course) => `<url><loc>${esc(`${config.publicUrl}/courses/${encodeURIComponent(course.id)}`)}</loc><lastmod>${esc(course.updatedAt.slice(0, 10))}</lastmod></url>`)
    ]
    return reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=600')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`)
  })
}
