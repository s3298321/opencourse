/**
 * Child-process environment construction, for every language.
 *
 * Pure by contract - no fs, no child_process, no Electron. Everything that used
 * to live here about finding a Python, building a virtualenv and translating a
 * pytest command now lives in src/core/toolchains/, one descriptor per
 * language; this file is what is left once nothing about it is language-specific.
 */

/** Prepend dirs to a PATH, preserving order and dropping duplicates and blanks. */
export function mergePath(dirs: string[], basePath: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...dirs, ...basePath.split(':')]) {
    const trimmed = dir.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.join(':')
}

/** Env vars that would leak Electron's own runtime into the child. */
const STRIPPED = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_OVERRIDE_DIST_PATH',
  'ELECTRON_IS_DEV',
  'NODE_OPTIONS',
  'NODE_ENV'
])
const STRIPPED_PREFIXES = ['npm_', 'ELECTRON_NO_', 'VSCODE_']

export interface ChildEnvOptions {
  base: Readonly<Record<string, string | undefined>>
  /** Prepended to PATH in order, e.g. an environment's bin dir then a login PATH. */
  pathDirs?: string[]
  /** A PTY gets a terminal type; a piped run does not. */
  term?: string
  /**
   * Applied last. A null value *unsets* the variable, which is how a virtualenv
   * clears PYTHONHOME; the toolchain decides what belongs here.
   */
  extra?: Record<string, string | null>
}

/**
 * A Finder-launched app has no LANG, which degrades stdout encoding and garbles
 * the box drawing a test reporter emits. Everything language-specific arrives
 * through `extra`.
 */
export function childEnv(options: ChildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.base)) {
    if (value === undefined) continue
    if (STRIPPED.has(key)) continue
    if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }

  env['PATH'] = mergePath(options.pathDirs ?? [], env['PATH'] ?? '')
  if (!env['LANG']) env['LANG'] = 'en_US.UTF-8'
  if (options.term) env['TERM'] = options.term
  else delete env['TERM']

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  return env
}
