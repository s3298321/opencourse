import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ctx } from '../context'
import { catalogPage, courseOverview, tagCounts } from '../catalog/catalog'
import { asList } from '../catalog/routes'
import { catalogHtml, courseHtml, notFoundHtml, type Site } from './templates'
import { STYLE } from './style'

/** No script, no frames, nothing from elsewhere: the pages are documents. */
export const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').header('Content-Security-Policy', PAGE_CSP)
    .header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').send(body)
}

export function registerWebRoutes(app: FastifyInstance, ctx: Ctx): void {
  const site: Site = { name: ctx.config.name, description: ctx.config.description, publicUrl: ctx.config.publicUrl, registration: ctx.config.registration }

  app.get('/', async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const q = typeof query['q'] === 'string' ? query['q'].slice(0, 200) : ''
    const tags = asList(query['tag']).slice(0, 5)
    const sort = typeof query['sort'] === 'string' && ['downloads', 'recent', 'title'].includes(query['sort']) ? query['sort'] : ''
    const page = catalogPage(ctx.db, { q, tags, sort: (sort || undefined) as 'downloads' | 'recent' | 'title' | undefined, page: Number(query['page'] ?? 1) || 1 })
    return html(reply, catalogHtml(site, page, tagCounts(ctx.db), { q, tags, sort }))
  })

  // The web is anonymous: an owner's unlisted course is not shown here either.
  app.get('/courses/:id', async (request, reply) => {
    const course = courseOverview(ctx.db, (request.params as { id: string }).id, null)
    return course ? html(reply, courseHtml(site, course)) : html(reply, notFoundHtml(site), 404)
  })

  app.get('/static/style.css', async (_request, reply) => reply.type('text/css; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(STYLE))
}
