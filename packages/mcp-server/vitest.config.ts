import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // e2e tests may wait out the Wiki.js per-IP login rate limit (60s window)
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: 'forks'
  }
})
