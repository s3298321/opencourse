/** Read-only, bounded project tools. No renderer endpoint executes these. */
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { classifyFile } from '../core/coach/files'
import { excludedProjectPath, MAX_PROJECT_DEPTH, MAX_PROJECT_ENTRIES, MAX_PROJECT_FILE_BYTES, MAX_PROJECT_TURN_BYTES, PROJECT_PAGE_SIZE } from '../core/projects/tools'

export interface ProjectFileScope { root: string; namespace: string; anchor?: string }
export interface ProjectToolBudget { bytes: number; signal?: AbortSignal }
interface Entry { path: string; kind: 'dir' | 'text' | 'binary'; bytes: number; modifiedAt: string }

/** Validate app-owned ancestors; system ancestors above userData may be symlinks. */
export function assertOwnedProjectAncestors(anchor: string, target: string): void {
  const base = resolve(anchor)
  const rel = relative(base, resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('Invalid project location.')
  let current = base
  for (const component of ['', ...rel.split(sep).filter(Boolean)]) {
    if (component) current = resolve(current, component)
    let stat
    try { stat = lstatSync(current) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The project location is not a regular directory; symlinks are excluded.')
  }
}

/** Prove each existing component is an ordinary directory/file, never a link. */
export function assertProjectPath(scope: ProjectFileScope, path = '', directory = false): string {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('~')) throw new Error('Use a relative path inside this project.')
  const parts = path ? path.split('/') : []
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error('Invalid project path.')
  if (excludedProjectPath(path)) throw new Error('This file is excluded from project review.')
  const namespace = resolve(scope.namespace)
  if (scope.anchor) assertOwnedProjectAncestors(scope.anchor, namespace)
  const root = resolve(scope.root)
  const rel = relative(namespace, root)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) throw new Error('Invalid project root.')
  let current = namespace
  const namespaceStat = lstatSync(namespace)
  if (namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()) throw new Error('Project workspace namespace is not a regular directory.')
  const all = [...rel.split(sep), ...parts]
  for (let n = 0; n < all.length; n++) {
    current = resolve(current, all[n]!)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('Symlinks are excluded from project review.')
    if (n < all.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('That project path is not a directory.')
    } else if (!stat.isDirectory() && !stat.isFile()) throw new Error('Only regular project files can be read.')
  }
  const actual = realpathSync(current)
  const canonicalRoot = realpathSync(root)
  if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + sep)) throw new Error('That path is outside the project.')
  return current
}
function check(budget: ProjectToolBudget): void {
  if (budget.signal?.aborted) throw new Error('Project review stopped.')
  if (budget.bytes >= MAX_PROJECT_TURN_BYTES) throw new Error('The file-read budget for this turn was reached.')
}
async function readBounded(scope: ProjectFileScope, path: string, budget: ProjectToolBudget) {
  check(budget)
  const target = assertProjectPath(scope, path)
  const before = lstatSync(target)
  if (!before.isFile()) throw new Error('That is not a regular file.')
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('The file changed before it could be read. Retry.')
    assertProjectPath(scope, path)
    const checked = lstatSync(target)
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) throw new Error('The file changed before it could be read. Retry.')
    const buffer = Buffer.alloc(Math.min(MAX_PROJECT_FILE_BYTES, MAX_PROJECT_TURN_BYTES - budget.bytes, opened.size))
    let count = 0
    while (count < buffer.length) {
      check(budget)
      const n = readSync(fd, buffer, count, Math.min(8192, buffer.length - count), count)
      if (!n) break
      count += n
      budget.bytes += n
      await setImmediate()
    }
    const after = fstatSync(fd)
    assertProjectPath(scope, path)
    const current = lstatSync(target)
    if (current.dev !== opened.dev || current.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.mtimeMs !== opened.mtimeMs) throw new Error('The file changed during review. Read it again.')
    const bytes = buffer.subarray(0, count)
    if (classifyFile(path, bytes) === 'binary') throw new Error('Binary artifact: content inspection is unavailable; review a text description instead.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: count < opened.size }) } catch { throw new Error('This file is not readable UTF-8 text.') }
    return { text, bytes: opened.size, truncated: count < opened.size, modifiedAt: opened.mtime.toISOString(), fingerprint: createHash('sha256').update(bytes).digest('hex') }
  } finally { closeSync(fd) }
}
async function walk(scope: ProjectFileScope, path: string, budget: ProjectToolBudget): Promise<{ entries: Entry[]; limited: boolean }> {
  const entries: Entry[] = []
  let visited = 0
  let limited = false
  async function visit(rel: string, depth: number): Promise<void> {
    check(budget)
    if (depth > MAX_PROJECT_DEPTH) { limited = true; return }
    const target = assertProjectPath(scope, rel, true)
    const dir = opendirSync(target)
    try {
      for (;;) {
        check(budget)
        const entry = dir.readSync()
        if (!entry) break
        if (++visited > MAX_PROJECT_ENTRIES) { limited = true; break }
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (excludedProjectPath(child) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue
        try {
          const full = assertProjectPath(scope, child, entry.isDirectory())
          const stat = lstatSync(full)
          entries.push({ path: child, kind: entry.isDirectory() ? 'dir' : classifyFile(child, new Uint8Array()), bytes: stat.size, modifiedAt: stat.mtime.toISOString() })
          if (entry.isDirectory()) await visit(child, depth + 1)
        } catch (err) { if (budget.signal?.aborted) throw err /* disappeared or excluded */ }
        if (visited > MAX_PROJECT_ENTRIES) break
        await setImmediate()
      }
    } finally { dir.closeSync() }
  }
  await visit(path, 0)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, limited }
}

