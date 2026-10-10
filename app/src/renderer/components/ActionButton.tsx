import type { ComponentProps, JSX, ReactNode } from 'react'

const icons = {
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  download: <><path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></>,
  edit: <><path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5" /></>,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2" /></>,
  play: <path d="m7 3 14 9-14 9V3Z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restart: <><path d="M21 12a9 9 0 1 1-9-9 9.7 9.7 0 0 1 6.7 2.7L21 8" /><path d="M21 3v5h-5" /></>,
  reset: <><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8" /><path d="M3 3v5h5" /></>,
  up: <path d="M12 20V4m-6 6 6-6 6 6" />,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  eraser: <><path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21M22 21H7M5 11l9 9" /></>,
  notebook: <><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M2 7h4M2 12h4M2 17h4M10 8h6M10 12h6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  settings: <><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3H9Z" /><circle cx="12" cy="12" r="3" /></>,
  connect: <><path d="m9 15 6-6M8 16l-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4-2 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0" /></>,
  disconnect: <><path d="m3 3 18 18M8 16l-2 2a3 3 0 0 1-4-4l3-3M16 8l2-2a3 3 0 0 1 4 4l-3 3M9 15l2-2m2-2 2-2" /></>,
  signIn: <><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5M3 12h12m-4-4 4 4-4 4" /></>,
  signOut: <><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M9 12h12m-4-4 4 4-4 4" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
  key: <><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  book: <><path d="M4 19V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1 0-4h14M8 7h8M8 11h6" /></>,
  review: <><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2m4-3 2 2 4-4" /></>,
  left: <path d="M20 12H4m6-6-6 6 6 6" />,
  right: <path d="M4 12h16m-6-6 6 6-6 6" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 8 4 4-4 4m6 0h4" /></>,
  selectAll: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m7 12 3 3 7-7" /></>,
  unselectAll: <rect x="3" y="3" width="18" height="18" rx="2" />
} satisfies Record<string, ReactNode>

export type ActionIcon = keyof typeof icons
type Props = ComponentProps<'button'> & { icon: ActionIcon }

/** One of the action icons on its own, for a row that is not a button. */
export function Icon({ name, className = 'action-button-icon' }: { name: ActionIcon; className?: string }): JSX.Element {
  return <svg className={className} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>
}

/** Compact text actions; icons are decorative so the label stays accessible. */
export default function ActionButton({ icon, className = '', children, ...props }: Props): JSX.Element {
  return <button {...props} className={`action-button ${className}`.trim()}>
    <Icon name={icon} />
    <span className="action-button-label">{children}</span>
  </button>
}
