/** Electron-free persistence, shared by desktop and server. Call writes inside the caller's transaction. */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { FlashcardProposal, PersonalCard, PersonalCardDraft, ReviewTarget } from '../core/personal-cards'
import { deserializeCard, scheduleCard, serializeCard, type StoredCard } from '../core/review'
import type { ReviewRating } from '../core/types'

export const PERSONAL_CARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS personal_cards (
 owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('course','document')),
 content_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, created_at TEXT NOT NULL,
 source TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,id)
);
CREATE INDEX IF NOT EXISTS personal_cards_content ON personal_cards(owner,kind,content_id,created_at,id);
CREATE TABLE IF NOT EXISTS personal_card_states (
 owner TEXT NOT NULL, card_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
 PRIMARY KEY(owner,card_id), FOREIGN KEY(owner,card_id) REFERENCES personal_cards(owner,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_card_reviews (
 owner TEXT NOT NULL, card_id TEXT NOT NULL, operation TEXT NOT NULL, rating TEXT, at REAL NOT NULL,
 epoch TEXT NOT NULL, log TEXT, PRIMARY KEY(owner,operation),
 FOREIGN KEY(owner,card_id) REFERENCES personal_cards(owner,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS personal_reviews_card ON personal_card_reviews(owner,card_id,epoch,at,operation);
CREATE TABLE IF NOT EXISTS flashcard_proposals (
 owner TEXT NOT NULL, id TEXT NOT NULL, chat_scope TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 call_id TEXT NOT NULL, signature TEXT NOT NULL, kind TEXT NOT NULL, content_id TEXT NOT NULL, title TEXT NOT NULL,
 cards TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', association TEXT,
 PRIMARY KEY(owner,id), UNIQUE(owner,chat_scope,chat_id,turn_id,call_id)
);
CREATE INDEX IF NOT EXISTS flashcard_proposals_chat ON flashcard_proposals(owner,chat_scope,chat_id,turn_id);
`
export function cardsFor(d: DatabaseSync, owner: string, target: ReviewTarget, includeDeleted = false, after = '', limit = 500): PersonalCard[] {
  const rows = d.prepare(`SELECT c.*,s.state,s.version FROM personal_cards c LEFT JOIN personal_card_states s ON s.owner=c.owner AND s.card_id=c.id
    WHERE c.owner=? AND c.kind=? AND c.content_id=? AND (? OR c.deleted=0) AND c.id>? ORDER BY c.id LIMIT ?`).all(owner, target.kind, target.id, Number(includeDeleted), after, limit)
  return rows.map(row => ({ id: String(row.id), target, question: String(row.question), answer: String(row.answer),
    createdAt: String(row.created_at), source: row.source ? String(row.source) : undefined, deleted: !!row.deleted,
    state: row.state ? JSON.parse(String(row.state)) as StoredCard : undefined, version: Number(row.version ?? 0) }))
}
export function allCardsFor(d: DatabaseSync, owner: string, target: ReviewTarget): PersonalCard[] {
  const cards: PersonalCard[] = []
  let after = ''
  for (;;) { const page = cardsFor(d, owner, target, false, after); cards.push(...page); if (page.length < 500) break; after = page.at(-1)!.id }
  return cards.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}
export function personalCard(d: DatabaseSync, owner: string, target: ReviewTarget, id: string): PersonalCard | null {
  const row = d.prepare('SELECT id FROM personal_cards WHERE owner=? AND kind=? AND content_id=? AND id=?').get(owner, target.kind, target.id, id)
  if (!row) return null
  const r = d.prepare(`SELECT c.*,s.state,s.version FROM personal_cards c LEFT JOIN personal_card_states s ON s.owner=c.owner AND s.card_id=c.id WHERE c.owner=? AND c.id=?`).get(owner,id)!
  return { id, target, question: String(r.question), answer: String(r.answer), createdAt: String(r.created_at), source: r.source ? String(r.source) : undefined,
    deleted: !!r.deleted, state: r.state ? JSON.parse(String(r.state)) : undefined, version: Number(r.version ?? 0) }
}
export function putPersonalCard(d: DatabaseSync, owner: string, card: PersonalCard): void {
  const existing = d.prepare('SELECT kind,content_id,deleted FROM personal_cards WHERE owner=? AND id=?').get(owner,card.id)
  if (existing && (existing.kind !== card.target.kind || existing.content_id !== card.target.id)) throw new Error('This card belongs to another destination.')
  if (existing?.deleted) return
  d.prepare(`INSERT OR IGNORE INTO personal_cards(owner,id,kind,content_id,question,answer,created_at,source,deleted) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(owner,card.id,card.target.kind,card.target.id,card.deleted ? '' : card.question,card.deleted ? '' : card.answer,card.createdAt,card.source ?? null,Number(card.deleted))
  if (card.deleted) {
    d.prepare("UPDATE personal_cards SET deleted=1,question='',answer='',source=NULL WHERE owner=? AND id=?").run(owner,card.id)
    d.prepare('DELETE FROM personal_card_reviews WHERE owner=? AND card_id=?').run(owner,card.id)
    d.prepare('DELETE FROM personal_card_states WHERE owner=? AND card_id=?').run(owner,card.id)
  }
}
export function setPersonalState(d: DatabaseSync, owner: string, id: string, state?: StoredCard): void {
  // Keep a version even after a reset, so an active session cannot accept stale ratings.
  if (!state && !d.prepare('SELECT 1 FROM personal_card_states WHERE owner=? AND card_id=?').get(owner,id)) return
  const serialized = JSON.stringify(state ?? null)
  d.prepare(`INSERT INTO personal_card_states(owner,card_id,state,version) VALUES(?,?,?,1)
    ON CONFLICT(owner,card_id) DO UPDATE SET state=excluded.state,version=personal_card_states.version+1 WHERE state<>excluded.state`).run(owner,id,serialized)
}
export function ratePersonal(d: DatabaseSync, owner: string, card: PersonalCard, rating: ReviewRating | null, at: number, operation: string, epoch = '', rebuild = false): void {
  if (card.deleted) return
  const inserted = d.prepare('INSERT OR IGNORE INTO personal_card_reviews(owner,card_id,operation,rating,at,epoch) VALUES(?,?,?,?,?,?)').run(owner,card.id,operation,rating,at,epoch)
  if (!inserted.changes) return
  let state = card.state ? deserializeCard(card.state) : undefined
  if (rebuild) {
    state = undefined
    const events = d.prepare('SELECT rating,at FROM personal_card_reviews WHERE owner=? AND card_id=? AND epoch=? ORDER BY at,operation').all(owner,card.id,epoch)
    for (const event of events) state = event.rating === null ? undefined : scheduleCard(state,event.rating as ReviewRating,new Date(Number(event.at))).card
  } else {
    const result = rating === null ? undefined : scheduleCard(state,rating,new Date(at))
    state = result?.card
    d.prepare('UPDATE personal_card_reviews SET log=? WHERE owner=? AND operation=?').run(JSON.stringify(result?.log ?? null),owner,operation)
  }
  setPersonalState(d,owner,card.id,state ? serializeCard(state) : undefined)
}
function proposalRow(row: Record<string, unknown>): FlashcardProposal {
  return { id: String(row.id), target: { kind: row.kind as ReviewTarget['kind'], id: String(row.content_id) }, title: String(row.title), cards: JSON.parse(String(row.cards)), status: row.status as FlashcardProposal['status'] }
}
export function proposalsFor(d: DatabaseSync, owner: string, scope: string, chat: string, turn?: string): FlashcardProposal[] {
  return d.prepare(`SELECT * FROM flashcard_proposals WHERE owner=? AND chat_scope=? AND chat_id=?${turn === undefined ? '' : ' AND turn_id=?'} ORDER BY rowid`).all(...(turn === undefined ? [owner,scope,chat] : [owner,scope,chat,turn])).map(proposalRow)
}
export function getProposal(d: DatabaseSync, owner: string, id: string): FlashcardProposal {
  const row = d.prepare('SELECT * FROM flashcard_proposals WHERE owner=? AND id=?').get(owner,id)
  if (!row) throw new Error('This flashcard preview is no longer available.')
  return proposalRow(row)
}
export function proposeCards(d: DatabaseSync, owner: string, scope: string, chat: string, turn: string, call: string, target: ReviewTarget, title: string, cards: PersonalCardDraft[], association?: string): FlashcardProposal {
  const signature = JSON.stringify({ target,cards })
  const prior = d.prepare('SELECT * FROM flashcard_proposals WHERE owner=? AND chat_scope=? AND chat_id=? AND turn_id=? AND call_id=?').get(owner,scope,chat,turn,call)
  if (prior) { if (prior.signature !== signature) throw new Error('Conflicting flashcard tool call.'); return proposalRow(prior) }
  const id = randomUUID()
  d.prepare(`INSERT INTO flashcard_proposals(owner,id,chat_scope,chat_id,turn_id,call_id,signature,kind,content_id,title,cards,association) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(owner,id,scope,chat,turn,call,signature,target.kind,target.id,title,JSON.stringify(cards.map(c => ({ ...c,id:randomUUID() }))),association ?? null)
  return getProposal(d,owner,id)
}
export function resolveProposal(d: DatabaseSync, owner: string, id: string, action: 'save' | 'dismiss', created: (card: PersonalCard) => void, cardId?: string): FlashcardProposal {
  const proposal = getProposal(d,owner,id)
  if (cardId !== undefined && (typeof cardId !== 'string' || !proposal.cards.some(card => card.id === cardId))) throw new Error('This card does not belong to the preview.')
  if (proposal.status !== 'pending') return proposal
  const cards = proposal.cards.map(draft => {
    if (draft.decision || (cardId !== undefined && draft.id !== cardId)) return draft
    if (action === 'save') {
      const card: PersonalCard = { id:draft.id,question:draft.question,answer:draft.answer,target:proposal.target,createdAt:new Date().toISOString(),deleted:false,version:0 }
      created(card)
    }
    return { ...draft,decision:action === 'save' ? 'saved' as const : 'dismissed' as const }
  })
  const status = cards.some(card => !card.decision) ? 'pending' : cards.some(card => card.decision === 'saved') ? 'saved' : 'dismissed'
  d.prepare('UPDATE flashcard_proposals SET cards=?,status=? WHERE owner=? AND id=?').run(JSON.stringify(cards),status,owner,id)
  return getProposal(d,owner,id)
}

export function attachCardProposals(d: DatabaseSync, scope: string, chat: string, messages: import('../core/types').ChatMessage[]): import('../core/types').ChatMessage[] {
  const rows=d.prepare('SELECT * FROM flashcard_proposals WHERE owner=? AND chat_scope=? AND chat_id=? ORDER BY rowid').all('',scope,chat)
  return messages.map(message => {
    const proposals=rows.filter(r => String(r.turn_id)===String(message.seq)).map(proposalRow)
    return proposals.length ? {...message,flashcardProposals:proposals} : message
  })
}
