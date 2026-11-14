import type { JSX } from 'react'
import type { AppUpdateStatus } from '@core/types'
import Menu, { type MenuItem } from './Menu'
import { formatDownloadSize, useAppUpdate } from './useAppUpdate'

/**
 * The titlebar's sign that a new version is waiting, first among its controls.
 * Absent the rest of the time: nothing to update is nothing to show. It is a
 * button opening a menu, never a link - the titlebar's one link is the way
 * back, and shots find it as the first `.titlebar a`.
 *
 * The menu does the common thing in one press (install and restart) and sends
 * everything else to Settings ▸ Updates, where there is room to say why an
 * install is waiting or what went wrong.
 */
export default function UpdateButton({ openSettings }: { openSettings?: () => void }): JSX.Element | null {
  const info = useAppUpdate()
  if (!info) return null
  const status = info.status
  const label = chipLabel(status)
  if (!label) return null

  const items: MenuItem[] = []
  if (status.state === 'available' && status.installable) {
    items.push({ id: 'install', label: `Install OpenCourse ${status.version} and restart`, hint: formatDownloadSize(status.size), onSelect: () => void window.opencourse.installAppUpdate() })
  } else if (status.state === 'available') {
    items.push({ id: 'download', label: `Download OpenCourse ${status.version}`, onSelect: () => void window.opencourse.openExternal(info.downloadUrl) })
  } else if (status.state === 'blocked') {
    items.push({ id: 'install', label: `Install OpenCourse ${status.version} and restart`, hint: formatDownloadSize(status.size), onSelect: () => void window.opencourse.installAppUpdate() })
  } else if (status.state === 'ready') {
    items.push({ id: 'restart', label: 'Restart to update', onSelect: () => void window.opencourse.installAppUpdate() })
  } else if (status.state === 'error') {
    items.push({ id: 'download', label: `Download OpenCourse ${status.version ?? ''}`.trim(), onSelect: () => void window.opencourse.openExternal(info.downloadUrl) })
  }
  const notes = 'notesUrl' in status ? status.notesUrl : undefined
  if (notes) items.push({ id: 'notes', label: 'What’s new', onSelect: () => void window.opencourse.openExternal(notes) })
  if (openSettings) items.push({ id: 'settings', label: 'Update settings', onSelect: openSettings })

  // In a narrow window the words give way to the arrow (and a download's
  // percentage), so the titlebar's controls still fit beside its way back.
  const short = status.state === 'downloading' ? label.replace(/^\D+/, '') : null
  return (
    <Menu
      className={`update-chip${status.state === 'error' ? ' failed' : ''}`}
      panelClassName="update-menu"
      title={chipTitle(status)}
      ariaLabel={label}
      label={
        <>
          <svg className="update-chip-glyph" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path d="M6 1.5v6M3.2 4.9 6 7.7l2.8-2.8M2 10.5h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="update-chip-text">{label}</span>
          {short && <span className="update-chip-short">{short}</span>}
        </>
      }
      items={items}
    />
  )
}

function chipLabel(status: AppUpdateStatus): string | null {
  switch (status.state) {
    case 'available':
    case 'blocked':
      return 'Update'
    case 'downloading':
      return `Updating ${Math.floor((status.received / Math.max(1, status.total)) * 100)}%`
    case 'verifying':
      return 'Updating'
    case 'ready':
      return 'Restart to update'
    case 'error':
      return status.version ? 'Update failed' : null
    default:
      return null
  }
}

function chipTitle(status: AppUpdateStatus): string {
  switch (status.state) {
    case 'available': return status.installable ? `OpenCourse ${status.version} is available` : status.reason ?? `OpenCourse ${status.version} is available`
    case 'blocked': return status.reason
    case 'error': return status.message
    case 'ready': return `OpenCourse ${status.version} is ready to install`
    default: return 'Updating OpenCourse'
  }
}
