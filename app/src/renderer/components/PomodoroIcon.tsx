import { useId } from 'react'
import type { PomodoroCycle } from '@core/pomodoro'

const CROWN = 'M11.4 7C9.7 4.2 7.5 5.4 6 4.2C5.7 6.8 8.1 8.2 10.4 7.8C10 9.5 10.7 10.9 12.2 11.5C13.4 10.3 13.6 8.9 12.9 7.6C15.2 8 17.6 7 18 4.7C16.2 5.3 14.7 4.9 12.8 6.7C13.2 5.4 13.5 4.3 14.2 3.4C15.1 2.5 13.1 1.6 12.2 2.5C10.9 4 10.6 5.7 11.4 7Z'
const CROWN_TILT = 'rotate(8 12 7)'

/** The silver crown is separated from the fruit by generous transparent gaps. */
export default function PomodoroIcon({ phase }: { phase: PomodoroCycle['phase'] }) {
  const id = useId()
  const silver = `${id}-silver`
  const cutout = `${id}-cutout`
  return <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={silver} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="8" y2="21">
        <stop stopColor="#eeeef1" />
        <stop offset="1" stopColor="#aaaab4" />
      </linearGradient>
      <mask id={cutout}>
        <rect width="24" height="24" fill="white" />
        <path d={CROWN} transform={CROWN_TILT} fill="black" stroke="black" strokeWidth="2.6" strokeLinejoin="round" />
        {phase === 'study' && <path d="M10 13.8Q9.5 13.5 9.5 14.1V19.5Q9.5 20.1 10 19.8L15.1 17.1Q15.7 16.8 15.1 16.5Z" fill="black" />}
        {phase === 'break' && <>
          <rect x="9" y="14.2" width="2.1" height="5.2" rx=".65" fill="black" />
          <rect x="12.9" y="14.2" width="2.1" height="5.2" rx=".65" fill="black" />
        </>}
      </mask>
    </defs>
    <g fill={`url(#${silver})`}>
      <path d="M12 7.6C9.4 5.5 5.3 5.8 3.1 9C.7 12.5 2.1 17.8 5.5 20.6C7.4 22.2 9.6 22.6 12 22.4C14.4 22.6 16.6 22.2 18.5 20.6C21.9 17.8 23.3 12.5 20.9 9C18.7 5.8 14.6 5.5 12 7.6Z" mask={`url(#${cutout})`} />
      <path d={CROWN} transform={CROWN_TILT} />
    </g>
  </svg>
}
