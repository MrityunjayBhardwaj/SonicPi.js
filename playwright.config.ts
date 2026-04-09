import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  projects: [
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testIgnore: /p2-credibility\.spec\.ts/,
    },
    {
      // P2 credibility tests require Web MIDI + getUserMedia mocks that only
      // install under Chromium. Runs headed because the SuperSonic CDN import
      // hangs in Chromium headless_shell — the same limitation that keeps
      // tools/capture.ts headed for audio verification.
      name: 'chromium',
      use: { browserName: 'chromium', headless: false },
      testMatch: /p2-credibility\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npx vite --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 10000,
  },
})
