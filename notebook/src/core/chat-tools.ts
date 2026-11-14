export type ChatToolScope = 'chat' | 'project' | 'document' | 'writing-notebook' | 'authoring'
export interface ChatTools { webSearch: boolean; plan?: boolean }
export function validateChatTools(value: unknown, authoring = false): ChatTools {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chat tools.')
  const v = value as Record<string, unknown>
  if (typeof v.webSearch !== 'boolean' || Object.keys(v).some(k => k !== 'webSearch' && k !== 'plan') ||
    (v.plan !== undefined && (!authoring || typeof v.plan !== 'boolean'))) throw new Error('Invalid chat tools.')
  return { webSearch: v.webSearch, ...(authoring ? { plan: v.plan === true } : {}) }
}
