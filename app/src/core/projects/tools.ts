const path = { type: 'string', description: 'Relative directory or file inside the project. Use an empty string for the root directory.' }
const cursor = { type: ['integer', 'null'], minimum: 0, description: 'Offset from the previous page, or null for the first page.' }
function tool(name: string, description: string, properties: Record<string, unknown>) {
  return { type: 'function', name, description, strict: true, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }
}
export const PROJECT_TOOLS = [
  tool('list_project_files', 'List project files recursively, with bounded pages. Dependencies, secrets and symlinks are excluded.', { path, cursor }),
  tool('read_project_file', 'Read current UTF-8 text with line numbers. Binary and excluded files cannot be read. Reads are capped at 64 KiB.', { path, start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 500 } }),
  tool('search_project_files', 'Search literal text inside project files and return matching lines. Search is bounded and reports omissions.', { query: { type: 'string', minLength: 1, maxLength: 500 }, path, cursor })
] as const
export const MAX_PROJECT_FILE_BYTES = 64 * 1024
export const MAX_PROJECT_TURN_BYTES = 1024 * 1024
export const MAX_PROJECT_ENTRIES = 2000
export const PROJECT_PAGE_SIZE = 200
export const MAX_PROJECT_DEPTH = 12

export function excludedProjectPath(path: string): boolean {
  return path.split('/').some((part) =>
    ['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.aws', '.ssh', '.codex', '.agents', '.DS_Store', '.npmrc', '.netrc', '.pypirc'].includes(part) ||
    /^\.env(?:\.|$)/i.test(part) || /(?:^id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:pem|key|p12|pfx)$|^(?:credentials|secrets)(?:\.|$))/i.test(part)
  )
}
