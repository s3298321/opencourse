import { useEffect, useId, useState } from 'react'
import type { JSX } from 'react'
import type { Block, CourseManifest, ExerciseBlock, Flashcard, Lesson, ProjectDefinition } from '@core/types'
import { assetUrl } from '@core/manifest'
import { getToolchain, hasToolchain } from '@core/toolchains'
import Html from '../components/Html'
import LessonHeader from '../components/LessonHeader'
import MarkdownBlock from '../blocks/Markdown'
import { ImageBlockView, VideoBlockView } from '../blocks/Media'
import Visualization from '../blocks/Visualization'
import QuizBlockView from '../blocks/Quiz'
import ExerciseBlockView from '../blocks/Exercise'
import CodeEditor from '../workbench/CodeEditor'
import { useWorkbenchTheme } from '../workbench/theme'

export interface PreviewEditing {
  language?: string
  editable?: boolean
  locked?: boolean
  onEdit?: () => void
  onChange?: (ref: string, fields: Partial<ExerciseBlock>) => void
}

function useAuthoringAsset(courseId: string, path?: string): string | undefined {
  const [resolved, setResolved] = useState<{ path: string; url: string }>()
  useEffect(() => {
    let alive = true
    if (path) void window.opencourse.resolveAuthoringAsset(courseId, path).then((url) => { if (alive) setResolved({ path, url }) }).catch(() => {})
    return () => { alive = false }
  }, [courseId, path])
  return path ? resolved?.path === path ? resolved.url : assetUrl(courseId, path) : undefined
}

export function CourseCoverPreview({ courseId, path }: { courseId: string; path?: string }): JSX.Element | null {
  const url = useAuthoringAsset(courseId, path)
  return url ? <img className="author-cover" src={url} alt="Course cover" /> : null
}

function PresetFiles({ block, language, editable = false, locked = false, onEdit, onChange }: PreviewEditing & { block: ExerciseBlock }): JSX.Element {
  const group = useId()
  const theme = useWorkbenchTheme()
  const requested = block.runtime?.language ?? language
  const toolchain = getToolchain(requested && hasToolchain(requested) ? requested : undefined)
  const files = [
    { key: 'starter', path: toolchain.layout.learnerFile, kind: 'Starter code', content: block.starter_code ?? toolchain.layout.emptyStarter, fields: (content: string): Partial<ExerciseBlock> => ({ starter_code: content }) },
    ...(block.extra_files ?? []).map((file, index) => ({ key: `support/${file.nodeId ?? index}`, path: file.path, kind: 'Support file', content: file.content, fields: (content: string): Partial<ExerciseBlock> => ({ extra_files: block.extra_files!.map((entry, i) => i === index ? { ...entry, content } : entry) }) })),
    ...(block.tests !== undefined ? [{ key: 'tests', path: toolchain.layout.testFile, kind: 'Tests', content: block.tests, fields: (content: string): Partial<ExerciseBlock> => ({ tests: content }) }] : []),
    ...(block.solution !== undefined ? [{ key: 'solution', path: toolchain.layout.solutionFile, kind: 'Reference solution', content: block.solution, fields: (content: string): Partial<ExerciseBlock> => ({ solution: content }) }] : [])
  ]
  const [active, setActive] = useState('starter')
  const [editing, setEditing] = useState(false)
  const file = files.find(entry => entry.key === active) ?? files[0]
  const fileLanguage = file.key.startsWith('support/')
    ? /\.py$/i.test(file.path) ? 'python' : /\.(c|h|cpp|hpp)$/i.test(file.path) ? 'cpp' : /\.ll$/i.test(file.path) ? 'llvm-ir' : 'text'
    : toolchain.id
  const readOnly = !editing || !editable || locked
  return <div className="author-preset-files">
    <div className="author-preset-header" data-ask="none">
      <strong>Preset files</strong>
      {onChange && <button className="ghost" disabled={locked} onClick={() => {
        if (editing && editable) setEditing(false)
        else { onEdit?.(); setEditing(true) }
      }}>{editing && editable ? 'Done editing' : 'Edit file'}</button>}
    </div>
    <div className="author-preset-tabs" role="tablist" aria-label="Exercise preset files" data-ask="none">
      {files.map((entry, index) => <button key={entry.key} id={`${group}-tab-${index}`} role="tab" aria-selected={file.key === entry.key} aria-controls={`${group}-buffer`} className={file.key === entry.key ? 'active' : ''} title={`${entry.kind}: ${entry.path}`} onClick={() => setActive(entry.key)}>{entry.path}</button>)}
    </div>
    <div className="author-preset-meta meta" data-ask="none">{file.kind}{readOnly ? '' : ' · Editing course draft'}</div>
    <div className="author-code" role="tabpanel" id={`${group}-buffer`} aria-labelledby={`${group}-tab-${files.indexOf(file)}`} data-ask={readOnly ? undefined : 'none'}>
      <CodeEditor docKey={`${block.nodeId}/${file.key}`} language={fileLanguage} indentUnit={toolchain.indentUnit}
        ariaLabel={`${file.kind}: ${file.path}`} initialDoc={file.content} value={file.content} readOnly={readOnly} theme={theme}
        onChange={content => { if (!readOnly && block.nodeId) onChange?.(block.nodeId, file.fields(content)) }}
        onSave={() => { if (!readOnly) document.dispatchEvent(new Event('authoring:save')) }} onRun={() => {}} />
    </div>
  </div>
}

