export default function ChatToggle({ open, onClick, subject }: {
  open: boolean
  onClick: () => void
  subject: 'lesson' | 'document' | 'notebook'
}) {
  const label = open ? 'Close the side chat' : `Ask about this ${subject}`
  return <button type="button" className={`ghost chat-chip${open ? ' on' : ''}`}
    aria-pressed={open} aria-label={label} title={label} onClick={onClick}>
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z" />
      <path d="M7 8h10M7 12h7" />
    </svg>
  </button>
}
