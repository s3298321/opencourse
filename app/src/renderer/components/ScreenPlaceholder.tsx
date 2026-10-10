import type { ReactNode } from 'react'

/** Keep the page surface painted while its data is loading or unavailable. */
export default function ScreenPlaceholder({ children = 'Loading…' }: { children?: ReactNode }) {
  return <div className="body"><div className="content scroll"><div className="empty" role="status">{children}</div></div></div>
}
