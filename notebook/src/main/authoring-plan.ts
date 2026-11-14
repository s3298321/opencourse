import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './db'
import { dataRoot, userDir } from './paths'
import { requireUser } from './users'
import { assertOwnedProjectAncestors } from './projectfiles'
import { isChatId } from '../core/sidechat/ids'
import type { AuthoringCourse } from '../core/course-document'
import type { PlanBinding, PlanQuestion, PlanningState, PlanningMessage, QuestionAnswer, QuestionAnswers, QuestionBatch, QuestionStep } from '../core/authoring/planning'
const MAX_PLAN = 80_000
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
// Draft version numbers restart when an editor session is discarded. Two
// different drafts at the same saved revision can therefore have the same number.
export const planSourceHash = (course: AuthoringCourse) => digest(JSON.stringify([course.draft.manifest, course.document.attachments]))
export function planDirectory(id: string): string {
  if (!isChatId(id)) throw new Error('Invalid plan chat.')
  const dir = join(userDir(requireUser()), 'authoring-plans', id)
  assertOwnedProjectAncestors(dataRoot(), dir)
  return dir
}
export function planningState(id: string): PlanningState {
  const row = db().prepare('SELECT payload FROM authoring_plans WHERE chat_id=?').get(id) as { payload: string } | undefined
  return row ? JSON.parse(row.payload) : { status: 'discussing', revision: 0 }
}
export function setPlanningState(id: string, state: PlanningState): void {
  db().prepare('INSERT INTO authoring_plans VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(state))
}
export function discuss(id: string): void { const s = planningState(id); setPlanningState(id, { ...s, status: 'discussing', questions: undefined }) }
function storeFile(id: string, state: PlanningState, text: string): PlanningState {
  if (!text.trim() || text.length > MAX_PLAN) throw new Error(`The plan must be between 1 and ${MAX_PLAN} characters.`)
  const dir = planDirectory(id), revision = state.revision + 1, hash = digest(text)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${randomUUID()}.tmp`), name = `${revision}-${hash}.md`
  try { writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); renameSync(tmp, join(dir, name)) } finally { rmSync(tmp, { force: true }) }
  const next: PlanningState = { ...state, revision, hash, status: 'discussing', questions: undefined }
  setPlanningState(id, next)
  // Commit the pointer only after the new file exists. A crash can leave an orphan,
  // never a half-written revision. The next successful write removes orphans.
  for (const f of readdirSync(dir)) if (f !== name && /\.(md|tmp)$/.test(f)) rmSync(join(dir, f), { force: true })
  return next
}
export function readPlan(id: string, state = planningState(id)): string {
  if (!state.revision) return ''
  const dir = planDirectory(id)
  const path = Number.isSafeInteger(state.revision) && /^[0-9a-f]{64}$/.test(state.hash ?? '') ? join(dir, `${state.revision}-${state.hash}.md`) : null
  const stat = path && existsSync(path) ? lstatSync(path) : null
  const text = path && stat?.isFile() && stat.size <= MAX_PLAN * 4 ? readFileSync(path, 'utf8') : null
  if (text !== null && digest(text) === state.hash) return text
  // Never approve damaged storage. Restore the last printed copy as an unpublished
  // revision, or allow a fresh working file if none has ever been presented.
  if (state.published) storeFile(id, state, state.published.text)
  else setPlanningState(id, { status: 'discussing', revision: 0 })
  throw new Error('The working plan was missing or damaged. Read the recovered plan and present it again.')
}
function bounded(x: unknown, max: number): x is string { return typeof x === 'string' && x.trim().length > 0 && x.length <= max }
function distinct(items: string[]): boolean { return new Set(items).size === items.length }
export function questionBatch(raw: unknown): QuestionBatch {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3) throw new Error('Ask 1–3 questions at a time.')
  const questions: PlanQuestion[] = raw.map(q => {
    if (!q || !bounded(q.id, 80) || !bounded(q.prompt, 1500) || !['text','single','multiple'].includes(q.kind)) throw new Error('Invalid planning question.')
    if (q.kind === 'text') return { id: q.id, prompt: q.prompt, kind: 'text' }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 12 || q.options.some((o: {id?: unknown; label?: unknown}) => !o || !bounded(o.id, 80) || !bounded(o.label, 500)) || !distinct(q.options.map((o: {id: string}) => o.id))) throw new Error('Give each choice a unique ID and label.')
    return { id: q.id, prompt: q.prompt, kind: q.kind, options: q.options.map((o: {id: string; label: string}) => ({ id: o.id, label: o.label })) }
  })
  if (!distinct(questions.map(q => q.id))) throw new Error('Question IDs must be unique within a batch.')
  return { id: randomUUID(), questions }
}
function formatAnswer(q: PlanQuestion, answer: QuestionAnswer): string {
  if (!answer || answer.id !== q.id) throw new Error('Choose an answer for this question.')
  if (answer.skipped === true && Object.keys(answer).every(k => k === 'id' || k === 'skipped')) {
    return q.prompt + '\nSkipped. Use your judgment and state the assumption in the plan.'
  }
  const selected = answer.selected ?? []
  const text = answer.text?.trim() ?? ''
  if (Object.keys(answer).some(k => !['id','selected','text'].includes(k)) ||
      !Array.isArray(selected) || selected.length > 12 || !distinct(selected) ||
      selected.some(id => !q.options?.some(o => o.id === id)) ||
      (q.kind === 'single' && selected.length + Number(!!text) > 1) ||
      text.length > 2500 || (!text && !selected.length)) {
    throw new Error(`Check the answer to “${q.prompt}”.`)
  }
  const labels = selected.map(id => q.options!.find(o => o.id === id)!.label)
  return q.prompt + '\n' + [...labels, text].filter(Boolean).join('; ')
}

function pendingBatch(state: PlanningState, batchId: string, revision: number) {
  const batch = state.questions
  if (state.status !== 'awaiting-answers' || !batch || batch.id !== batchId) throw new Error('Those questions are no longer pending.')
  if (revision !== (batch.progress?.revision ?? 0)) throw new Error('These answers changed in another window. Review the current question.')
  return batch
}

export function saveQuestionStep(id: string, step: QuestionStep) {
  const state = planningState(id)
  const batch = pendingBatch(state, step.batchId, step.revision)
  const index = batch.questions.findIndex(q => q.id === step.answer?.id)
  const answers = [...(batch.progress?.answers ?? [])]
  if (index < 0 || index > answers.length || index >= batch.questions.length - 1) throw new Error('Choose a pending question before continuing.')
  formatAnswer(batch.questions[index], step.answer)
  answers[index] = step.answer
  const progress = { revision: step.revision + 1, answers }
  setPlanningState(id, { ...state, questions: { ...batch, progress } })
  return progress
}

export function partialQuestionAnswers(state: PlanningState) {
  const batch = state.questions
  if (!batch?.progress?.answers.length) return
  const answers = batch.progress.answers
  return { response: { batchId: batch.id, answers }, text: answers.map((a, i) => formatAnswer(batch.questions[i], a)).join('\n\n') }
}

export function answerText(state: PlanningState, response: QuestionAnswers, revision = 0): string {
  const batch = pendingBatch(state, response?.batchId, revision)
  if (!Array.isArray(response.answers) || response.answers.length > 3 || Object.keys(response).some(k => !['batchId','skip','answers'].includes(k)) ||
    (response.skip !== undefined && typeof response.skip !== 'boolean') || (response.skip && response.answers.length)) throw new Error('Invalid planning response.')
  if (response.skip === true) return 'Skip these questions. Use your judgment and state the assumptions in the plan.'
  if (response.answers.length !== batch.questions.length) throw new Error('Answer or skip each question.')
  return batch.questions.map(q => formatAnswer(q, response.answers.find(a => a?.id === q.id)!)).join('\n\n')
}
/** Planning owns its own writes; never route an unknown tool to the course writer. */
export function runPlanTool(id: string, name: string, raw: unknown, binding: PlanBinding,
  present: (message: PlanningMessage) => void): string {
  try {
    const args = raw as Record<string, unknown>, s = planningState(id)
    if (name === 'read_plan') return JSON.stringify({ revision: s.revision, text: readPlan(id, s) })
    if (name === 'ask_questions') { present({ questions: questionBatch(args.questions) }); return '{"waitingForUser":true}' }
    if (name === 'present_plan') {
      if (!s.revision || args.revision !== s.revision) throw new Error('Read the current plan before presenting it.')
      present({ plan: { text: readPlan(id, s), revision: s.revision, hash: s.hash!, decisionId: randomUUID(), ...binding } }); return '{"waitingForUser":true}'
    }
    let text: string
    if (name === 'create_plan') {
      if (s.revision || typeof args.text !== 'string') throw new Error('Create only the initial plan. Read and patch an existing plan.')
      text = args.text
    } else if (name === 'patch_plan') {
      if (!s.revision || args.revision !== s.revision || !Array.isArray(args.edits) || !args.edits.length || args.edits.length > 30) throw new Error('Read the latest plan and supply targeted edits.')
      text = readPlan(id, s)
      for (const edit of args.edits) {
        if (!bounded(edit?.oldText, MAX_PLAN) || typeof edit.newText !== 'string' || edit.newText.length > MAX_PLAN) throw new Error('Invalid plan patch.')
        const pos = text.indexOf(edit.oldText)
        if (pos < 0 || text.indexOf(edit.oldText, pos + 1) >= 0) throw new Error('The patch must match exactly once. Read the plan and try again.')
        text = text.slice(0, pos) + edit.newText + text.slice(pos + edit.oldText.length)
      }
    } else throw new Error('This tool is unavailable in Plan mode.')
    const next = storeFile(id, s, text); return JSON.stringify({ revision: next.revision, hash: next.hash })
  } catch (error) { return JSON.stringify({ ok: false, error: (error as Error).message }) }
}
