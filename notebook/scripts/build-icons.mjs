// Reproducible macOS exports from the notebook master. No image API.
// Does not touch OpenCourse's web marks or the shared default-theme mark.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../resources')
const master = join(resources, 'branding/master.png')
const sips = (size, out) => execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', out], { stdio: 'ignore' })

const work = mkdtempSync(join(tmpdir(), 'opencourse-notebook-icon-'))
try {
  const iconset = join(work, 'notebook.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) sips(size * scale, join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'icon.icns')])
  sips(1024, join(resources, 'icon.png'))
  sips(128, join(resources, 'branding/mark.png'))
  console.log('Built OpenCourse Notebook PNG and ICNS assets from resources/branding/master.png')
} finally {
  rmSync(work, { recursive: true, force: true })
}
