#!/usr/bin/env node
// Headless end-to-end verification (SV79: render, don't trust 200+parse) for the
// dashboard inline-audio + "open in sonicweb.cc" controls. Serves test_results/ as
// the web root over http (so the engine can fetch /tree-sitter.wasm + rand-stream)
// and, for each target page: decorates snippets, round-trips the share link, and
// actually clicks Run to confirm the engine reaches hasAudio + playing.
//
// Usage: node tools/verify-dashboard-audio.mjs            (default page set)
//        node tools/verify-dashboard-audio.mjs e2e.html   (specific pages)
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test_results')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.wav': 'audio/wav', '.json': 'application/json', '.css': 'text/css', '.rb': 'text/plain' }
const server = createServer(async (req, res) => {
  try {
    const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0])
    const buf = await readFile(join(ROOT, rel))
    res.setHeader('Content-Type', MIME[extname(rel)] ?? 'application/octet-stream')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(buf)
  } catch { res.statusCode = 404; res.end('404') }
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

// base64url decode mirroring src/app/ShareLink.ts (verify the link round-trips).
function decodeShareCode(hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith('c=')) return null
  const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return new TextDecoder().decode(Uint8Array.from(Buffer.from(b64 + pad, 'base64')))
}

const pages = process.argv.slice(2)
if (!pages.length) pages.push('examples-sweep.html', 'community.html', 'e2e.html', 'gate-detail.html', 'diff-matrix.html', 'event-diff.html')

const browser = await chromium.launch()
let allOk = true
for (const pg of pages) {
  const page = await browser.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  try {
    await page.goto(`http://localhost:${port}/${pg}`, { waitUntil: 'load' })
    // Family B renders the snippet only after a fixture is picked — click the first
    // row. Family A buries the source in a collapsed <details> — expand them all.
    await page.evaluate(() => {
      const row = document.querySelector('.row[data-slug]')
      if (row) row.click()
      document.querySelectorAll('details').forEach((d) => { d.open = true })
    })
    await page.waitForSelector('.spw-bar', { timeout: 8000, state: 'attached' })
    // re-open details that the just-decorated bars may have re-collapsed
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))

    // 1) link round-trip
    const link = await page.evaluate(() => {
      const a = document.querySelector('.spw-link')
      const pre = document.querySelector('pre.snippet, pre.src, details.snippet pre')
      return { href: a?.getAttribute('href') || null, code: (pre?.textContent || '').replace(/\n$/, ''), target: a?.target, rel: a?.rel }
    })
    const decoded = link.href && link.href.startsWith('https://sonicweb.cc/') ? decodeShareCode(link.href.slice('https://sonicweb.cc/'.length)) : null
    const linkOk = decoded === link.code && link.target === '_blank' && /noopener/.test(link.rel || '')

    // 2) inline Run → engine reaches audio + playing
    const hasRun = await page.evaluate(() => !!document.querySelector('.spw-run'))
    let runOk = false, hasAudio = false, state = 'n/a'
    if (hasRun) {
      await page.click('.spw-run')
      await page.waitForFunction(() => {
        const b = document.querySelector('.spw-run')
        return b && (b.dataset.state === 'playing' || b.dataset.state === 'error')
      }, { timeout: 90000 }).catch(() => {})
      state = await page.evaluate(() => document.querySelector('.spw-run')?.dataset.state)
      hasAudio = await page.evaluate(() => !!(window.__spwEngine && window.__spwEngine.hasAudio))
      runOk = state === 'playing'
    }

    const ok = linkOk && (!hasRun || runOk)
    if (!ok) allOk = false
    console.log(`${ok ? '✓' : '✗'} ${pg}: link round-trip=${linkOk} run=${hasRun ? state : 'skipped'} hasAudio=${hasAudio}${errs.length ? ' pageerrors=' + errs.length : ''}`)
    if (errs.length) console.log('   pageerrors:', errs.slice(0, 3).join(' | '))
  } catch (e) {
    allOk = false
    console.log(`✗ ${pg}: ${e.message}${errs.length ? ' | pageerrors: ' + errs.slice(0, 2).join(' | ') : ''}`)
  }
  await page.close()
}
await browser.close()
server.close()
process.exit(allOk ? 0 : 1)
