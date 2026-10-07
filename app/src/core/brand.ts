/** Runtime branding shared by main, preload, and renderer. */
export const BRAND = {
  name: 'opencourse',
  displayName: 'OpenCourse',
  scheme: 'opencourse',
  background: '#18181b'
} as const

export const ASSET_SCHEMES = [BRAND.scheme] as const
