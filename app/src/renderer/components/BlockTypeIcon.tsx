import type { JSX, ReactNode } from 'react'
import type { Block } from '@core/types'

export const blockTypeLabels: Record<Block['type'], string> = {
  markdown: 'Text', image: 'Image', video: 'Video', visualization: 'Visualization', quiz: 'Quiz', exercise: 'Exercise'
}

const shapes: Record<Block['type'], ReactNode> = {
  markdown: <><path d="M4 4h16M12 4v16M8 20h8" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
  video: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 8 6 4-6 4Z" /></>,
  visualization: <><path d="M4 3v17h17M8 15l4-6 4 3 4-7" /><circle cx="12" cy="9" r="1" /><circle cx="16" cy="12" r="1" /></>,
  quiz: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01" /></>,
  exercise: <><path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" /></>
}

export default function BlockTypeIcon({ type }: { type: Block['type'] }): JSX.Element {
  return <svg className="outline-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[type]}</svg>
}
