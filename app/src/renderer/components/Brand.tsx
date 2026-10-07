import type { JSX } from 'react'
import { BRAND } from '@core/brand'
import icon from '../../../resources/branding/mark.png'
import { useThemeLogo } from '../theme/ThemeProvider'

/**
 * Decorative icon; the adjacent wordmark provides its accessible name. A theme
 * may replace the mark, never the name beside it.
 */
export default function Brand(): JSX.Element {
  const logo = useThemeLogo()
  return <span className="brand">
    <img src={logo ?? icon} alt="" aria-hidden="true" />
    <span>{BRAND.displayName}</span>
  </span>
}
