import { useMemo } from 'react'
import { renderFormula } from '@core/formula'

export default function Formula({ content }: { content: string }) {
  const html = useMemo(() => ({ __html: renderFormula(content) }), [content])
  return <div className="block prose" dangerouslySetInnerHTML={html} />
}
