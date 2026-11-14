import { useEffect, useState } from 'react'

/** A late result belongs to the tab that started the operation, even after switching tabs. */
export function useComposerDraft(tab: string | null, storageKey?: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [initial] = useState(() => {
    try { return storageKey ? localStorage.getItem(storageKey + ':composer') ?? '' : '' }
    catch { return '' }
  })
  const [firstTab, setFirstTab] = useState(tab)
  if (tab && !firstTab) setFirstTab(tab)
  const text = tab ? drafts[tab] ?? (tab === firstTab ? initial : '') : ''
  useEffect(() => {
    if (tab && storageKey) {
      try { localStorage.setItem(storageKey + ':composer', text) } catch { /* Optional. */ }
    }
  }, [storageKey, tab, text])
  function setText(value: string | ((previous: string) => string)) {
    if (tab) setDrafts(previous => ({ ...previous,
      [tab]: typeof value === 'function' ? value(previous[tab] ?? text) : value
    }))
  }
  return [text, setText] as const
}
