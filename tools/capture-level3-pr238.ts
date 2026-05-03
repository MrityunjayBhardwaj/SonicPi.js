#!/usr/bin/env tsx
/**
 * Level-3 acceptance gates for PR #238 (Tier B PR #3 — issue #236).
 *
 *   1. live_audio :name, :stop — WAV first half audible, second half silent.
 *      Mic permission auto-granted via Chromium fake-mic flags so the synthetic
 *      sine wave passes through live_audio's pipeline.
 *
 *   2. load_example(:name) — buffer text replaced with the example's source +
 *      audio captured AFTER the host stop+handlePlay completes (the prior
 *      capture failed because Rec was clicked before the bridge had attached
 *      to the new audio node).
 *
 * Reads BASE_URL from env, defaults to http://localhost:5173.
 *
 * Usage:
 *   BASE_URL=http://localhost:5174 npx tsx tools/capture-level3-pr238.ts
 */
import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = resolve('.captures/level3-pr238')
mkdirSync(OUT_DIR, { recursive: true })

interface WavStats { duration: number; peak: number; rms: number }

function analyzeWav(buf: Buffer, sliceStartSec = 0, sliceEndSec?: number): WavStats {
  // RIFF/WAVE — fmt @ offset 12, data chunk after.
  const sampleRate = buf.readUInt32LE(24)
  const numChannels = buf.readUInt16LE(22)
  const bitsPerSample = buf.readUInt16LE(34)
  // Find 'data' chunk.
  let dataOffset = 12
  while (dataOffset < buf.length - 8) {
    const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4)
    const chunkSize = buf.readUInt32LE(dataOffset + 4)
    if (chunkId === 'data') {
      dataOffset += 8
      const totalSamples = chunkSize / (bitsPerSample / 8) / numChannels
      const totalDuration = totalSamples / sampleRate
      const startSample = Math.floor(sliceStartSec * sampleRate)
      const endSample = sliceEndSec != null
        ? Math.min(Math.floor(sliceEndSec * sampleRate), totalSamples)
        : totalSamples
      let peak = 0
      let sumSq = 0
      let count = 0
      const bytesPerSample = bitsPerSample / 8
      for (let i = startSample; i < endSample; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const offset = dataOffset + (i * numChannels + ch) * bytesPerSample
          let s = 0
          if (bitsPerSample === 16) s = buf.readInt16LE(offset) / 32768
          else if (bitsPerSample === 32) s = buf.readFloatLE(offset)
          peak = Math.max(peak, Math.abs(s))
          sumSq += s * s
          count++
        }
      }
      return { duration: totalDuration, peak, rms: Math.sqrt(sumSq / count) }
    }
    dataOffset += 8 + chunkSize
  }
  return { duration: 0, peak: 0, rms: 0 }
}

