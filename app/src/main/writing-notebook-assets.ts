import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { writingNotebookDirectory } from './writing-notebook-locations'
/** The asset protocol never resolves caller-provided filesystem paths or follows symlinks. */
export function writingNotebookAsset(id: string, name: string): string | null {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}\.(png|jpg|webp|gif|sketch\.svg)$/i.test(name)) return null
    const directory = writingNotebookDirectory(id)
    const folder = lstatSync(directory), assets = lstatSync(join(directory, 'assets'))
    if (!folder.isDirectory() || folder.isSymbolicLink() || !assets.isDirectory() || assets.isSymbolicLink() || !lstatSync(join(directory, 'notebook.json')).isFile()) return null
    const file = join(directory, 'assets', name), stat = lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink() ? file : null
  } catch { return null }
}