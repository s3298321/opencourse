import type { JSX } from 'react'
import Html from '../components/Html'

export default function MarkdownBlock({ content }: { content: string }): JSX.Element {
  const isTakeaways = content.trimStart().startsWith('## Key takeaways')
  return <Html lesson className={`block prose${isTakeaways ? ' takeaways' : ''}`} source={content} />
}