async function setupPage(browser: import('@playwright/test').Browser, label: string) {
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [${label} console error] ${msg.text().slice(0, 200)}`)
  })

  // Intercept blob downloads — Recorder creates <a href="blob:..."> + clicks.
  await page.addInitScript(() => {
    const origClick = HTMLAnchorElement.prototype.click
    ;(window as any).__capturedWavBlob = null
    HTMLAnchorElement.prototype.click = function () {
      if (this.href?.startsWith('blob:') && this.download?.endsWith('.wav')) {
        fetch(this.href).then(r => r.blob()).then(b => { (window as any).__capturedWavBlob = b })
      } else {
        origClick.call(this)
      }
    }
  })

  await page.goto(BASE_URL)
  await page.waitForFunction(() => !!document.querySelector('#app'), { timeout: 10000 })
  await page.waitForTimeout(500)
  return page
}

async function setEditorAndRun(page: import('@playwright/test').Page, code: string) {
  // CodeMirror — focus, select all, type
  const editor = page.locator('.cm-content').first()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(code)
  // The Run button label changes to "Update" once playing — match either.
  const runBtn = page.locator('.spw-btn-label').filter({ hasText: /^(Run|Update)$/ }).first()
  await runBtn.click()
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 10000 }
  ).catch(() => {})
}

async function recordFor(page: import('@playwright/test').Page, durationMs: number): Promise<Buffer | null> {
  await page.evaluate(() => { (window as any).__capturedWavBlob = null })
  const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
  await recBtn.click()
  await page.waitForTimeout(durationMs)
  // Stop — button now reads "Save"
  const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
  if (await saveBtn.count() > 0) {
    await saveBtn.click()
  } else {
    await recBtn.click()
  }
  await page.waitForTimeout(2500)
  const wavBase64 = await page.evaluate(async () => {
    const blob = (window as any).__capturedWavBlob as Blob | null
    if (!blob) return null
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    const cs = 8192
    for (let i = 0; i < bytes.length; i += cs) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)))
    }
    return btoa(binary)
  })
  return wavBase64 ? Buffer.from(wavBase64, 'base64') : null
}

async function readEditor(page: import('@playwright/test').Page): Promise<string> {
  return await page.evaluate(() => {
    const lines = document.querySelectorAll('.cm-content .cm-line')
    return Array.from(lines).map(l => l.textContent ?? '').join('\n')
  })
}

async function testLiveAudioStop() {
  console.log('\n=== TEST 1: live_audio :name, :stop ===')
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',     // auto-grant mic permission
      '--use-fake-device-for-media-stream', // synthetic mic source (sine wave)
    ],
  })
  const page = await setupPage(browser, 'live_audio')

  // Start live_audio :guitar, then 2s later stop it. Capture window covers
  // both halves: first 2s should be audible (fake mic sine), last 2s silent.
  const code = `live_audio :guitar\nsleep 2\nlive_audio :guitar, :stop\nsleep 2\n`
  await setEditorAndRun(page, code)
  await page.waitForTimeout(800) // let engine settle

  const wav = await recordFor(page, 4000) // record the full 4s window
  await browser.close()

  if (!wav) {
    console.log('  ✗ FAIL — no WAV captured')
    return false
  }
  const wavPath = resolve(OUT_DIR, 'live_audio_stop.wav')
  writeFileSync(wavPath, wav)

  const total = analyzeWav(wav)
  // Sliding analysis: split the captured window into two halves and compare.
  // Recording started ~800ms after engine init so the audible window inside
  // the WAV is roughly t=0..1.5s (live_audio active) then 1.5..3.5s (after :stop).
  const half = total.duration / 2
  const firstHalf = analyzeWav(wav, 0, half)
  const secondHalf = analyzeWav(wav, half)

  console.log(`  WAV: ${wavPath}`)
  console.log(`  Total:      duration=${total.duration.toFixed(2)}s  peak=${total.peak.toFixed(4)}  rms=${total.rms.toFixed(4)}`)
  console.log(`  First half:  peak=${firstHalf.peak.toFixed(4)}  rms=${firstHalf.rms.toFixed(4)}`)
  console.log(`  Second half: peak=${secondHalf.peak.toFixed(4)}  rms=${secondHalf.rms.toFixed(4)}`)

  // Acceptance: first-half RMS clearly > second-half RMS, and second half
  // is near-silent. Tolerances chosen for fake-mic + small numerical noise.
  const firstAudible = firstHalf.rms > 0.001
  const secondSilent = secondHalf.rms < firstHalf.rms * 0.3 || secondHalf.rms < 0.0005
  const pass = firstAudible && secondSilent
  console.log(`  Verdict: ${pass ? '✓ PASS' : '✗ FAIL'} — first half audible (${firstAudible}), second half silent (${secondSilent})`)
  return pass
}

async function testLoadExample() {
  console.log('\n=== TEST 2: load_example(:name) — buffer replaced + new example plays ===')
  console.log('  Tests the "already playing" path: a buzz live_loop runs first,')
  console.log('  then load_example "Basic Beat" replaces the buffer + auto-replays.')
  console.log('  TEST 3 covers the first-run path (#246 fix).')
  const browser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await setupPage(browser, 'load_example')

  // Step 1 — initial buffer is a continuous source so engine.playing = true.
  await setEditorAndRun(page, `live_loop :buzz do\n  play 60, release: 0.1, amp: 0.5\n  sleep 0.5\nend`)
  await page.waitForTimeout(1500) // let buzz play a couple beats

  const initialContent = await readEditor(page)
  const initialIsBuzz = initialContent.includes('live_loop :buzz')
  console.log(`  Initial buffer is buzz live_loop: ${initialIsBuzz ? '✓' : '✗'}`)

  // Step 2 — replace buffer with `load_example "Basic Beat"` and Run.
  // engine.playing is now true, so loadExample's stop+replay branch fires
  // and Basic Beat (a live_loop with samples) takes over.
  await setEditorAndRun(page, `load_example "Basic Beat"`)

  // Poll for buffer replacement to "Basic Beat" content.
  let editorContent = ''
  for (let i = 0; i < 40; i++) {
    editorContent = await readEditor(page)
    if (editorContent.includes('live_loop :drums') && editorContent.includes('bd_haus')) break
    await page.waitForTimeout(150)
  }
  const bufferReplaced = editorContent.includes('live_loop :drums') &&
                          editorContent.includes('bd_haus') &&
                          editorContent.includes('sn_dub')
  console.log(`  Buffer replaced to Basic Beat: ${bufferReplaced ? '✓' : '✗'}`)
  console.log(`    ${editorContent.replace(/\n/g, ' / ').slice(0, 120)}...`)

  // Wait for the host's stop+handlePlay cycle to complete and Basic Beat's
  // drums to start playing. Then record.
  await page.waitForTimeout(1500)

  const wav = await recordFor(page, 4000)
  await browser.close()

  if (!wav) {
    console.log('  ✗ FAIL — no WAV captured')
    return false
  }
  const wavPath = resolve(OUT_DIR, 'load_example.wav')
  writeFileSync(wavPath, wav)

  const stats = analyzeWav(wav)
  console.log(`  WAV: ${wavPath}`)
  console.log(`  duration=${stats.duration.toFixed(2)}s  peak=${stats.peak.toFixed(4)}  rms=${stats.rms.toFixed(4)}`)

  // Acceptance: peak > 0.01 (audible drum hits), buffer replaced.
  const audible = stats.peak > 0.01
  const pass = bufferReplaced && audible
  console.log(`  Verdict: ${pass ? '✓ PASS' : '✗ FAIL'} — buffer replaced (${bufferReplaced}), example audible (${audible})`)
  return pass
}

async function testLoadExampleFirstRun() {
  console.log('\n=== TEST 3: load_example(:name) on FIRST RUN (#246 fix) ===')
  console.log('  Engine has never played. Buffer = `load_example "Basic Beat"`.')
  console.log('  Without the fix, loadExample\'s `if (this.playing)` guard saw')
  console.log('  playing=false (set AFTER await evaluate) and silently skipped')
  console.log('  the replay. With the fix, the buffer replays unconditionally.')
  const browser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await setupPage(browser, 'load_example_first_run')

  // Step 1 — fresh app, engine never played. Run `load_example "Basic Beat"`.
  await setEditorAndRun(page, `load_example "Basic Beat"`)

  // Poll for buffer replacement to "Basic Beat" content. Longer window than
  // Test 2 because the fresh-engine init (~2-4s) happens inline.
  let editorContent = ''
  for (let i = 0; i < 80; i++) {
    editorContent = await readEditor(page)
    if (editorContent.includes('live_loop :drums') && editorContent.includes('bd_haus')) break
    await page.waitForTimeout(150)
  }
  const bufferReplaced = editorContent.includes('live_loop :drums') &&
                          editorContent.includes('bd_haus') &&
                          editorContent.includes('sn_dub')
  console.log(`  Buffer replaced to Basic Beat: ${bufferReplaced ? '✓' : '✗'}`)

  // Wait for the recursive handlePlay's evaluate + drums to start playing.
  await page.waitForTimeout(2500)

  const wav = await recordFor(page, 4000)
  await browser.close()

  if (!wav) {
    console.log('  ✗ FAIL — no WAV captured')
    return false
  }
  const wavPath = resolve(OUT_DIR, 'load_example_first_run.wav')
  writeFileSync(wavPath, wav)

  const stats = analyzeWav(wav)
  console.log(`  WAV: ${wavPath}`)
  console.log(`  duration=${stats.duration.toFixed(2)}s  peak=${stats.peak.toFixed(4)}  rms=${stats.rms.toFixed(4)}`)

  // Acceptance: peak > 0.01 (drum hits audible), buffer replaced.
  const audible = stats.peak > 0.01
  const pass = bufferReplaced && audible
  console.log(`  Verdict: ${pass ? '✓ PASS' : '✗ FAIL'} — buffer replaced (${bufferReplaced}), example audible (${audible})`)
  return pass
}

async function main() {
  const results = {
    live_audio_stop: false,
    load_example: false,
    load_example_first_run: false,
  }
  results.live_audio_stop = await testLiveAudioStop()
  results.load_example = await testLoadExample()
  results.load_example_first_run = await testLoadExampleFirstRun()

  console.log('\n=== SUMMARY ===')
  console.log(`  live_audio :stop:           ${results.live_audio_stop ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  load_example (replay):      ${results.load_example ? '✓ PASS' : '✗ FAIL'}`)
  console.log(`  load_example (first run):   ${results.load_example_first_run ? '✓ PASS' : '✗ FAIL'}`)
  process.exit((results.live_audio_stop && results.load_example && results.load_example_first_run) ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
