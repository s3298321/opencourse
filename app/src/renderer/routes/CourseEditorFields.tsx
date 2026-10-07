import { createContext, useContext, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { newDraftRef } from '@core/course-document'
import { DEFAULT_COURSE_VERSION, isVersion } from '@core/catalog/semver'
import type { Attachment } from '@core/course-document'
import { availableBlockSlug } from '@core/block-slugs'
import type { Block, CourseManifest, ExtraFile, ProjectDefinition, QuizBlock, RuntimeSpec } from '@core/types'
import { getToolchain, TOOLCHAIN_IDS } from '@core/toolchains'
import type { OutlineElement } from '@core/course-editor'
import CodeEditor from '../workbench/CodeEditor'
import { useWorkbenchTheme } from '../workbench/theme'

const uuid = newDraftRef
const Validation = createContext<{ path: string; errors: string[] }>({ path: '', errors: [] })
const Attachments = createContext<Attachment[]>([])
export const EditorAttachments = Attachments.Provider
export const EditorValidation = Validation.Provider
function Scope({ path, children }: { path: string; children: ReactNode }): JSX.Element {
  const parent = useContext(Validation)
  return <Validation.Provider value={{ ...parent, path: `${parent.path}/${path}` }}>{children}</Validation.Provider>
}

function Field({ label, name, children, className = '' }: { label: string; name: string; children: ReactNode; className?: string }): JSX.Element {
  const { errors, path } = useContext(Validation)
  const found = errors.filter((e) => e.startsWith(`${path}/${name}:`) || e.startsWith(`${path}/${name}/`))
  return <div className={`author-field ${className}${found.length ? ' invalid' : ''}`}><span className="author-label">{label}</span>{children}{found.map((e) => <p className="error" key={e}>{e.slice(e.indexOf(':') + 1)}</p>)}</div>
}
export function TextField({ label, name, value, onChange, multiline = false }: { label: string; name: string; value?: string; onChange: (value: string) => void; multiline?: boolean }): JSX.Element {
  return <Field label={label} name={name}>{multiline ? <textarea aria-label={label} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /> : <input aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}</Field>
}
function NumberField({ label, name, value, onChange }: { label: string; name: string; value?: number; onChange: (value: number | undefined) => void }): JSX.Element {
  return <Field label={label} name={name}><input aria-label={label} type="number" min={0} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></Field>
}
function Lines({ label, name, value, onChange }: { label: string; name: string; value?: string[]; onChange: (value: string[] | undefined) => void }): JSX.Element {
  return <TextField label={`${label} (one per line)`} name={name} multiline value={value?.join('\n')} onChange={(v) => onChange(v ? v.split('\n') : undefined)} />
}
function Markdown({ label, name, value, onChange }: { label: string; name: string; value?: string; onChange: (value: string) => void }): JSX.Element {
  return <Field label={label} name={name} className="author-markdown-field"><textarea className="author-markdown" aria-label={label} rows={9} value={value ?? ''} onChange={(e) => onChange(e.target.value)} /></Field>
}
function Source({ label, name, value, language, docKey, onChange }: { label: string; name: string; value?: string; language: string; docKey: string; onChange: (value: string) => void }): JSX.Element {
  const theme = useWorkbenchTheme()
  return <Field label={label} name={name}><div className="author-code"><CodeEditor docKey={docKey} language={language} indentUnit={getToolchain(TOOLCHAIN_IDS.includes(language) ? language : undefined).indentUnit} initialDoc={value ?? ''} value={value ?? ''} theme={theme} onChange={onChange} onSave={() => { document.dispatchEvent(new Event('authoring:save')) }} onRun={() => {}} /></div></Field>
}
function Runtime({ value, onChange }: { value?: RuntimeSpec; onChange: (v: RuntimeSpec | undefined) => void }): JSX.Element {
  const set = (fields: Partial<RuntimeSpec>): void => onChange({ ...value, ...fields })
  return <Scope path="runtime"><details className="author-section"><summary>Runtime settings</summary>
    <Field label="Language" name="language"><select aria-label="Language" value={value?.language ?? ''} onChange={(e) => set({ language: e.target.value || undefined })}><option value="">Use default</option>{TOOLCHAIN_IDS.map((id) => <option key={id} value={id}>{getToolchain(id).label}</option>)}</select></Field>
    <TextField label="Minimum tool version" name="version" value={value?.version} onChange={(v) => set({ version: v || undefined })} />
    <Lines label="Packages / libraries" name="packages" value={value?.packages} onChange={(packages) => set({ packages })} />
    <Lines label="Compiler flags" name="flags" value={value?.flags} onChange={(flags) => set({ flags })} />
    <button className="ghost" onClick={() => onChange(undefined)}>Clear runtime override</button>
  </details></Scope>
}
function Files({ files, onChange, language, name }: { files?: ExtraFile[]; onChange: (files: ExtraFile[]) => void; language: string; name: string }): JSX.Element {
  const entries = files ?? []
  const update = (index: number, fields: Partial<ExtraFile>): void => onChange(entries.map((f, i) => i === index ? { ...f, ...fields } : f))
  return <details className="author-section"><summary>{name === 'extra_files' ? 'Support files' : 'Project starter files'} ({entries.length})</summary>{entries.map((file, i) => <Scope key={file.nodeId} path={`${name}/${i}`}><div className="author-list-item">
    <TextField label="Relative file path" name="path" value={file.path} onChange={(path) => update(i, { path })} />
    <Source label="File content" name="content" language={language} docKey={file.nodeId!} value={file.content} onChange={(content) => update(i, { content })} />
    <button className="ghost" onClick={() => onChange(entries.filter((_, index) => index !== i))}>Delete file</button>
  </div></Scope>)}<button className="secondary" onClick={() => onChange([...entries, { nodeId: uuid(), path: 'support.txt', content: '' }])}>Add file</button></details>
}
function AttachmentField({ courseId, name, value, kind, onChange }: { courseId: string; name: string; value?: string; kind: 'image' | 'video' | 'visualization'; onChange: (v: string) => void }): JSX.Element {
  const [state, setState] = useState<{ busy: boolean; entries: string[]; error: string }>({ busy: false, entries: [], error: '' })
  const attachments = useContext(Attachments)
  const known = attachments.find((a) => a.files.includes(value ?? ''))
  const entries = (known?.files ?? state.entries).filter((entry) => /\.html?$/i.test(entry))
  const upload = async (folder: boolean): Promise<void> => {
    setState({ busy: true, entries: [], error: '' })
    try {
      const result = await window.opencourse.uploadCourseAttachment(courseId, kind, folder)
      if (result) { onChange(result.attachment.entry); setState({ busy: false, entries: result.htmlEntries, error: '' }) }
      else setState({ busy: false, entries: [], error: '' })
    } catch (err) { setState({ busy: false, entries: [], error: (err as Error).message }) }
  }
  return <Field label={name === 'cover_image' ? 'Cover image' : name === 'poster' ? 'Video poster' : 'Attachment'} name={name}>
    <span className="attachment-current">{value || 'No attachment selected'}</span>
    <span className="actions"><button type="button" className="secondary" disabled={state.busy} onClick={() => void upload(false)}>{value ? 'Replace attachment…' : 'Upload attachment…'}</button>{kind === 'visualization' && <button type="button" className="secondary" disabled={state.busy} onClick={() => void upload(true)}>Upload folder…</button>}{value && <button className="ghost" onClick={() => onChange('')}>Clear</button>}</span>
    {kind === 'visualization' && value && entries.length > 1 && <select aria-label="HTML entry point" value={value} onChange={(e) => onChange(e.target.value)}>{entries.map((entry) => <option key={entry}>{entry}</option>)}</select>}
    {state.error && <span className="error" role="alert">{state.error}</span>}
  </Field>
}

function QuizFields({ quiz, set }: { quiz: QuizBlock; set: (fields: Partial<QuizBlock>) => void }): JSX.Element {
  const options = quiz.options ?? []
  return <>
    <TextField label="Archive ID" name="id" value={quiz.id} onChange={(id) => set({ id })} />
    <Field label="Quiz kind" name="kind"><select aria-label="Quiz kind" value={quiz.kind} onChange={(e) => set({ kind: e.target.value as QuizBlock['kind'], ...(e.target.value === 'text' ? { options: undefined, answers: [''] } : { answers: undefined, options: [true, false].map((correct, index) => ({ nodeId: uuid(), id: `option-${index + 1}`, text: '', correct })) }) })}><option value="single">Single choice</option><option value="multiple">Multiple choice</option><option value="text">Text answer</option></select></Field>
    <Markdown label="Question" name="question" value={quiz.question} onChange={(question) => set({ question })} />
    {quiz.kind === 'text' ? <Lines label="Accepted answers" name="answers" value={quiz.answers} onChange={(answers) => set({ answers })} /> : <Field label="Answer options" name="options">
      {options.map((option, i) => <Scope key={option.nodeId} path={`options/${i}`}><div className="author-list-item"><TextField label={`Option ${i + 1} archive ID`} name="id" value={option.id} onChange={(id) => set({ options: options.map((o, index) => index === i ? { ...o, id } : o) })} /><span className="quiz-option-editor">
        <input aria-label={`Option ${i + 1}`} value={option.text} onChange={(e) => set({ options: options.map((o, index) => index === i ? { ...o, text: e.target.value } : o) })} />
        <label className="correct-option"><input type="checkbox" checked={option.correct} onChange={(e) => set({ options: options.map((o, index) => ({ ...o, correct: index === i ? e.target.checked : quiz.kind === 'single' && e.target.checked ? false : o.correct })) })} />Correct</label>
        <button className="ghost" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => { const next = [...options]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; set({ options: next }) }}>↑</button>
        <button className="ghost" aria-label={`Delete option ${i + 1}`} onClick={() => set({ options: options.filter((_, index) => index !== i) })}>×</button>
      </span></div></Scope>)}<button className="secondary" onClick={() => set({ options: [...options, { nodeId: uuid(), id: availableBlockSlug('option', options.map(o => o.id)), text: '', correct: false }] })}>Add option</button>
    </Field>}
    <Markdown label="Explanation" name="explanation" value={quiz.explanation} onChange={(explanation) => set({ explanation })} />
  </>
}

