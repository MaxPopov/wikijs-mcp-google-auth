import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // e2e tests may wait out the Wiki.js per-IP login rate limit (60s window),
    // and running e2e files sequentially keeps login bursts under that limit
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: 'forks'
  }
})
