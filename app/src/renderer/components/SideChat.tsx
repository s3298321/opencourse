import type { JSX } from 'react'
import type { ChatLessonRef, ChatQuote } from '@core/types'
import { useChatPanel } from '../sidechat/useChat'
import ChatPanel from './ChatPanel'
interface Props {
  courseId: string
  lesson: ChatLessonRef
  quote: ChatQuote | null
  onQuoteUsed: () => void
  onClose: () => void
  onAddKey: () => void
  textScale: number
}
export default function SideChat({ courseId, lesson, ...props }: Props): JSX.Element {
  const panel = useChatPanel(courseId, lesson)
  return <ChatPanel panel={panel} {...props} />
}