function ProjectFields({ project, set, language }: { project: ProjectDefinition; set: (fields: Partial<ProjectDefinition>) => void; language: string }): JSX.Element {
  return <Scope path="project">
    <Markdown label="Project definition" name="definition" value={project.definition} onChange={(definition) => set({ definition })} />
    <Lines label="Project objectives" name="objectives" value={project.objectives} onChange={(objectives) => set({ objectives })} />
    <NumberField label="Estimated project minutes" name="estimated_minutes" value={project.estimated_minutes} onChange={(estimated_minutes) => set({ estimated_minutes })} />
    <details className="author-section" open><summary>Requirements</summary>{project.requirements.map((item, i) => <Scope key={item.nodeId} path={`requirements/${i}`}><div className="author-list-item">
      <TextField label="Requirement archive ID" name="id" value={item.id} onChange={(id) => set({ requirements: project.requirements.map((r, index) => index === i ? { ...r, id } : r) })} />
      <Markdown label="Requirement" name="description" value={item.description} onChange={(description) => set({ requirements: project.requirements.map((r, index) => index === i ? { ...r, description } : r) })} />
      <button className="ghost" onClick={() => set({ requirements: project.requirements.filter((_, index) => index !== i) })}>Delete requirement</button>
    </div></Scope>)}<button className="secondary" onClick={() => set({ requirements: [...project.requirements, { nodeId: uuid(), id: availableBlockSlug('requirement', project.requirements.map(r => r.id)), description: '' }] })}>Add requirement</button></details>
    <details className="author-section" open><summary>Deliverables</summary>{project.deliverables.map((item, i) => {
      const update = (fields: Partial<typeof item>): void => set({ deliverables: project.deliverables.map((d, index) => index === i ? { ...d, ...fields } : d) })
      return <Scope key={item.nodeId} path={`deliverables/${i}`}><div className="author-list-item">
        <TextField label="Deliverable archive ID" name="id" value={item.id} onChange={(id) => update({ id })} />
        <TextField label="Deliverable title" name="title" value={item.title} onChange={(title) => update({ title })} />
        <Markdown label="Deliverable description" name="description" value={item.description} onChange={(description) => update({ description })} />
        <Lines label="Paths" name="paths" value={item.paths} onChange={(paths) => update({ paths })} />
        <Lines label="Acceptance criteria" name="acceptance_criteria" value={item.acceptance_criteria} onChange={(acceptance_criteria) => update({ acceptance_criteria: acceptance_criteria ?? [] })} />
        <button className="ghost" onClick={() => set({ deliverables: project.deliverables.filter((_, index) => index !== i) })}>Delete deliverable</button>
      </div></Scope>
    })}<button className="secondary" onClick={() => set({ deliverables: [...project.deliverables, { nodeId: uuid(), id: availableBlockSlug('deliverable', project.deliverables.map(d => d.id)), title: '', description: '', acceptance_criteria: [''] }] })}>Add deliverable</button></details>
    <Files name="starter_files" files={project.starter_files} language={language} onChange={(starter_files) => set({ starter_files })} />
  </Scope>
}

