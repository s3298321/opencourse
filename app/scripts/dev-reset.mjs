// `npm run dev:reset`: forget the `npm run dev` profile, so the next launch
// seeds a fresh one. It deletes exactly ~/Library/Application Support/
// opencourse-dev - never the real profile beside it - and its keychain item
// ("OpenCourse Dev Safe Storage") is left alone: the next run reuses it.
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const profile = join(homedir(), 'Library', 'Application Support', 'opencourse-dev')
if (basename(profile) !== 'opencourse-dev') throw new Error(`Refusing to delete ${profile}`)
if (!existsSync(profile)) {
  console.log(`No dev profile at ${profile}.`)
} else {
  rmSync(profile, { recursive: true, force: true })
  console.log(`Deleted ${profile}. The next npm run dev seeds it again.`)
}
