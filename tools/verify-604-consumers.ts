/**
 * #604 / SV80 — re-verify a SIMPLIFIED consumer still PLAYS (Level-3, SV79).
 *
 * After dropping the per-consumer SuperSonic-import / asset-hosting / warm-up
 * workarounds, this drives the REAL dashboard page (test_results/community.html
 * + the simplified audio-controls.js + the same-origin self-contained
 * spw-engine.mjs) in a real browser: click Run, then OBSERVE that the shared
 * engine reaches hasAudio=true + transpilerReady=true and the button flips to
 * the 'playing' state. The engine self-loads SuperSonic / tree-sitter /
 * rand-stream from the CDN — the served dir holds only the engine bundle.
 *
 * Headed chromium (SuperSonic's CDN import hangs in headless_shell). We serve
 * test_results/ ourselves with the cross-origin-isolation headers SuperSonic's
 * AudioWorklet needs (a hosting requirement; Vercel sets these in production).
 *
 * Usage:
 *   npx tsx tools/verify-604-consumers.ts [page.html]   (default community.html)
 *   SPW_URL=http://localhost:5173/docs/getting-started SPW_SELECTOR=.spw-btn \
 *     npx tsx tools/verify-604-consumers.ts             (external URL, e.g. docs)
 * Exit 0 = PASS. Run `npm run dashboard:audio` first to (re)build spw-engine.mjs.
 */
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ROOT = join(root, 'test_results')
const pageName = process.argv[2] ?? 'community.html'
const EXTERNAL_URL = process.env.SPW_URL // e.g. a running vitepress dev server
const SELECTOR = process.env.SPW_SELECTOR ?? '.spw-run' // docs uses .spw-btn

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png',
}

async function main(): Promise<number> {
  // External-URL mode (e.g. docs on a running vitepress dev server): drive it
  // directly, no static server of our own.
  if (EXTERNAL_URL) return runBrowser(EXTERNAL_URL, null)

  if (!existsSync(join(ROOT, 'spw-engine.mjs'))) {
    console.log('test_results/spw-engine.mjs missing — building it...')
    execSync('npm run dashboard:audio', { cwd: root, stdio: 'inherit' })
  }

  const server = createServer(async (req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel === '/' || rel === '') rel = '/index.html'
    const target = normalize(join(ROOT, rel))
    if (!target.startsWith(ROOT)) { res.statusCode = 403; res.end('no'); return }
    try {
      const body = await readFile(target)
      res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] || 'application/octet-stream')
      // SuperSonic's AudioWorklet/WASM needs cross-origin isolation (SAB).
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      res.end(body)
    } catch { res.statusCode = 404; res.end('not found') }
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  const url = `http://localhost:${port}/${pageName}`
  return runBrowser(url, server)
}

async function runBrowser(url: string, server: import('node:http').Server | null): Promise<number> {
  console.log(`Launching Chromium (headed) → ${url}  (selector ${SELECTOR})`)
  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const pageErrors: string[] = []
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}] ${m.text()}`) })

  await page.goto(url)
  // Click the first Run button the consumer rendered.
  await page.waitForSelector(SELECTOR, { timeout: 20000 })
  await page.click(SELECTOR)
  await page.waitForTimeout(500)
  console.log('  btnState right after click:', await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.dataset.state, SELECTOR))

  // Observe: the shared engine comes up and the button reaches 'playing'.
  const read = (a: { sel: string; reached: boolean }) => {
    const e = (window as { __spwEngine?: { hasAudio?: boolean; transpilerReady?: boolean } }).__spwEngine
    const btn = document.querySelector(a.sel) as HTMLElement | null
    const err = document.querySelector('.spw-error') as HTMLElement | null
    return { reached: a.reached, hasAudio: e?.hasAudio, transpilerReady: e?.transpilerReady, btnState: btn?.dataset.state, errText: err?.textContent || null }
  }
  let state: Record<string, unknown> = { reached: false }
  try {
    await page.waitForFunction((sel) => {
      const e = (window as { __spwEngine?: { hasAudio?: boolean } }).__spwEngine
      const btn = document.querySelector(sel) as HTMLElement | null
      return !!e && e.hasAudio === true && btn?.dataset.state === 'playing'
    }, SELECTOR, { timeout: 60000 })
    state = await page.evaluate(read, { sel: SELECTOR, reached: true })
  } catch {
    state = await page.evaluate(read, { sel: SELECTOR, reached: false })
  }

  await page.waitForTimeout(1200) // let it actually play (audible in headed mode)
  await browser.close()
  if (server) await new Promise<void>((r) => server.close(() => r()))

  console.log('\n=== consumer observation ===')
  console.log(JSON.stringify(state, null, 2))
  console.log('pageerrors:', pageErrors.length, pageErrors)

  const ok = state.reached === true && state.hasAudio === true && pageErrors.length === 0
  console.log(ok ? `\n✅ PASS — consumer plays through the simplified glue.` : `\n❌ FAIL — consumer did not reach playing.`)
  return ok ? 0 : 1
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1) })
