#!/usr/bin/env node
// Static file server for the parity dashboards (npm run dashboard:serve).
//
// Why not `npx serve`: that package does clean-URL rewriting — it maps
// `/community.html` → `/community`, which COLLIDES with the sibling artifact
// directory `community/` and serves a fixture file instead of the dashboard.
// Every dashboard with a per-fixture dir (community, e2e, examples-sweep,
// book-examples-sweep, gate-detail) was affected. This server serves the
// requested path LITERALLY — exactly what the dashboards' relative links expect
// — and roots test_results/ at `/` so the same-origin `/spw-engine.mjs` resolves.
// #604/SV80: the engine self-loads SuperSonic / tree-sitter / rand-stream from
// the CDN, so only the engine bundle is hosted here. It also sends the
// cross-origin-isolation headers SuperSonic's AudioWorklet needs (SharedArrayBuffer)
// so inline audio works locally, not just on Vercel.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'test_results')
const PORT = Number(process.argv[2] || process.env.PORT || 5180)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel === '/' || rel === '') rel = '/index.html'
    // Block path traversal; resolve literally (no clean-URL rewriting).
    const path = normalize(join(ROOT, rel))
    if (!path.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return }
    // If it's a directory, serve its index.html.
    let target = path
    try { if ((await stat(path)).isDirectory()) target = join(path, 'index.html') } catch { /* fall through to 404 */ }
    const buf = await readFile(target)
    res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    // Cross-origin isolation for SuperSonic's AudioWorklet/WASM (SharedArrayBuffer).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch {
    res.statusCode = 404
    res.end('404 — not found')
  }
})

// Auto-advance past an occupied port (e.g. another project's dev server) so the
// dashboards never silently end up served by something else.
function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`  port ${port} in use, trying ${port + 1}…`)
      listen(port + 1, attemptsLeft - 1)
    } else {
      console.error(err.message)
      process.exit(1)
    }
  })
  server.listen(port, () => {
    console.log(`Parity dashboards served at http://localhost:${port}/  (Ctrl+C to stop)`)
    console.log(`  overview: http://localhost:${port}/index.html`)
  })
}
listen(PORT, 20)
