import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { EmptyState, useTitle } from '../components/Bits'

export function NotFoundPage() {
  useTitle('Not found')
  return (
    <div className="oc-wrap page">
      <EmptyState title="Nothing lives at this address" actions={<Link className="oc-btn" to="/" viewTransition><ArrowLeft aria-hidden />Back to the catalog</Link>}>
        The course may have been unlisted by its publisher, or the link is mistyped.
      </EmptyState>
    </div>
  )
}

/** What a page shows when its data could not be loaded. */
export function RouteError() {
  const error = useRouteError()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />
  const forbidden = isRouteErrorResponse(error) && error.status === 403
  const text = isRouteErrorResponse(error) ? String(error.data || error.statusText)
    : error instanceof Error ? error.message : 'Something went wrong.'
  return <ErrorView title={forbidden ? 'Not for this account' : 'This page could not load'} text={text} retry={!forbidden} />
}

export function ErrorView({ title, text, retry }: { title: string; text: string; retry?: boolean }) {
  useTitle(title)
  return (
    <div className="oc-wrap page">
      <EmptyState title={title} actions={<>
        {retry && <button type="button" className="oc-btn" onClick={() => window.location.reload()}><RotateCcw aria-hidden />Try again</button>}
        <Link className="oc-btn secondary" to="/"><ArrowLeft aria-hidden />Catalog</Link>
      </>}>{text}</EmptyState>
    </div>
  )
}
