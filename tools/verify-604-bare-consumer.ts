/**
 * #604 / SV80 acceptance harness — proves the engine is self-sufficient.
 *
 * Serves ONLY the self-contained browser bundle (dist/browser.mjs) over http
 * from a temp dir — no app, no asset hosting, no SuperSonic wiring, no warm-up
 * loop. A bare page imports the engine and does the minimum a consumer would:
 *
 *     const e = new SonicPiEngine()
 *     await e.init()
 *     await e.evaluate('play 60 ...')
 *     e.play()
 *
 * Then we OBSERVE (SV79 — render, don't infer) in a real browser:
 *   - 0 pageerrors          (the page's JS ran clean)
 *   - transpilerReady=true  (tree-sitter loaded from CDN → REAL transpile, not
 *                            the regex/"parser not available" fallback the
 *                            published library hit — the #604 regression)
 *   - evaluate() no error   (a real snippet transpiled + built)
 *   - hasAudio=true         (SuperSonic auto-loaded from CDN)
 *
 * Audio (SuperSonic) only initializes in HEADED chromium — headless_shell hangs
 * on the CDN import, the same limitation that keeps tools/capture.ts headed. So
 * we launch headed chromium by default. Pass --transpile-only to run the
 * tree-sitter/transpile half headless (firefox), skipping the audio assertion.
 *
 * Usage:
 *   npx tsx tools/verify-604-bare-consumer.ts                 # headed chromium, full
 *   npx tsx tools/verify-604-bare-consumer.ts --transpile-only # firefox headless, no audio
 *
 * Exit 0 = PASS, 1 = FAIL. Builds dist/browser.mjs first if missing.
 */
import { chromium, firefox, type Browser } from '@playwright/test'
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const transpileOnly = process.argv.includes('--transpile-only')

// A bare consumer's page: imports ONLY the engine bundle. Zero other wiring.
const PAGE = `<!doctype html><meta charset=utf-8><title>bare-604</title>
<script type="module">
  import { SonicPiEngine } from './browser.mjs'
  ;(async () => {
    const e = new SonicPiEngine()
    await e.init()
    const { error } = await e.evaluate('play 60\\nsleep 0.25\\nplay 67\\nsleep 0.25\\nplay 72')
    e.play()
    window.__result = {
      hasAudio: e.hasAudio,
      transpilerReady: e.transpilerReady,
      evalError: error ? (error.message || String(error)) : null,
    }
  })().catch((err) => { window.__result = { fatal: String(err && err.stack || err) } })
</script>`

async function main(): Promise<number> {
  // Ensure the self-contained bundle exists.
  const bundle = join(root, 'dist', 'browser.mjs')
  if (!existsSync(bundle)) {
    console.log('dist/browser.mjs missing — building it...')
    execSync('node tools/build-browser-bundle.mjs', { cwd: root, stdio: 'inherit' })
  }

  // Stage a temp web root containing ONLY the page + the bundle.
  const dir = mkdtempSync(join(tmpdir(), 'spw-604-'))
  writeFileSync(join(dir, 'index.html'), PAGE)
  copyFileSync(bundle, join(dir, 'browser.mjs'))
  if (existsSync(bundle + '.map')) copyFileSync(bundle + '.map', join(dir, 'browser.mjs.map'))

  // Minimal static server with the cross-origin-isolation headers SuperSonic's
  // AudioWorklet/WASM needs (SharedArrayBuffer). A bare consumer must also send
  // these — they are a hosting requirement, not engine wiring.
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const file = join(dir, url === '/' ? 'index.html' : url.slice(1))
    try {
      const body = readFileSync(file)
      const type = file.endsWith('.html') ? 'text/html'
        : file.endsWith('.mjs') ? 'text/javascript'
        : file.endsWith('.map') ? 'application/json' : 'application/octet-stream'
      res.setHeader('Content-Type', type)
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  const baseURL = `http://localhost:${port}/`

  let browser: Browser
  if (transpileOnly) {
    console.log('Launching Firefox (headless, transpile-only — no audio)...')
    browser = await firefox.launch({ headless: true })
  } else {
    console.log('Launching Chromium (headed, audio) ...')
    browser = await chromium.launch({
      headless: false,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
  }

  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto(baseURL)

  // Wait for the bare page to finish init + first evaluate (CDN fetches + WASM).
  let result: Record<string, unknown> | null = null
  try {
    await page.waitForFunction(() => (window as { __result?: unknown }).__result !== undefined, { timeout: 60000 })
    result = await page.evaluate(() => (window as { __result?: Record<string, unknown> }).__result ?? null)
  } catch {
    result = { fatal: 'timed out waiting for engine init/evaluate (window.__result never set)' }
  }

  if (!transpileOnly) {
    // Let it actually play for a moment (audible in headed mode).
    await page.waitForTimeout(1500)
  }
  await browser.close()
  await new Promise<void>((r) => server.close(() => r()))

  // ---- verdict ----
  console.log('\n=== bare-consumer result ===')
  console.log(JSON.stringify(result, null, 2))
  console.log('pageerrors:', pageErrors.length, pageErrors)
  if (consoleErrors.length) console.log('console.errors:', consoleErrors)

  const fails: string[] = []
  if (!result || result.fatal) fails.push(`fatal: ${result?.fatal ?? 'no result'}`)
  if (pageErrors.length) fails.push(`${pageErrors.length} pageerror(s)`)
  if (result && result.evalError) fails.push(`evaluate error: ${result.evalError}`)
  if (result && result.transpilerReady !== true) fails.push('transpilerReady !== true (real transpile failed — regex/parser-not-available fallback)')
  if (!transpileOnly && result && result.hasAudio !== true) fails.push('hasAudio !== true (SuperSonic did not auto-load)')

  if (fails.length === 0) {
    console.log(`\n✅ PASS — bare consumer self-sufficient${transpileOnly ? ' (transpile-only)' : ' (transpile + audio)'}.`)
    return 0
  }
  console.log('\n❌ FAIL:\n - ' + fails.join('\n - '))
  return 1
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1) })
