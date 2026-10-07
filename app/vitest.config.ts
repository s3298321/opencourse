import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // '@app/unzip' is how server/ names this app's unzip; the opt-in server-live
  // test imports the server itself.
  resolve: { alias: { '@core': resolve(__dirname, 'src/core'), '@app/unzip': resolve(__dirname, 'src/main/unzip.ts') } },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    globals: false
  }
})