/**
 * The course's own version. Checked as you type, because the rule is short and
 * a save that fails on it is a poor way to learn it; a save's own error for the
 * same field is shown instead when there is one, so it never says it twice.
 */
function VersionField({ value, onChange, hint }: { value?: string; onChange: (value: string) => void; hint?: string }): JSX.Element {
  const { errors, path } = useContext(Validation)
  const reported = errors.some((e) => e.startsWith(`${path}/version:`))
  return <Field label="Version" name="version">
    <input aria-label="Course version" value={value ?? ''} placeholder={DEFAULT_COURSE_VERSION} onChange={(e) => onChange(e.target.value.trim())} />
    {!reported && !isVersion(value ?? '') && <p className="error">Use three numbers, MAJOR.MINOR.PATCH, such as 1.2.0</p>}
    {hint && <p className="meta">{hint}</p>}
  </Field>
}

export function CourseFields({ manifest, set, courseId, versionHint }: { manifest: CourseManifest; set: (fields: Partial<CourseManifest>) => void; courseId: string; versionHint?: string }): JSX.Element {
  return <>
    <h2>Course details</h2>
    <TextField label="Course title" name="title" value={manifest.title} onChange={(title) => set({ title })} />
    <TextField label="Course slug" name="slug" value={manifest.slug} onChange={(slug) => set({ slug })} />
    <VersionField value={manifest.version ?? DEFAULT_COURSE_VERSION} hint={versionHint} onChange={(version) => set({ version })} />
    <Markdown label="Description" name="description" value={manifest.description} onChange={(description) => set({ description })} />
    <TextField label="Author" name="author" value={manifest.author} onChange={(author) => set({ author })} />
    <TextField label="Subject" name="subject" value={manifest.subject} onChange={(subject) => set({ subject: subject || undefined })} />
    <Field label="Difficulty" name="difficulty"><select aria-label="Difficulty" value={manifest.difficulty ?? 'beginner'} onChange={(e) => set({ difficulty: e.target.value as CourseManifest['difficulty'] })}>{['beginner', 'intermediate', 'advanced'].map((v) => <option key={v}>{v}</option>)}</select></Field>
    <NumberField label="Estimated hours" name="estimated_hours" value={manifest.estimated_hours} onChange={(estimated_hours) => set({ estimated_hours })} />
    <Lines label="Prerequisites" name="prerequisites" value={manifest.prerequisites} onChange={(prerequisites) => set({ prerequisites })} />
    <Lines label="Tags" name="tags" value={manifest.tags} onChange={(tags) => set({ tags })} />
    <AttachmentField courseId={courseId} name="cover_image" value={manifest.cover_image} kind="image" onChange={(cover_image) => set({ cover_image: cover_image || undefined })} />
    <Runtime value={manifest.runtime} onChange={(runtime) => set({ runtime })} />
    {manifest.python_version !== undefined && <TextField label="Legacy Python version" name="python_version" value={manifest.python_version} onChange={(python_version) => set({ python_version: python_version || undefined })} />}
  </>
}

