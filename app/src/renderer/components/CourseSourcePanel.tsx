import { Component, createRef, type ReactNode } from 'react'

interface Props {
  source: string
  index: number
  /** The tabs' id prefix; Documents has its own row of source tabs. */
  prefix?: string
  children: ReactNode
}
interface Snapshot { departing: HTMLDivElement; height: number; direction: number }

/** Capture the old panel before React replaces its contents, then animate both. */
export default class CourseSourcePanel extends Component<Props> {
  private panel = createRef<HTMLDivElement>()
  private content = createRef<HTMLDivElement>()
  private preference: MediaQueryList | undefined
  private stop = (): void => {}
  private onPreferenceChange = (): void => { if (this.preference?.matches) this.stop() }

  componentDidMount(): void {
    this.preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    this.preference?.addEventListener('change', this.onPreferenceChange)
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.source === this.props.source) return null
    this.stop()
    const content = this.content.current
    if (!content || this.preference?.matches || typeof content.animate !== 'function') return null
    const departing = content.cloneNode(true) as HTMLDivElement
    // The snapshot only paints; controls and IDs belong to the live panel.
    departing.inert = true
    departing.setAttribute('aria-hidden', 'true')
    departing.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
    departing.classList.add('course-source-departing')
    return { departing, height: content.offsetHeight, direction: this.props.index > previous.index ? 1 : -1 }
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null): void {
    const panel = this.panel.current, content = this.content.current
    if (!snapshot || !panel || !content) return
    const { departing, height, direction } = snapshot
    // Keep a taller departing list in the scroll area until its fade finishes.
    panel.style.minHeight = `${Math.max(height, content.offsetHeight)}px`
    panel.append(departing)
    const outgoing = departing.animate([
      { opacity: 1, transform: 'translateX(0)' },
      { opacity: 0, transform: `translateX(${-direction * 32}px)` }
    ], { duration: 105, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' })
    const incoming = content.animate([
      { opacity: 0, transform: `translateX(${direction * 32}px)` },
      { opacity: 1, transform: 'translateX(0)' }
    ], { duration: 180, delay: 105, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' })
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      outgoing.cancel()
      incoming.cancel()
      departing.remove()
      panel.style.minHeight = ''
    }
    this.stop = stop
    void Promise.all([outgoing.finished, incoming.finished]).then(stop, stop)
  }

  componentWillUnmount(): void {
    this.stop()
    this.preference?.removeEventListener('change', this.onPreferenceChange)
  }

  render() {
    const prefix = this.props.prefix ?? 'course-source'
    return <div ref={this.panel} className="course-source-panel" id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-${this.props.index}`}>
      <div ref={this.content} className="course-source-content">{this.props.children}</div>
    </div>
  }
}
