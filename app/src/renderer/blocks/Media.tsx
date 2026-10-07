import type { JSX } from 'react'
import type { ImageBlock, VideoBlock } from '@core/types'

export function ImageBlockView({ block }: { block: ImageBlock }): JSX.Element {
  return (
    <figure className="block">
      <img src={block.src} alt={block.alt ?? ''} />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
}

export function VideoBlockView({ block }: { block: VideoBlock }): JSX.Element {
  return (
    <figure className="block">
      <video src={block.src} poster={block.poster} controls style={{ width: '100%', borderRadius: 8 }} />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  )
}
