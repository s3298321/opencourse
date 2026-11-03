import type { PersonalCard } from '../core/personal-cards'
import { parsePersonalCard } from '../core/personal-cards'
import { deserializeCard } from '../core/review'
import { db } from './db'
import type { Binding } from './learning-store'
import type { LearningOperation } from '../core/learning/types'
import { cardOwner, personalCardEvents } from './personal-cards'
import { personalCard, putPersonalCard, setPersonalState } from './personal-card-store'

export function receivePersonalCard(server:string,account:string,raw:unknown): void {
  const card=parsePersonalCard(raw)
  if (card.state) deserializeCard(card.state)
  db().prepare('INSERT INTO personal_card_inbox(server_id,account_id,id,payload) VALUES(?,?,?,?) ON CONFLICT(server_id,account_id,id) DO UPDATE SET payload=excluded.payload')
    .run(server,account,card.id,JSON.stringify(card))
}
export function applyPersonalInbox(server:string,account:string): void {
  const pending=(db().prepare('SELECT payload FROM learning_outbox WHERE server_id=? AND account_id=? AND error IS NULL').all(server,account) as {payload:string}[]).map(r => JSON.parse(r.payload) as LearningOperation)
  let after=''
  for (;;) {
    const rows=db().prepare('SELECT id,payload FROM personal_card_inbox WHERE server_id=? AND account_id=? AND id>? ORDER BY id LIMIT 100').all(server,account,after) as {id:string;payload:string}[]
    for (const row of rows) {
      const card=JSON.parse(row.payload) as PersonalCard
      const b=db().prepare('SELECT * FROM learning_bindings WHERE server_id=? AND account_id=? AND kind=? AND remote_id=?').get(server,account,card.target.kind,card.target.id) as unknown as Binding | undefined
      if (!b) continue
      if (pending.some(op => op.kind===b.kind && op.id===b.remote_id && (op.field===`personalCard:${card.id}` || op.field===`personalReview:${card.id}`))) continue
      const target={kind:b.kind,id:b.local_id}, owner=cardOwner(b)
      putPersonalCard(db(),owner,{...card,target})
      if (!personalCard(db(),owner,target,card.id)?.deleted) setPersonalState(db(),owner,card.id,card.state)
      db().prepare('DELETE FROM personal_card_inbox WHERE server_id=? AND account_id=? AND id=?').run(server,account,row.id)
      personalCardEvents.emit('changed',b.local_id)
    }
    if (rows.length<100) break
    after=rows.at(-1)!.id
  }
}
