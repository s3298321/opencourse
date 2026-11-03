import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Ctx } from '../context'
import { requireAccount } from '../auth/routes'
import { badRequest, notFound } from '../errors'
import { cardsFor, personalCard, putPersonalCard, ratePersonal, setPersonalState, allCardsFor } from '../../../app/src/main/personal-card-store'
import type { LearningOperation } from '@core/learning/types'
import type { PersonalCard, ReviewTarget } from '@core/personal-cards'
import type { ReviewRating } from '@core/types'
import { change, enrollment, push, state } from './sync'
import { contentRecord } from './content'

export function publishPersonalCard(ctx: Ctx, account: string, card: PersonalCard): void {
  // One current snapshot per card also bootstraps a new device from cursor zero.
  ctx.db.prepare("DELETE FROM learning_changes WHERE account_id=? AND type='personalCard' AND key=?").run(account,card.id)
  change(ctx,account,'personalCard',card.id,card)
}
export function applyPersonalOperation(ctx: Ctx, account: string, op: LearningOperation): boolean {
  const target: ReviewTarget = { kind:op.kind,id:op.id }, id=op.field.split(':')[1], owner=account
  if (ctx.db.prepare('SELECT 1 FROM elements WHERE uid=?').get(id)) return false
  const card=personalCard(ctx.db,owner,target,id)
  if (op.field.startsWith('personalCard:')) {
    if (op.value === null) putPersonalCard(ctx.db,owner,{ id,target,question:'',answer:'',createdAt:new Date(op.at).toISOString(),deleted:true,version:0 })
    else {
      const value=op.value as {question:string;answer:string;createdAt?:string}
      putPersonalCard(ctx.db,owner,{ id,target,question:value.question,answer:value.answer,createdAt:new Date(op.at).toISOString(),deleted:false,version:0 })
    }
  } else {
    if (!card) return false
    ratePersonal(ctx.db,owner,card,op.value === null ? null : (op.value as {rating:ReviewRating}).rating,op.at,op.idempotencyKey,op.epoch,true)
  }
  publishPersonalCard(ctx,account,personalCard(ctx.db,owner,target,id)!)
  return true
}
export function resetPersonalReviews(ctx: Ctx, account: string, target: ReviewTarget): void {
  for (const card of allCardsFor(ctx.db,account,target)) {
    setPersonalState(ctx.db,account,card.id)
    publishPersonalCard(ctx,account,personalCard(ctx.db,account,target,card.id)!)
  }
}
export function personalCardRoutes(app: FastifyInstance, ctx: Ctx): void {
  const destination=(account:string,raw:unknown) => {
    const p=raw as ReviewTarget
    if (!p || !['course','document'].includes(p.kind) || typeof p.id!=='string') throw badRequest('invalid_content','Invalid destination.')
    const e=enrollment(ctx,account,p.kind,p.id)
    if (!e?.active) throw notFound()
    contentRecord(ctx,account,e)
    return e
  }
  app.get('/api/v1/me/learning/:kind/:id/personal-cards',async req => {
    const account=requireAccount(req).id, ref=destination(account,req.params)
    const query=req.query as {after?:string;download?:string}
    if (query.after && !/^[a-f0-9-]{36}$/.test(query.after)) throw badRequest('invalid_cursor','Invalid card cursor.')
    const page=cardsFor(ctx.db,account,ref,true,query.after ?? '',100)
    return { cards:page.map(c => query.download === '1' ? c : { ...c,answer:undefined }), nextCursor:page.length === 100 ? page.at(-1)!.id : null }
  })
  app.delete('/api/v1/me/learning/:kind/:id/personal-cards/:card',async req => {
    const account=requireAccount(req).id, ref=destination(account,req.params), id=(req.params as {card:string}).card
    if (!personalCard(ctx.db,account,ref,id)) throw notFound()
    const s=state(ctx,account,ref.kind,ref.id)
    const result=push(ctx,account,[{ ...ref,at:Date.now(),idempotencyKey:randomUUID(),generation:s.enrollment.generation,epoch:s.epoch,field:`personalCard:${id}`,value:null }])
    if (result.rejected.length) throw badRequest('delete_failed','Could not delete this card. Refresh and retry.')
    return {ok:true}
  })
}
