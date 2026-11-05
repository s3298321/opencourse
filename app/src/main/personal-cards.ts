import { EventEmitter } from 'node:events'
import { db, tx } from './db'
import { anyBinding, enqueue, type Binding } from './learning-store'
import { serverAccess } from './servers'
import { getCourse } from './courses'
import { getDocument } from './documents'
import { getWritingNotebook } from './writing-notebooks'
import { requireUser } from './users'
import { FLASHCARD_TOOL, PERSONAL_CARD_CAPABILITY, reviewTarget, validateFlashcards, type ReviewTarget } from '../core/personal-cards'
import { allCardsFor, getProposal, personalCard, proposeCards, proposalsFor, putPersonalCard, resolveProposal } from './personal-card-store'

export const personalCardEvents = new EventEmitter()
export const cardOwner = (b: Binding | null): string => b ? `${b.server_id}:${b.account_id}` : ''
export function targetTitle(raw: ReviewTarget): string {
  requireUser()
  const target = reviewTarget(raw)
  if (target.kind === 'document') return getDocument(target.id).title
  const course = getCourse(target.id)
  if (!course) throw new Error('This course is no longer available.')
  return course.title
}
export function personalCardAvailability(target: ReviewTarget): string | null {
  targetTitle(target)
  const b = anyBinding(target.id)
  if (!b) return null
  if (!JSON.parse(b.state).enrollment.active) return 'Add this content to My learning again to manage personal flashcards.'
  const access = serverAccess(b.connection_id)
  if (access.account?.id !== b.account_id) return 'Sign in to the account that owns this content to create personal flashcards.'
  if (!access.capabilities?.includes(PERSONAL_CARD_CAPABILITY)) return 'This server needs personal flashcard support before cards can be created.'
  return null
}
export function targetForChat(scope: string, chatId: string): ReviewTarget | null {
  if (scope === 'chat' || scope === 'project') {
    const row = db().prepare(`SELECT course_slug FROM ${scope === 'chat' ? 'chats' : 'course_project_chats'} WHERE id=?`).get(chatId)
    if (!row) throw new Error('This chat no longer exists.')
    return { kind: 'course', id: String(row.course_slug) }
  }
  if (scope === 'document') {
    const row = db().prepare('SELECT document_id FROM document_chats WHERE id=?').get(chatId)
    if (!row) throw new Error('This chat no longer exists.')
    return { kind: 'document', id: String(row.document_id) }
  }
  if (scope === 'writing-notebook') {
    const row = db().prepare('SELECT notebook_id FROM writing_notebook_chats WHERE id=?').get(chatId)
    if (!row) throw new Error('This chat no longer exists.')
    const association = getWritingNotebook(String(row.notebook_id)).association
    return association && association.kind !== 'coach' ? { kind: association.kind, id: association.id } : null
  }
  return null
}
export function flashcardTools(scope: string, chatId: string): readonly typeof FLASHCARD_TOOL[] {
  try { const target = targetForChat(scope,chatId); return target && !personalCardAvailability(target) ? [FLASHCARD_TOOL] : [] } catch { return [] }
}
export function flashcardToolNotice(scope: string, chatId: string): string {
  try { const target = targetForChat(scope,chatId); return target ? personalCardAvailability(target) ?? '' : 'Personal flashcards require a notebook linked to a course or document.' } catch { return 'The associated source is unavailable; personal flashcards cannot be created.' }
}
export function createFlashcardPreview(scope: string, chatId: string, turn: number, callId: string, args: unknown): string {
  const target = targetForChat(scope,chatId)
  if (!target) throw new Error('Link this notebook to a course or document before creating flashcards.')
  const unavailable = personalCardAvailability(target)
  if (unavailable) throw new Error(unavailable)
  const proposal = tx(d => proposeCards(d,'',scope,chatId,String(turn),callId,target,targetTitle(target),validateFlashcards(args),cardOwner(anyBinding(target.id))))
  personalCardEvents.emit('changed',target.id)
  return JSON.stringify({ proposalId:proposal.id,status:proposal.status,count:proposal.cards.length })
}
export function listFlashcardProposals(chatId: string) {
  requireUser()
  for (const scope of ['chat','document','project','writing-notebook']) {
    try { targetForChat(scope,chatId); return proposalsFor(db(),'',scope,chatId) } catch { /* Look in the next chat table. */ }
  }
  return []
}
export function decideFlashcardProposal(id: string, action: 'save' | 'dismiss', cardId?: string) {
  if (!['save','dismiss'].includes(action)) throw new Error('Invalid preview action.')
  requireUser()
  const proposal = getProposal(db(),'',id)
  const row = db().prepare('SELECT chat_scope,chat_id,association FROM flashcard_proposals WHERE owner=? AND id=?').get('',id)!
  const current = targetForChat(String(row.chat_scope),String(row.chat_id))
  if (action === 'save' && proposal.status === 'pending') {
    if (JSON.stringify(current) !== JSON.stringify(proposal.target) || row.association !== cardOwner(anyBinding(proposal.target.id))) throw new Error('The notebook association or account changed. Ask for a new flashcard preview.')
    const unavailable = personalCardAvailability(proposal.target)
    if (unavailable) throw new Error(unavailable)
  }
  const result = tx(d => resolveProposal(d,'',id,action,card => {
    const b = anyBinding(card.target.id)
    putPersonalCard(d,cardOwner(b),card)
    if (b) enqueue(b,`personalCard:${card.id}`,{ question:card.question,answer:card.answer,createdAt:card.createdAt })
  },cardId))
  personalCardEvents.emit('changed',proposal.target.id)
  return result
}
export function listPersonalCards(target: ReviewTarget) {
  targetTitle(target)
  return allCardsFor(db(),cardOwner(anyBinding(target.id)),target).map(({ id,question }) => ({ id,question }))
}
export function deletePersonalCard(target: ReviewTarget, id: string): void {
  targetTitle(target)
  const b = anyBinding(target.id), owner = cardOwner(b)
  if (b) { const unavailable = personalCardAvailability(target); if (unavailable) throw new Error(unavailable) }
  tx(d => {
    const card = personalCard(d,owner,target,id)
    if (!card) throw new Error('This personal card is no longer available.')
    if (card.deleted) return
    putPersonalCard(d,owner,{ ...card,deleted:true })
    if (b) enqueue(b,`personalCard:${id}`,null)
  })
  personalCardEvents.emit('changed',target.id)
}
