import { useState } from 'react'
import { activeTools, toolOptions, ToolIcon } from './chat-tool-options'
import Menu from './Menu'
import type { ChatTools } from '../core/chat-tools'
/** Shared across local and server-backed composers. The menu reports the saved
 * preference separately from whether the current model can use it. */
export default function ChatToolsMenu({ tools, change, supportsWeb, busy, active = true, resetKey }: {
  tools: ChatTools; change?: (next: ChatTools) => void | Promise<void>; supportsWeb: boolean; busy: boolean; active?: boolean; resetKey?: string | null
}) {
  const [saving, setSaving] = useState(false)
  const enabled = activeTools(tools, supportsWeb).map(tool => tool.label).join(', ')
  async function toggle(id: keyof ChatTools) {
    if (!change || saving || busy) return
    setSaving(true)
    try { await change({ ...tools, [id]: !tools[id] }) }
    finally { setSaving(false) }
  }
  const label = 'Chat tools' + (enabled ? ': ' + enabled : ': none enabled')
  return <Menu className={'sidechat-connection chat-tools-trigger' + (enabled ? ' on' : '')} panelClassName="chat-menu learning-chat-menu chat-tools-menu" align="left" side="above" closeOnSelect={false} resetKey={resetKey ?? ''} screenActive={active}
    disabled={busy || !change} ariaLabel={label} title={change ? label : 'Per-chat tools are unavailable on this server'} heading="Tools for this chat"
    label={<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 6h4m4 0h6M3 14h8m4 0h2"/><circle cx="9" cy="6" r="2"/><circle cx="13" cy="14" r="2"/></svg>}
    items={toolOptions.filter(tool => tool.id !== 'plan' || tools.plan !== undefined).map(tool => {
      const unavailable = tool.id === 'webSearch' && !supportsWeb
      return { id: tool.id, label: tool.label, icon: <ToolIcon name={tool.id} />, checked: !!tools[tool.id], checkType: 'checkbox',
        hint: unavailable ? 'Unavailable with this model or reasoning level' : undefined,
        disabled: saving || busy || unavailable, onSelect: () => void toggle(tool.id) }
    })} />
}
