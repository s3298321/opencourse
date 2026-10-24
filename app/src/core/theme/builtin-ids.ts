/** Reserved preference ids; imported themes always use app-local UUIDs. */
export const WHITE_THEME_ID = 'builtin:white'
export const NEON_THEME_ID = 'builtin:neon-afterhours'

export function isBuiltinThemeId(id: string): boolean {
  return id === WHITE_THEME_ID || id === NEON_THEME_ID
}