export function ElementFields({ element, manifest, courseId, set }: { element: OutlineElement; manifest: CourseManifest; courseId: string; set: (fields: Record<string, unknown>) => void }): JSX.Element {
  const language = 'runtime' in element && element.runtime?.language || manifest.runtime?.language || 'python'
  if ('answer' in element) return <>
    <h2>Flashcard</h2>
    <p className="meta">Cover only this lesson or material introduced earlier in the course. Keep each card focused on one idea.</p>
    <TextField label="Card archive ID" name="id" value={element.id} onChange={id => set({ id })} />
    <Markdown label="Question" name="question" value={element.question} onChange={question => set({ question })} />
    <Markdown label="Answer" name="answer" value={element.answer} onChange={answer => set({ answer })} />
    <Scope path="image"><AttachmentField courseId={courseId} name="src" kind="image" value={element.image?.src} onChange={src => set({ image: src ? { ...element.image, src } : undefined })} />
      {element.image && <TextField label="Image alt text" name="alt" value={element.image.alt} onChange={alt => set({ image: { ...element.image, alt } })} />}
    </Scope>
  </>
  if ('lessons' in element || ('project' in element && element.type === 'project')) return <>
    <h2>{element.type === 'project' ? 'Project module' : 'Lesson module'}</h2>
    <TextField label="Module title" name="title" value={element.title} onChange={(title) => set({ title })} />
    <TextField label="Module slug" name="slug" value={element.slug} onChange={(slug) => set({ slug })} />
    {element.type === 'project' && <ProjectFields project={element.project} language={language} set={(fields) => set({ project: { ...element.project, ...fields } })} />}
  </>
  if ('blocks' in element) return <>
    <h2>Lesson details</h2>
    <TextField label="Lesson title" name="title" value={element.title} onChange={(title) => set({ title })} />
    <TextField label="Lesson slug" name="slug" value={element.slug} onChange={(slug) => set({ slug })} />
    <Lines label="Objectives" name="objectives" value={element.objectives} onChange={(objectives) => set({ objectives })} />
    <NumberField label="Estimated minutes" name="estimated_minutes" value={element.estimated_minutes} onChange={(estimated_minutes) => set({ estimated_minutes })} />
  </>
  const block = element as Block
  return <><h2>{block.type === 'markdown' ? 'Lesson text' : block.type.charAt(0).toUpperCase() + block.type.slice(1)}</h2>
    <TextField label="Block slug" name="slug" value={block.slug} onChange={(slug) => set({ slug })} />
    {block.type === 'markdown' && <Markdown label="Markdown content" name="content" value={block.content} onChange={(content) => set({ content })} />}
    {(block.type === 'image' || block.type === 'video' || block.type === 'visualization') && <AttachmentField courseId={courseId} name="src" kind={block.type} value={block.src} onChange={(src) => set({ src })} />}
    {block.type === 'image' && <TextField label="Alt text" name="alt" value={block.alt} onChange={(alt) => set({ alt })} />}
    {(block.type === 'image' || block.type === 'video') && <TextField label="Caption" name="caption" value={block.caption} onChange={(caption) => set({ caption })} />}
    {block.type === 'video' && <AttachmentField courseId={courseId} name="poster" kind="image" value={block.poster} onChange={(poster) => set({ poster: poster || undefined })} />}
    {block.type === 'visualization' && <><TextField label="Visualization title" name="title" value={block.title} onChange={(title) => set({ title })} /><NumberField label="Height" name="height" value={block.height} onChange={(height) => set({ height })} /></>}
    {block.type === 'quiz' && <QuizFields quiz={block} set={set} />}
    {block.type === 'exercise' && <>
      <TextField label="Archive ID" name="id" value={block.id} onChange={(id) => set({ id })} />
      <TextField label="Exercise title" name="title" value={block.title} onChange={(title) => set({ title })} />
      <TextField label="Prompt" name="prompt" multiline value={block.prompt} onChange={(prompt) => set({ prompt })} />
      <Runtime value={block.runtime} onChange={(runtime) => set({ runtime })} />
      <Source label="Starter code" name="starter_code" language={language} docKey={`${block.nodeId}/starter`} value={block.starter_code} onChange={(starter_code) => set({ starter_code })} />
      <Source label="Solution" name="solution" language={language} docKey={`${block.nodeId}/solution`} value={block.solution} onChange={(solution) => set({ solution: solution || undefined })} />
      <Source label="Tests" name="tests" language={language} docKey={`${block.nodeId}/tests`} value={block.tests} onChange={(tests) => set({ tests: tests || undefined })} />
      <TextField label="Test command" name="test_command" value={block.test_command} onChange={(test_command) => set({ test_command: test_command || undefined })} />
      <TextField label="Expected output" name="expected_output" multiline value={block.expected_output} onChange={(expected_output) => set({ expected_output })} />
      <TextField label="Standard input" name="stdin" multiline value={block.stdin} onChange={(stdin) => set({ stdin })} />
      <Field label="Output matching" name="match"><select aria-label="Output matching" value={block.match ?? 'trimmed'} onChange={(e) => set({ match: e.target.value })}>{['trimmed', 'exact', 'lines'].map((v) => <option key={v}>{v}</option>)}</select></Field>
      <TextField label="Verification instructions" name="verification_instructions" multiline value={block.verification_instructions} onChange={(verification_instructions) => set({ verification_instructions })} />
      <Lines label="Hints" name="hints" value={block.hints} onChange={(hints) => set({ hints })} />
      {block.packages && <Lines label="Legacy packages" name="packages" value={block.packages} onChange={(packages) => set({ packages })} />}
      <Files name="extra_files" files={block.extra_files} language={language} onChange={(extra_files) => set({ extra_files })} />
    </>}
  </>
}
