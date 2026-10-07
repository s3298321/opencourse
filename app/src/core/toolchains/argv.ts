/**
 * Turning manifest strings into argv, safely.
 *
 * A course is an archive the user imported, so every string in it is untrusted
 * input. None of it may become a shell string: commands and compiler flags are
 * validated and passed as argv, never quoted around. This is about refusing
 * malformed and surprising input rather than sandboxing - a course's `tests`
 * already execute arbitrary author-written code, and always did.
 */

/** Anything here means the string was written for a shell, so we refuse it. */
export const SHELL_METACHARACTERS = /[|;&$><`"'\\(){}[\]*?~!#\n\r]/

export type Refusal = { ok: false; reason: string }

export function tokenizeCommand(command: string): { ok: true; tokens: string[] } | Refusal {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, reason: 'empty test command' }
  if (SHELL_METACHARACTERS.test(trimmed)) return { ok: false, reason: 'contains shell syntax' }
  return { ok: true, tokens: trimmed.split(/\s+/) }
}

/**
 * Compiler flags a course is allowed to ask for: the standard, warnings,
 * `-f` switches (which is where the sanitizers live), debug info, optimization,
 * macro definitions and `-pedantic`. Everything else is refused, including `-o`
 * (the app owns the output path) and anything carrying a path.
 */
const ALLOWED_FLAG =
  /^-(?:std=[a-z0-9+]+|W[A-Za-z0-9=,_-]*|f[A-Za-z0-9=,_-]+|g[0-9]?|O[0-3sz]?|D[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_.-]+)?|pedantic(?:-errors)?)$/

export function safeFlags(flags: readonly string[]): { ok: true; flags: string[] } | Refusal {
  for (const flag of flags) {
    if (SHELL_METACHARACTERS.test(flag) || flag.includes('/')) {
      return { ok: false, reason: `unsafe compiler flag ${JSON.stringify(flag)}` }
    }
    if (!ALLOWED_FLAG.test(flag)) {
      return { ok: false, reason: `compiler flag not allowed in-app: ${JSON.stringify(flag)}` }
    }
  }
  return { ok: true, flags: [...flags] }
}

const LIB_NAME = /^[A-Za-z0-9_+.-]+$/

/** `runtime.packages` for a linked language: library names, one `-l` each. */
export function safeLibs(packages: readonly string[]): { ok: true; args: string[] } | Refusal {
  const args: string[] = []
  for (const name of packages) {
    if (!LIB_NAME.test(name)) return { ok: false, reason: `not a library name: ${JSON.stringify(name)}` }
    args.push(`-l${name}`)
  }
  return { ok: true, args }
}