export async function runProjectFileTool(scope: ProjectFileScope, name: string, raw: unknown, budget: ProjectToolBudget): Promise<string> {
  try {
    check(budget)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tool arguments.')
    const args = raw as Record<string, unknown>
    if (typeof args.path !== 'string') throw new Error('A relative path is required.')
    const keys = name === 'read_project_file' ? ['path', 'start_line', 'max_lines'] : name === 'search_project_files' ? ['path', 'cursor', 'query'] : ['path', 'cursor']
    if (Object.keys(args).some((key) => !keys.includes(key))) throw new Error('Unexpected tool argument.')
    if (name === 'read_project_file') {
      if (!Number.isInteger(args.start_line) || Number(args.start_line) < 1 || !Number.isInteger(args.max_lines) || Number(args.max_lines) < 1 || Number(args.max_lines) > 500) throw new Error('Invalid line range.')
      const file = await readBounded(scope, args.path, budget)
      const lines = file.text.split('\n')
      // Drop a partial final line, rather than present it as complete evidence.
      if (file.truncated) lines.pop()
      const start = Number(args.start_line) - 1
      const chosen = lines.slice(start, start + Number(args.max_lines))
      return JSON.stringify({ ok: true, path: args.path, ...file, text: chosen.map((line, n) => `${start + n + 1}: ${line}`).join('\n'), truncated: file.truncated || start + chosen.length < lines.length, availableLines: lines.length })
    }
    if (name !== 'list_project_files' && name !== 'search_project_files') throw new Error('Unknown project tool.')
    if (args.cursor !== null && (!Number.isInteger(args.cursor) || Number(args.cursor) < 0 || Number(args.cursor) > MAX_PROJECT_ENTRIES)) throw new Error('Invalid page cursor.')
    const offset = Number(args.cursor ?? 0)
    const tree = await walk(scope, args.path, budget)
    if (name === 'list_project_files') {
      const page = tree.entries.slice(offset, offset + PROJECT_PAGE_SIZE)
      return JSON.stringify({ ok: true, entries: page, nextCursor: offset + page.length < tree.entries.length ? offset + page.length : null, truncated: tree.limited, exclusions: 'Dependencies, build outputs, secrets and symlinks are excluded.' })
    }
    if (typeof args.query !== 'string' || !args.query || args.query.length > 500) throw new Error('Search needs a literal query of 1–500 characters.')
    const matches: { path: string; line: number; text: string }[] = []
    let limited = tree.limited
    for (const entry of tree.entries) {
      if (entry.kind === 'dir' || entry.kind === 'binary') continue
      check(budget)
      try {
        const file = await readBounded(scope, entry.path, budget)
        if (file.truncated) limited = true
        const lines = file.text.split('\n')
        if (file.truncated) lines.pop()
        for (let n = 0; n < lines.length; n++) if (lines[n]!.includes(args.query)) {
          matches.push({ path: entry.path, line: n + 1, text: lines[n]!.slice(0, 1000) })
          if (matches.length >= MAX_PROJECT_ENTRIES) { limited = true; break }
        }
      } catch { limited = true }
      if (matches.length >= MAX_PROJECT_ENTRIES || budget.bytes >= MAX_PROJECT_TURN_BYTES) { limited = true; break }
    }
    const page = matches.slice(offset, offset + PROJECT_PAGE_SIZE)
    return JSON.stringify({ ok: true, matches: page, nextCursor: offset + page.length < matches.length ? offset + page.length : null, truncated: limited })
  } catch (err) { return JSON.stringify({ ok: false, error: (err as Error).message }) }
}
