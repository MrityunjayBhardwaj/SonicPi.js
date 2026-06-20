#!/usr/bin/env node
// Build the runtime needed to make the parity dashboards' code snippets
// PLAYABLE in-place (the Run/Stop control in audio-controls.js).
//
// Why a local bundle and not the npm CDN: the published @mjayb/sonicpijs's
// dist/index.js is a code-split *library* — it dynamically imports a tree-sitter
// chunk that isn't even in the package, so a raw CDN load inits audio but never
// transpiles ("parser not available"). We reuse the SAME self-contained browser
// bundle the package ships (#604, tools/build-browser-bundle.mjs) — esbuild
// inlines that chunk, so the transpiler comes alive from one same-origin import.
//
// #604/SV80: the engine is self-sufficient — it loads SuperSonic (GPL, never
// bundled), the tree-sitter wasm, and the frozen rand-stream from the CDN itself.
// So this script ships ONLY the engine bundle; no wasm/wav copies are needed.
//
// Output (gitignored — regenerate with `npm run dashboard:audio`):
//   test_results/spw-engine.mjs   the same-origin, self-contained engine bundle
//
// Inline audio still requires the dashboards to be SERVED over http (test_results/
// as the web root: `npm run dashboard:serve`, or the Vercel publish bundle) — a
// file:// page can't load the ES-module bundle. There audio-controls.js shows
// only the "open in sonicpi.cc" link, by design.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildEngineBundle } from './build-browser-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'test_results')

await buildEngineBundle({ outfile: join(out, 'spw-engine.mjs') })

console.log('dashboard audio runtime → test_results/spw-engine.mjs (engine self-loads wasm/wav from CDN)')
