/**
 * The sheen that follows the pointer across a card. One listener for the whole
 * document: it finds the `[data-glow]` element under the pointer and gives it
 * `--mx` / `--my`, which `.oc-glow::after` reads. Custom properties are set
 * through CSSOM, which a strict `style-src` allows. Returns the remover.
 */
export function pointerGlow(root: Document | HTMLElement = document): () => void {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {}
  const onMove = (event: Event): void => {
    const pointer = event as PointerEvent
    const target = pointer.target as Element | null
    const element = target?.closest?.('[data-glow]') as HTMLElement | null
    if (!element) return
    const rect = element.getBoundingClientRect()
    element.style.setProperty('--mx', `${pointer.clientX - rect.left}px`)
    element.style.setProperty('--my', `${pointer.clientY - rect.top}px`)
  }
  root.addEventListener('pointermove', onMove, { passive: true })
  return () => root.removeEventListener('pointermove', onMove)
}
