import type { JSX } from 'react'
import type { ChatMessage } from '@core/types'
import { REASONING_LABELS } from '@core/sidechat/models'
import Tooltip from './Tooltip'

export default function ChatMessageMeta({ message }: { message: Pick<ChatMessage, 'at' | 'generation'> }): JSX.Element | null {
  const date = new Date(message.at)
  const valid = !Number.isNaN(date.getTime())
  const today = valid && date.toDateString() === new Date().toDateString()
  const time = valid ? new Intl.DateTimeFormat(undefined, {
    ...(today ? {} : { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date) : ''
  const fullTime = valid ? new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(date) : ''
  const generation = message.generation
  if (!valid && !generation) return null
  return <div className="chat-message-meta" data-ask="none">
    {valid && <Tooltip label={fullTime}><time dateTime={message.at} aria-label={fullTime}>{time}</time></Tooltip>}
    {generation && <span className="chat-generation">
      <span aria-hidden="true">·</span><span>{generation.model}</span><span aria-hidden="true">·</span>
      <span>{generation.reasoning === null ? 'Default reasoning' : generation.reasoning === 'none' ? 'No reasoning' : `${REASONING_LABELS[generation.reasoning]} reasoning`}</span>
    </span>}
  </div>
}
