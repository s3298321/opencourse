import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

export function pdfResourceRoot(): string { return dirname(require.resolve('pdfjs-dist/package.json')) }
export async function readPdfResource(kind: string, filename: string): Promise<Uint8Array> {
  const directories: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }
  if (!Object.hasOwn(directories, kind) || typeof filename !== 'string' || !/^[a-z\d_.-]{1,150}$/i.test(filename) || filename.includes('..')) throw new Error('Invalid PDF resource.')
  return new Uint8Array(await readFile(join(pdfResourceRoot(), directories[kind]!, filename)))
}
