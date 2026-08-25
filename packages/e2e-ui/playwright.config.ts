import { defineConfig, devices } from '@playwright/test'

// UI e2e run against the docker-compose.e2e.yml stack. All services use
// host networking with localhost URLs so the browser and the servers
// share one address space (avoids OAuth redirect host-mismatch pain).
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.MCP_URL ?? 'http://localhost:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
})
