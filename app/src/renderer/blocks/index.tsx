import type { JSX } from 'react'
import type { Block, CourseProgress, QuizAttempt } from '@core/types'
import MarkdownBlock from './Markdown'
import { ImageBlockView, VideoBlockView } from './Media'
import VisualizationBlockView from './Visualization'
import QuizBlockView from './Quiz'
import ExerciseBlockView from './Exercise'

export interface BlockContext {
  courseId: string
  moduleId: string
  lessonId: string
  progress: CourseProgress
  onQuizAnswered: (blockId: string, attempt: QuizAttempt) => void
  onExerciseToggled: (blockId: string, done: boolean) => void
  onOpenWorkbench: (blockId: string) => void
  openExerciseId: string | null
}

export function renderBlock(block: Block, index: number, ctx: BlockContext): JSX.Element | null {
  switch (block.type) {
    case 'markdown':
      return <MarkdownBlock key={block.nodeId ?? index} content={block.content} />
    case 'image':
      return <ImageBlockView key={block.nodeId ?? index} block={block} />
    case 'video':
      return <VideoBlockView key={block.nodeId ?? index} block={block} />
    case 'visualization':
      return <VisualizationBlockView key={block.nodeId ?? index} block={block} />
    case 'quiz':
      return (
        <QuizBlockView
          key={block.id}
          courseId={ctx.courseId}
          block={block}
          attempt={ctx.progress.quizAttempts[block.id]}
          onAnswered={ctx.onQuizAnswered}
        />
      )
    case 'exercise':
      return (
        <ExerciseBlockView
          key={block.id}
          courseId={ctx.courseId}
          block={block}
          done={Boolean(ctx.progress.exercises[block.id]?.completedAt)}
          onToggleDone={ctx.onExerciseToggled}
          onOpenWorkbench={ctx.onOpenWorkbench}
          isOpen={ctx.openExerciseId === block.id}
        />
      )
    default:
      return null
  }
}
