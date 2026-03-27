import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import { resolve } from 'path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Library build config — produces ESM and CJS bundles + source maps.
 * Type declarations are generated separately via: tsc -p tsconfig.lib.json
 * Usage: npm run build:lib
 * Output: dist/index.js (ESM), dist/index.cjs (CJS), dist/types/
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/engine/index.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    // All browser APIs are host-provided — no external deps to mark
    rollupOptions: {
      external: [],
    },
  },
})
