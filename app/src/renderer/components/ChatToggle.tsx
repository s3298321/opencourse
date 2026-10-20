import { ChatIcon } from '../../learning-ui/ChatIcon'

export default function ChatToggle({ open, onClick, subject }: {
  open: boolean
  onClick: () => void
  subject: 'lesson' | 'document' | 'notebook'
}) {
  const label = open ? 'Close the side chat' : `Ask about this ${subject}`
  return <button type="button" className={`ghost chat-chip${open ? ' on' : ''}`}
    aria-pressed={open} aria-label={label} title={label} onClick={onClick}>
    <ChatIcon />
  </button>
}
