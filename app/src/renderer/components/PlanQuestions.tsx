import { useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './ActionButton'
import type { PlanQuestion, QuestionAnswer, QuestionAnswers, QuestionBatch, QuestionProgress, QuestionStep } from '@core/authoring/planning'

interface Props {
  batch: QuestionBatch
  pending: boolean
  disabled: boolean
  progress?: QuestionProgress
  saved?: QuestionAnswers
  advance: (step: QuestionStep) => Promise<QuestionProgress>
  submit: (response: QuestionAnswers, revision: number) => Promise<boolean>
}

function AnswerFields({ question, answer, update, pick }: {
  question: PlanQuestion; answer: QuestionAnswer
  update: (answer: QuestionAnswer) => void; pick: (answer: QuestionAnswer) => void
}) {
  if (question.kind === 'text') return <textarea rows={3} maxLength={2500}
    aria-label={question.prompt} placeholder="Your answer…" value={answer.text ?? ''}
    onChange={event => update({ id: question.id, text: event.target.value })} />

  const multi = question.kind === 'multiple'
  const options = question.options ?? []
  const selected = answer.selected ?? []
  const customSelected = !!answer.text?.trim()
  return <div className="plan-question-options">
    {options.map((option, index) => multi ? (
      <label className="plan-question-option" key={option.id} data-selected={selected.includes(option.id)}>
        <input type="checkbox" checked={selected.includes(option.id)} onChange={event => update({
          id: question.id, text: answer.text,
          selected: event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id)
        })} />
        <span className="plan-option-mark" aria-hidden="true" /><span>{option.label}</span>
      </label>
    ) : (
      <button type="button" className="plan-question-option" key={option.id} data-selected={selected.includes(option.id)}
        onClick={() => pick({ id: question.id, selected: [option.id] })}>
        <span className="plan-option-number">{index + 1}.</span><span>{option.label}</span>
      </button>
    ))}
    <label className="plan-question-option plan-custom-option" data-selected={customSelected}>
      {multi ? <span className="plan-option-mark" aria-hidden="true" /> :
        <span className="plan-option-number" aria-hidden="true">{options.length + 1}.</span>}
      <input className="plan-custom-input" type="text" aria-label="Your own answer" placeholder="Your own answer…"
        maxLength={2500} value={answer.text ?? ''}
        onChange={event => update({ id: question.id, text: event.target.value, selected: multi ? selected : [] })} />
    </label>
  </div>
}

function PreviousQuestionButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <button type="button" className="plan-question-back" aria-label="Previous question" title="Previous question"
    disabled={disabled} onClick={onClick}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m10 3-5 5 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
}

function SavedQuestions({ batch, saved }: Pick<Props, 'batch' | 'saved'>) {
  const [index, setIndex] = useState(0)
  const question = batch.questions[index]
  const answer = saved?.answers.find(a => a.id === question.id)
  const labels = question.options?.filter(o => answer?.selected?.includes(o.id)).map(o => o.label) ?? []
  const text = saved?.skip || answer?.skipped ? 'Skipped' : [...labels, answer?.text].filter(Boolean).join('; ') || 'Unanswered'
  return <details className="plan-questions plan-question-history">
    <summary>Planning questions <span>· {batch.questions.length}</span></summary>
    <div className="plan-question-page" key={question.id}>
      <p className="plan-question-position">Question {index + 1} of {batch.questions.length}</p>
      <p className="plan-question-prompt">{question.prompt}</p><p className="plan-saved-answer">{text}</p>
    </div>
    {batch.questions.length > 1 && <div className="plan-question-actions">
      <PreviousQuestionButton disabled={index === 0} onClick={() => setIndex(index - 1)} />
      <button type="button" className="action-button ghost" disabled={index === batch.questions.length - 1} onClick={() => setIndex(index + 1)}>Next<Icon name="chevronRight" /></button>
    </div>}
  </details>
}

function QuestionWizard({ batch, progress, disabled, advance, submit }: Props) {
  const [confirmed, setConfirmed] = useState(progress)
  const latest = (progress?.revision ?? 0) >= (confirmed?.revision ?? 0) ? progress : confirmed
  const revision = latest?.revision ?? 0
  const answers = latest?.answers ?? []
  const [position, setPosition] = useState<{ index: number; revision: number }>()
  const index = position?.revision === revision ? position.index : answers.length
  const question = batch.questions[index]
  const last = index === batch.questions.length - 1
  const [edits, setEdits] = useState<Record<string, QuestionAnswer>>({})
  const answer = edits[question.id] ?? answers[index] ?? { id: question.id }
  const canContinue = !!answer.text?.trim() || (question.kind === 'multiple' && !!answer.selected?.length)
  const page = useRef<HTMLFieldSetElement>(null)
  const moving = useRef(false)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const focusNext = useRef(false)
  useLayoutEffect(() => {
    if (focusNext.current) {
      page.current?.querySelector('legend')?.focus({ preventScroll: true })
      focusNext.current = false
    }
  }, [index])

  async function move(action: 'back' | 'answer' | 'skip', chosen = answer) {
    if (moving.current || disabled) return
    moving.current = true
    setChanging(true)
    setError('')
    let fade: Animation | undefined
    try {
      if (!(last && action !== 'back') && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        fade = page.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-out', fill: 'forwards' })
        await fade?.finished
      }
      if (action === 'back') {
        focusNext.current = true
        setPosition({ index: index - 1, revision })
        return
      }
      const choice: QuestionAnswer = action === 'skip' ? { id: question.id, skipped: true } : chosen
      if (last) {
        await submit({ batchId: batch.id, answers: [...answers, choice] }, revision)
        return
      }
      focusNext.current = true
      const next = await advance({ batchId: batch.id, revision, answer: choice })
      setConfirmed(next)
      setEdits(current => { const updated = { ...current }; delete updated[question.id]; return updated })
      setPosition({ index: index + 1, revision: next.revision })
    } catch (failure) {
      focusNext.current = false
      setError((failure as Error).message)
    } finally {
      fade?.cancel()
      moving.current = false
      setChanging(false)
    }
  }

  return <section className="plan-questions" aria-label="Course planning questions">
    <p className="plan-question-position" aria-live="polite">Question {index + 1} of {batch.questions.length}</p>
    <fieldset ref={page} key={question.id} className="plan-question-page" disabled={disabled || changing}>
      <legend className="plan-question-prompt" tabIndex={-1}>{question.prompt}</legend>
      {question.kind !== 'text' && <p className="plan-question-hint">{question.kind === 'multiple' ? 'Choose any that apply.' : 'Choose one.'}</p>}
      <AnswerFields question={question} answer={answer} update={value => setEdits(current => ({ ...current, [question.id]: value }))}
        pick={value => {
          setEdits(current => ({ ...current, [question.id]: value }))
          void move('answer', value)
        }} />
    </fieldset>
    <div className="plan-question-actions">
      {index > 0 && <PreviousQuestionButton disabled={disabled || changing} onClick={() => void move('back')} />}
      <button type="button" className="action-button ghost plan-question-skip" disabled={disabled || changing} onClick={() => void move('skip')}>Skip</button>
      <button type="button" className="action-button primary" disabled={disabled || changing || !canContinue} onClick={() => void move('answer')}>{last ? 'Send answers' : <>Next<Icon name="chevronRight" /></>}</button>
    </div>
    {error && <p role="alert" className="import-note error">{error}</p>}
  </section>
}

export default function PlanQuestions(props: Props) {
  return props.pending ? <QuestionWizard {...props} /> : <SavedQuestions batch={props.batch} saved={props.saved} />
}
