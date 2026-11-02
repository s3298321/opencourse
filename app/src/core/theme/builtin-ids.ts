/** Reserved preference ids; imported themes always use app-local UUIDs. */
export const WHITE_THEME_ID = 'builtin:white'

export function isBuiltinThemeId(id: string): boolean {
  return id === WHITE_THEME_ID
}