function ExercisePreview({ block, courseId, ...editing }: PreviewEditing & { block: ExerciseBlock; courseId: string }): JSX.Element {
  const [done, setDone] = useState(false)
  return <ExerciseBlockView courseId={courseId} block={block} mode="preview" done={done} onToggleDone={(_id, value) => setDone(value)}
    starterFiles={<PresetFiles block={block} {...editing} />} />
}

export function BlockPreview({ block, courseId, ...editing }: PreviewEditing & { block: Block; courseId: string }): JSX.Element {
  const src = useAuthoringAsset(courseId, 'src' in block ? block.src : undefined)
  const poster = useAuthoringAsset(courseId, block.type === 'video' ? block.poster : undefined)
  switch (block.type) {
    case 'markdown': return <MarkdownBlock content={block.content} />
    case 'image': return src ? <ImageBlockView block={{ ...block, src }} /> : <p className="meta">Upload an image to preview it.</p>
    case 'video': return src ? <VideoBlockView block={{ ...block, src, poster }} /> : <p className="meta">Upload a video to preview it.</p>
    case 'visualization': return src ? <Visualization block={{ ...block, src }} /> : <p className="meta">Upload an HTML visualization to preview it.</p>
    case 'quiz': return <QuizBlockView key={JSON.stringify(block)} courseId={courseId} block={block} preview onAnswered={() => {}} />
    case 'exercise': return <ExercisePreview key={block.nodeId ?? block.slug} courseId={courseId} block={block} {...editing} />
  }
}

export function LessonPreview({ lesson, manifest, courseId, ...editing }: PreviewEditing & { lesson: Lesson; manifest: CourseManifest; courseId: string }): JSX.Element {
  const lessons = manifest.modules.flatMap(module => module.type === 'project' ? [] : module.lessons)
  return <>
    <div className="author-preview-part" data-authoring-preview-key={`${lesson.nodeId}/header`}><LessonHeader lesson={lesson} index={Math.max(0, lessons.findIndex(entry => entry.nodeId === lesson.nodeId))} total={lessons.length} /></div>
    {lesson.blocks.map((block, index) => <div className="author-preview-part" data-authoring-preview-key={block.nodeId ?? `${lesson.nodeId}/block/${index}`} key={block.nodeId ?? index}><BlockPreview block={block} courseId={courseId} {...editing} /></div>)}
    {!!lesson.flashcards?.length && <><h2>Flashcards</h2>{lesson.flashcards.map(card => <div className="author-preview-part" data-authoring-preview-key={card.nodeId ?? card.id} key={card.nodeId ?? card.id}><FlashcardPreview card={card} courseId={courseId} /></div>)}</>}
  </>
}

export function FlashcardPreview({ card, courseId }: { card: Flashcard; courseId: string }): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const src = useAuthoringAsset(courseId, card.image?.src)
  useEffect(() => setRevealed(false), [card.question, card.answer, card.image?.src])
  return <div className="flashcard-preview panel">
    <span className="review-label">Flashcard · {card.id}</span><Html className="prose" source={card.question} />
    {src && <img className="review-image" src={src} alt={card.image?.alt ?? ''} />}
    <button className="secondary" onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide answer' : 'Reveal answer'}</button>
    {revealed && <div className="review-answer"><Html className="prose" source={card.answer} /></div>}
    <p className="meta">Preview only · Does not change review progress</p>
  </div>
}

export function ProjectPreview({ project }: { project: ProjectDefinition }): JSX.Element {
  return <>
    {!!project.objectives?.length && <ul>{project.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul>}
    <Html className="prose" source={project.definition} />
    <h2>Requirements</h2><ol>{project.requirements.map((r) => <li key={r.nodeId}><Html source={r.description} /></li>)}</ol>
    <h2>Deliverables</h2>{project.deliverables.map((d) => <div className="panel" key={d.nodeId}><h3>{d.title}</h3><Html source={d.description} />{d.paths?.map((p) => <p key={p}><code>{p}</code></p>)}<ul>{d.acceptance_criteria.map((c, i) => <li key={i}><Html source={c} /></li>)}</ul></div>)}
  </>
}
