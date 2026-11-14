/** Runtime branding shared by main, preload, and renderer. */
export const BRAND = {
  name: 'opencourse',
  displayName: 'OpenCourse Notebook',
  // Own scheme so this app does not register OpenCourse's opencourse:// handler.
  scheme: 'opencourse-notebook',
  background: '#111110'
} as const

export const ASSET_SCHEMES = [BRAND.scheme] as const
