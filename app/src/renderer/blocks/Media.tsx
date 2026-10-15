import { creditUrl } from '@core/image-attribution'
import type { ImageAttribution } from '@core/types'
import type { JSX } from 'react'
import type { ImageBlock, VideoBlock } from '@core/types'

function CreditLink({ url, label }: { url?: string; label: string }): JSX.Element {
  const href = creditUrl(url)
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <>{label}</>
}
export function ImageCredit({ credit }: { credit: ImageAttribution }): JSX.Element {
  return <span className="image-credit">Source: <CreditLink url={credit.source_url} label={credit.title || 'Original image'} />
    {(credit.author || credit.author_url) && <> · <CreditLink url={credit.author_url} label={credit.author || 'Author'} /></>}
    {(credit.license || credit.license_url) && <> · <CreditLink url={credit.license_url} label={credit.license || 'License'} /></>}
  </span>
}

export function ImageBlockView({ block }: { block: ImageBlock }): JSX.Element {
  return (
    <figure className="block">
      <img src={block.src} alt={block.alt ?? ''} />
      {(block.caption || block.attribution) && <figcaption>{block.caption && <span>{block.caption}</span>}{block.attribution && <ImageCredit credit={block.attribution} />}</figcaption>}
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
