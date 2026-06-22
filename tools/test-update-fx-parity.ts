/**
 * Playwright + Chromium reproducer for the "Update modifies the music" bug.
 *
 * Drives the real app:
 *   1. Paste a snippet that uses top-level `with_fx` wrappers + non-FX loops
 *   2. Click Run, record WAV (A — baseline)
 *   3. Click Update (no code change), record WAV (B — post-hot-swap)
 *   4. Band-energy comparison: every frequency band should track A vs B (~1.0x).
 *      A surviving collapse in 500-2000Hz proves FX-wrapped loops are losing
 *      their FX wiring on hot-swap (hetvabhasa-style: persistentFx state +
 *      loopFxScope/fxScopeChains repopulation ordering).
 *
 * Why a dedicated test, not unit:
 *   The bug only manifests as audio at the WAV level — unit tests for
 *   evaluate() would not catch it because they verify the asyncFn shape but
 *   not the actual FX bus routing in scsynth (FATALITY BOUNDARY B2).
 *
 * Usage:
 *   npx tsx tools/test-update-fx-parity.ts
 *   npx tsx tools/test-update-fx-parity.ts --headed
 *   BASE_URL=http://localhost:5173 npx tsx tools/test-update-fx-parity.ts
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, '.captures/update-fx-parity')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const HEADED = process.argv.includes('--headed')
const RECORD_DURATION_MS = 6000   // each capture window
const POST_UPDATE_SETTLE_MS = 500 // let the swap complete before recording starts

// The exact code that triggered the user-reported bug. Six top-level FX-wrapped
// live_loops + 2 unwrapped (kick, hhc2) + 1 metronome (met1).
// If the bug is real, kicks survive Update; FX-routed loops lose their FX-wet
// content. This is the L3 observation contract.
const SNIPPET = `use_bpm 130
live_loop :met1 do
  sleep 1
end
cmaster1 = 130
cmaster2 = 130
define :pattern do |pattern|
  return pattern.ring.tick == "x"
end
live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern "x--x--x---x--x--"
  sleep 0.25
end
with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sleep 1
    end
  end
end
with_fx :reverb, mix: 0.2 do
  with_fx :panslicer, mix: 0.2 do
    live_loop :hhc1, sync: :met1 do
      a = 0.75
      sample :drum_cymbal_closed, amp: a, rate: 2.5, finish: 0.5, cutoff: cmaster2 if pattern "x-x-x-x-x-x-x-x-"
      sleep 0.125
    end
  end
end
with_fx :panslicer, mix: 0.4 do
  with_fx :reverb, mix: 0.75 do
    live_loop :synthbass, sync: :met1 do
      use_synth :tech_saws
      play :g3, sustain: 6, cutoff: 60, amp: 0.75, attack: 0
      sleep 6
      play :d3, sustain: 2, cutoff: 60, amp: 0.75, attack: 0
      sleep 2
    end
  end
end
`

mkdirSync(OUT_DIR, { recursive: true })

interface CaptureCtx {
  page: import('@playwright/test').Page
}

/** Install the WAV-blob interceptor BEFORE any Rec click. Mirrors capture.ts.
 *  We re-install per capture window so __capturedWavBlob is null at start. */
async function installWavInterceptor(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    ;(window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob = null
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.href?.startsWith('blob:') && this.download?.endsWith('.wav')) {
        fetch(this.href).then(r => r.blob()).then(b => {
          ;(window as unknown as { __capturedWavBlob: Blob }).__capturedWavBlob = b
        })
      } else {
        origClick.call(this)
      }
    }
  })
}

/** Click Rec, wait `duration`, click Save. Returns the captured WAV bytes. */
async function recordWindow(page: import('@playwright/test').Page, durationMs: number, label: string): Promise<Buffer> {
  await installWavInterceptor(page)

  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  await recBtn.click()
  await page.waitForTimeout(durationMs)

  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) {
    await saveBtn.click()
  } else {
    // Some app states keep the Rec button text — toggle it again to stop
    await recBtn.click()
  }
  await page.waitForTimeout(1500) // blob flush + WAV encode margin

  const b64 = await page.evaluate(async () => {
    const blob = (window as unknown as { __capturedWavBlob: Blob | null }).__capturedWavBlob
    if (!blob) return null
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let s = ''
    const cs = 8192
    for (let i = 0; i < bytes.length; i += cs) {
      s += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
    }
    return btoa(s)
  })

  if (!b64) throw new Error(`[${label}] no WAV blob captured — Recorder didn't fire or button selector missed`)
  return Buffer.from(b64, 'base64')
}

async function main() {
  console.log('[update-fx-parity] launching chromium', HEADED ? '(headed)' : '(headless)')
  const browser = await chromium.launch({ headless: !HEADED })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Surface anything the app crashes with so we don't silently capture silence
  page.on('pageerror', err => console.error('[page error]', err.message))
  page.on('console', m => {
    if (m.type() === 'error') console.error('[console error]', m.text())
  })

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  // Sanity — same check as capture.ts
  const isSonicPi = await page.evaluate(() => Boolean(document.querySelector('#app')))
  if (!isSonicPi) {
    throw new Error(`[update-fx-parity] ${BASE_URL} doesn't look like Sonic Web (no #app mount)`)
  }

  // Paste the snippet
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(SNIPPET)
  await page.waitForTimeout(200)

  // Run
  // Same button is labeled 'Run' before play and 'Update' after — match both
  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 15000 },
  ).catch(() => {})
  // Let the loops settle into a steady rhythm before we start recording. The
  // first ~1s contains :met1 sync wait + per-loop priming; capturing during
  // that window adds noise to the comparison.
  await page.waitForTimeout(2000)

  console.log('[update-fx-parity] capturing A (first run baseline)...')
  const wavA = await recordWindow(page, RECORD_DURATION_MS, 'A')
  const wavAPath = resolve(OUT_DIR, 'A_first_run.wav')
  writeFileSync(wavAPath, wavA)
  console.log(`[update-fx-parity] wrote ${wavAPath} (${wavA.length} bytes)`)

  // CRITICAL — click Update without changing code. The hot-swap path is what
  // we're stressing. If Update was renamed to "Run" while playing, look for
  // the same Run button (the app re-uses it).
  console.log('[update-fx-parity] clicking Update (no code change)...')
  await runBtn.click()
  await page.waitForTimeout(POST_UPDATE_SETTLE_MS)

  console.log('[update-fx-parity] capturing B (after Update)...')
  const wavB = await recordWindow(page, RECORD_DURATION_MS, 'B')
  const wavBPath = resolve(OUT_DIR, 'B_after_update.wav')
  writeFileSync(wavBPath, wavB)
  console.log(`[update-fx-parity] wrote ${wavBPath} (${wavB.length} bytes)`)

  // Stop and clean up
  const stopBtn = page.locator('button').filter({ hasText: 'Stop' }).first()
  if (await stopBtn.count() > 0) await stopBtn.click()
  await browser.close()

  // Run band comparison
  console.log('\n[update-fx-parity] running band-energy comparison...\n')
  const py = spawnSync('python3', [resolve(__dirname, 'compare-update-bands.py'), wavAPath, wavBPath], {
    stdio: 'inherit',
  })
  process.exit(py.status ?? 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
