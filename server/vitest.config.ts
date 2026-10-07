import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The server shares the app's pure core (the course schema, the identity walk,
// the archive policy) and its Electron-free unzip. Bare imports inside those
// files resolve to this package's node_modules, so a server checkout never
// depends on the app's being installed.
const here = (path: string): string => resolve(__dirname, path)
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@core\/(.*)$/, replacement: here('../app/src/core/$1') },
      { find: '@app/unzip', replacement: here('../app/src/main/unzip.ts') },
      { find: /^ajv(\/.*)?$/, replacement: here('node_modules/ajv$1') },
      { find: /^yauzl$/, replacement: here('node_modules/yauzl') }
    ]
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 20000
  }
})
