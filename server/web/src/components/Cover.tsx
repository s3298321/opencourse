import { useState } from 'react'
import { coverUrl } from '../lib/api'
import { hash } from '../lib/format'

/**
 * A course's cover, or - for a course without one, or whose picture fails -
 * one of six quiet gradients chosen by the course's id, with the mark's star
 * and the subject. A course always looks like itself, and never like a hole.
 */
export function Cover({ id, title, subject, hasCover, className = '', transitionName }: {
  id: string
  title: string
  subject?: string
  hasCover: boolean
  className?: string
  /** The view-transition name that lets the cover fly from a card into the course page. */
  transitionName?: string
}) {
  const [failed, setFailed] = useState(false)
  const style = transitionName ? { viewTransitionName: transitionName } : undefined
  if (hasCover && !failed) {
    return (
      <div className={`cover ${className}`} style={style}>
        <img src={coverUrl(id)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </div>
    )
  }
  return (
    <div className={`cover cover-fallback v${hash(id) % 6} ${className}`} style={style} aria-hidden="true">
      <span className="oc-sparkle cover-star" />
      <span className="cover-label">{subject || title}</span>
    </div>
  )
}
