import { useLayoutEffect, useRef, useState } from 'react'

/** Covers and whole tag chips share the card's left column. */
export default function CourseCardMedia({ coverUrl, tags = [] }: { coverUrl?: string; tags?: string[] }) {
  const area = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<string[]>([])
  const tagKey = JSON.stringify(tags)

  useLayoutEffect(() => {
    const container = area.current
    const measurements = measure.current
    const target = list.current
    if (!container || !measurements || !target) return
    const fit = (): void => {
      const { width, height } = container.getBoundingClientRect()
      const style = getComputedStyle(target)
      const columnGap = parseFloat(style.columnGap) || 0
      const rowGap = parseFloat(style.rowGap) || 0
      const next: string[] = []
      let x = 0, y = 0, rowHeight = 0
      for (const chip of measurements.children) {
        const size = chip.getBoundingClientRect()
        // Skip oversized tags so shorter tags after them can still fit.
        if (size.width > width || size.height > height) continue
        const wrap = x > 0 && x + columnGap + size.width > width
        const top = wrap ? y + rowHeight + rowGap : y
        if (top + size.height > height) continue
        next.push(chip.textContent ?? '')
        x = wrap || x === 0 ? size.width : x + columnGap + size.width
        y = top
        rowHeight = wrap ? size.height : Math.max(rowHeight, size.height)
      }
      setVisible((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    // Font and theme changes can change chip sizes without resizing the column.
    for (const chip of measurements.children) observer.observe(chip)
    return () => observer.disconnect()
  }, [tagKey, coverUrl])

  if (!coverUrl && tags.length === 0) return null
  return <div className="course-card-media">
    {coverUrl && <img src={coverUrl} alt="" />}
    {tags.length > 0 && <div ref={area} className="course-card-media-tags">
      <div ref={list} className="course-card-tag-list">
        {visible.map((tag, index) => <span className="tag" key={index}>{tag}</span>)}
      </div>
      <div ref={measure} className="course-card-tag-measure" aria-hidden="true">
        {tags.map((tag, index) => <span className="tag" key={index}>{tag}</span>)}
      </div>
    </div>}
  </div>
}
