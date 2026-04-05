import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['tests/**', 'node_modules/**', 'packages/**'],
    setupFiles: ['src/engine/__tests__/setup.ts'],
  },
})
