import type { ChatTools } from '../core/chat-tools'

export const toolOptions = [
  { id: 'webSearch', label: 'Web search' },
  { id: 'plan', label: 'Plan' }
] as const
export type ChatToolOption = typeof toolOptions[number]

export function activeTools(tools: ChatTools, supportsWeb: boolean) {
  return toolOptions.filter(tool => tools[tool.id] && (tool.id !== 'webSearch' || supportsWeb))
}

export function ToolIcon({ name }: { name: ChatToolOption['id'] }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'webSearch' && <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>}
    {name === 'plan' && <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M8 9h1m3 0h4m-8 4h1m3 0h4m-8 4h1m3 0h4" /></>}
  </svg>
}
