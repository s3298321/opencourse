/**
 * The site's only script, bundled into one module file. Everything works
 * without it - links are links - and it adds: the cursor sheen on cards, the
 * phone menu, copy buttons, the star count that counts up, the docs' "On this
 * page" highlight and the ⌘K search over the docs (Pagefind, built with the
 * site, so a search never leaves it).
 */
import { pointerGlow } from '@design/pointer-glow'

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
pointerGlow()

/* ---------- phone menu ---------- */
const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]')
const menu = document.querySelector<HTMLElement>('[data-menu]')
toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true'
  toggle.setAttribute('aria-expanded', String(open))
  if (menu) menu.hidden = !open
  document.documentElement.toggleAttribute('data-menu-open', open)
})
menu?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('a')) toggle?.click()
})

/* ---------- copy buttons ---------- */
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', () => {
    void navigator.clipboard?.writeText(button.dataset['copy'] ?? '').then(() => {
      button.classList.add('copied')
      const label = button.querySelector('[data-copy-label]')
      const before = label?.textContent
      if (label) label.textContent = 'Copied'
      window.setTimeout(() => { button.classList.remove('copied'); if (label) label.textContent = before ?? 'Copy' }, 1600)
    })
  })
}

/* ---------- numbers that count up when they come into view ---------- */
const counters = document.querySelectorAll<HTMLElement>('[data-count]')
if (counters.length && !reducedMotion && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      const element = entry.target as HTMLElement
      const target = Number(element.dataset['count'])
      if (!Number.isFinite(target) || target < 2 || target >= 1000) continue
      const start = performance.now()
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / 900)
        element.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))))
        if (t < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
  })
  for (const counter of counters) observer.observe(counter)
}

/* ---------- docs: which section you are reading ---------- */
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc] a[href^="#"]')]
if (tocLinks.length && 'IntersectionObserver' in window) {
  const byId = new Map(tocLinks.map((link) => [decodeURIComponent(link.hash.slice(1)), link]))
  const visible = new Set<string>()
  const mark = (): void => {
    const first = [...byId.keys()].find((id) => visible.has(id))
    if (!first) return
    for (const [id, link] of byId) link.toggleAttribute('aria-current', id === first)
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.id)
      else visible.delete(entry.target.id)
    }
    mark()
  }, { rootMargin: '-80px 0px -60% 0px' })
  for (const id of byId.keys()) {
    const heading = document.getElementById(id)
    if (heading) observer.observe(heading)
  }
}

/* ---------- docs search ---------- */
interface PagefindResult { url: string; excerpt: string; meta: { title?: string } }
interface Pagefind { init(): Promise<void>; search(query: string): Promise<{ results: { data(): Promise<PagefindResult> }[] }> }
const dialog = document.querySelector<HTMLDialogElement>('[data-search]')
if (dialog) {
  const input = dialog.querySelector<HTMLInputElement>('input')!
  const list = dialog.querySelector<HTMLElement>('[data-search-results]')!
  let pagefind: Promise<Pagefind | null> | null = null
  const load = (): Promise<Pagefind | null> => {
    pagefind ??= (async () => {
      try {
        const url = '/pagefind/pagefind.js'
        const module = await import(/* @vite-ignore */ url) as Pagefind
        await module.init()
        return module
      } catch { return null }
    })()
    return pagefind
  }
  const open = (): void => {
    if (dialog.open) return
    dialog.showModal()
    input.select()
    void load()
  }
  for (const button of document.querySelectorAll('[data-search-open]')) button.addEventListener('click', open)
  window.addEventListener('keydown', (event) => {
    const typing = (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')
    if ((event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
      event.preventDefault()
      open()
    }
  })
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
  let latest = 0
  input.addEventListener('input', async () => {
    const query = input.value.trim()
    const ticket = ++latest
    if (!query) { list.innerHTML = ''; return }
    const engine = await load()
    if (ticket !== latest) return
    if (!engine) { list.innerHTML = '<p class="search-empty">Search is built with the site; run <code>npm run build</code> and <code>npm run preview</code>.</p>'; return }
    const found = await engine.search(query)
    const results = await Promise.all(found.results.slice(0, 8).map((r) => r.data()))
    if (ticket !== latest) return
    list.innerHTML = results.length
      ? results.map((r) => `<a class="search-result" href="${r.url.replace(/\/$/, '')}"><strong>${escapeHtml(r.meta.title ?? r.url)}</strong><span>${r.excerpt}</span></a>`).join('')
      : '<p class="search-empty">Nothing in the docs matches that.</p>'
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
