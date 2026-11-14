// Native title bubbles follow the macOS window appearance. While Panda is
// active, draw hovered titles with the same surface as the app's other hints.
export function followTitleTooltips(): () => void {
  const events = new AbortController()
  const options = { capture: true, signal: events.signal }
  const bubble = document.createElement('div')
  bubble.className = 'tooltip title-tooltip'
  bubble.setAttribute('role', 'tooltip')
  let anchor: Element | null = null
  let label = ''
  let timer = 0
  let addedDescription = false

  function hide(): void {
    window.clearTimeout(timer)
    bubble.remove()
  }
  function release(restoreTitle = true): void {
    hide()
    observer.disconnect()
    if (anchor) {
      // A React render may have replaced or removed the title in the meantime.
      if (restoreTitle && anchor.getAttribute('title') === '') anchor.setAttribute('title', label)
      if (addedDescription && anchor.getAttribute('aria-description') === label) anchor.removeAttribute('aria-description')
    }
    anchor = null
    addedDescription = false
  }
  function maskTitle(): void {
    if (!anchor) return
    observer.disconnect()
    label = anchor.getAttribute('title')!
    anchor.setAttribute('title', '')
    if (addedDescription || !anchor.hasAttribute('aria-description')) {
      anchor.setAttribute('aria-description', label)
      addedDescription = true
    }
    bubble.textContent = label
    observer.observe(anchor, { attributes: true, attributeFilter: ['title'] })
  }
  const observer = new MutationObserver(() => {
    if (anchor?.getAttribute('title')) maskTitle()
    else {
      // The owner cleared the title. Release without reinstating the old text.
      release(false)
    }
  })
  function enter(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target.closest('[title]') : null
    if (target === anchor) return
    release()
    if (!target?.getAttribute('title') || target.closest('.tooltip-trigger')) return
    anchor = target
    maskTitle()
    timer = window.setTimeout(() => {
      if (!target.isConnected || !target.checkVisibility()) { release(); return }
      document.dispatchEvent(new CustomEvent('opencourse:tooltip', { detail: 'title' }))
      document.body.append(bubble)
      const box = target.getBoundingClientRect()
      const { width, height } = bubble.getBoundingClientRect()
      const below = box.bottom + 6
      bubble.style.top = Math.max(8, below + height <= innerHeight - 8 ? below : box.top - height - 6) + 'px'
      bubble.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) + 'px'
    }, 500)
  }

  document.addEventListener('pointerover', enter, options)
  document.addEventListener('pointerout', event => {
    if (!(event.relatedTarget instanceof Node && anchor?.contains(event.relatedTarget))) release()
  }, options)
  document.addEventListener('pointerdown', hide, options)
  document.addEventListener('keydown', hide, options)
  document.addEventListener('opencourse:tooltip', event => {
    if ((event as CustomEvent<string>).detail !== 'title') hide()
  }, options)
  window.addEventListener('scroll', hide, options)
  window.addEventListener('resize', hide, options)
  window.addEventListener('blur', () => release(), { signal: events.signal })
  return () => { events.abort(); release() }
}
