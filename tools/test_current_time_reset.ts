/**
 * #364 item 4 — verify spider_time reset bug.
 *
 * Hypothesis (per runtime.rb:120,939): desktop SP resets spider_time=0 every Run.
 * Our scheduler.audioTime is a live read of audioCtx.currentTime (monotonic,
 * never resets unless AudioContext is closed). Since stop() does NOT close the
 * AudioContext, Stop → wait → Run → current_time should return elapsed wall
 * clock since first AudioContext creation, not 0.
 *
 * Experiment:
 *   1. Open app, install __spw_engine hook (capture.ts pattern)
 *   2. Paste `puts current_time`, click Run → record V1 from printHandler
 *   3. Click Stop, wait 5s real time
 *   4. Click Run again → record V2
 *   Predicted: V2 ≈ V1 + 5  (bug confirmed)
 *   Null:      V2 ≈ V1 ≈ 0  (something resets it)
 */
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await (await browser.newContext()).newPage()
  await page.goto('http://localhost:5173')
  await page.waitForTimeout(2000)
  if (!(await page.evaluate(() => Boolean(document.querySelector('#app'))))) {
    throw new Error('Not the SonicWeb app')
  }

  // Install the engine hook BEFORE Run (capture.ts pattern, #221).
  await page.evaluate(`(function() {
    var _engine = null;
    window.__putsLog = [];
    Object.defineProperty(window, '__spw_engine', {
      configurable: true,
      get: function() { return _engine; },
      set: function(e) {
        _engine = e;
        var origPrint = e.printHandler;
        e.printHandler = function(msg) {
          window.__putsLog.push({ t: Date.now(), msg: String(msg) });
          if (origPrint) origPrint(msg);
        };
      }
    });
  })()`)

  // Paste the test code
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill('puts current_time')
  await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  const stopBtn = page.locator('.spw-btn-label:has-text("Stop")')

  // === Run #1 ===
  await runBtn.click()
  // First Run needs the engine to boot — wait for "Audio engine ready" then settle
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 30000 },
  ).catch(() => {})
  await page.waitForTimeout(1500)  // let `puts current_time` print
  const log1 = await page.evaluate(() => (window as any).__putsLog as { t: number; msg: string }[])
  await stopBtn.click()
  await page.waitForTimeout(500)

  // === Wait 5s real time ===
  console.log('\nWaiting 5s real time before Run #2 ...')
  await page.waitForTimeout(5000)

  // === Run #2 (same buffer) ===
  const splitIdx = log1.length
  await runBtn.click()
  await page.waitForTimeout(2500)  // already booted; just need the puts
  await stopBtn.click()
  await page.waitForTimeout(500)

  const log2All = await page.evaluate(() => (window as any).__putsLog as { t: number; msg: string }[])
  const log2 = log2All.slice(splitIdx)

  const extractNum = (arr: { msg: string }[]): number | null => {
    for (const p of arr) {
      const m = p.msg.match(/-?\d+\.\d+|\d+/)
      if (m) {
        const n = parseFloat(m[0])
        if (!isNaN(n)) return n
      }
    }
    return null
  }

  console.log(`\n--- Run #1 puts (${log1.length}) ---`)
  log1.forEach((p) => console.log(`  ${p.msg}`))
  console.log(`\n--- Run #2 puts (${log2.length}) ---`)
  log2.forEach((p) => console.log(`  ${p.msg}`))

  const v1 = extractNum(log1)
  const v2 = extractNum(log2)
  console.log(`\n=== RESULT ===`)
  console.log(`V1 = ${v1}`)
  console.log(`V2 = ${v2}`)
  if (v1 !== null && v2 !== null) {
    const d = v2 - v1
    console.log(`Δ  = ${d.toFixed(3)}s  (real-time gap was ~5s + 2 Runs of ~2s each)`)
    if (d > 4) console.log('⇒ BUG CONFIRMED — current_time does NOT reset on Run')
    else if (Math.abs(d) < 0.5) console.log('⇒ NO BUG — current_time resets between Runs')
    else console.log(`⇒ Inconclusive — Δ=${d.toFixed(3)} doesn't clearly match either prediction`)
  } else {
    console.log('⇒ Could not extract numeric values — check puts log above')
  }

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
