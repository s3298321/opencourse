import type { JSX } from 'react'
import type { ChatLessonRef, ChatQuote } from '@core/types'
import { useChatPanel } from '../sidechat/useChat'
import ChatPanel from './ChatPanel'
import { ScreenActivityProvider, useScreenActive } from '../screen-activity'
interface Props {
  visible?: boolean
  courseId: string
  lesson?: ChatLessonRef
  notebook?: boolean
  beforeSend?: () => Promise<void>
  quote: ChatQuote | null
  onQuoteUsed: () => void
  onClose: () => void
  onAddKey: () => void
  textScale: number
}
export default function SideChat({ courseId, lesson, notebook = false, beforeSend, visible = true, ...props }: Props): JSX.Element {
  const active = useScreenActive() && visible
  const panel = useChatPanel(courseId, lesson, undefined, active, notebook, beforeSend)
  return <ScreenActivityProvider value={active}><ChatPanel variant={notebook ? 'notebook' : 'lesson'} visible={visible} panel={panel} {...props} /></ScreenActivityProvider>
}
