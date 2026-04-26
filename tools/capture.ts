/**
 * Browser capture tool — runs Sonic Pi code in the real app via Playwright,
 * captures everything the browser produces, dumps it to .captures/ for
 * Claude to read and diagnose.
 *
 * This is an observation tool, not a test. Zero assertions.
 * It captures what IS, not what should be.
 *
 * Usage:
 *   npx tsx tools/capture.ts                          # run default example
 *   npx tsx tools/capture.ts "play 60; sleep 1"       # run inline code
 *   npx tsx tools/capture.ts --file path/to/code.rb   # run from file
 *   npx tsx tools/capture.ts --example "Minimal Techno"  # run built-in example
 *   npx tsx tools/capture.ts --all-examples            # run all built-in examples
 *   npx tsx tools/capture.ts --duration 15000          # run for 15 seconds
 */

import { chromium, firefox, type Browser } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const DEFAULT_DURATION = 8000

// ---------------------------------------------------------------------------
// Capture everything the browser produces
// ---------------------------------------------------------------------------

interface CaptureResult {
  timestamp: string
  code: string
  duration: number
  url: string
  browser: string

  // Everything from the browser
  console: { type: string; text: string; time: number }[]
  pageErrors: { message: string; time: number }[]
  networkErrors: { url: string; status: number; time: number }[]
  appConsoleText: string
  appFullText: string

  // Screenshots
  screenshotBefore: string  // path
  screenshotAfter: string   // path

  // Audio capture (WAV file)
  audioPath: string | null
  audioStats: { duration: number; peak: number; rms: number; clipping: number } | null

  // Derived
  errorSummary: string[]
  warningsSummary: string[]
}

async function captureRun(
  browser: Browser,
  code: string,
  opts: { duration?: number; name?: string } = {}
): Promise<CaptureResult> {
  const duration = opts.duration ?? DEFAULT_DURATION
  const name = opts.name ?? 'capture'
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = `${ts}_${safeName}`

  const context = await browser.newContext({
    acceptDownloads: true,
  })
  const page = await context.newPage()

  const consoleLog: CaptureResult['console'] = []
  const pageErrors: CaptureResult['pageErrors'] = []
  const networkErrors: CaptureResult['networkErrors'] = []
  const t0 = Date.now()

  // Capture ALL console messages (not just errors)
  page.on('console', (msg) => {
    consoleLog.push({
      type: msg.type(),
      text: msg.text(),
      time: Date.now() - t0,
    })
  })

  // Capture uncaught page errors
  page.on('pageerror', (err) => {
    pageErrors.push({
      message: err.message,
      time: Date.now() - t0,
    })
  })

  // Capture failed network requests
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      networkErrors.push({
        url: resp.url(),
        status: resp.status(),
        time: Date.now() - t0,
      })
    }
  })

  // Load app
  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  // Sanity-check: the dev server at BASE_URL is actually SonicPi.js (not some
  // other app on the same port). The app's root mount is `#app`; a foreign
  // app mounted at `#root` will time out the editor selector below with a
  // confusing "locator timed out" message. Issue #214.
  const isSonicPi = await page.evaluate(() => Boolean(document.querySelector('#app')))
  if (!isSonicPi) {
    const title = await page.title()
    throw new Error(
      `[capture] ${BASE_URL} is not serving the SonicPi.js app (page title: "${title}", no #app mount node). ` +
      `Set BASE_URL=http://localhost:PORT (or run \`npm run dev\` in this repo first) and retry.`
    )
  }

  // Screenshot before running
  const beforePath = resolve(CAPTURES_DIR, `${prefix}_before.png`)
  await page.screenshot({ path: beforePath, fullPage: true })

  // Paste code into editor
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  // Click Run and wait for audio engine to be ready
  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()
  // Wait for "Audio engine ready" in the app text
  await page.waitForFunction(
    () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
    { timeout: 10000 }
  ).catch(() => {})
  await page.waitForTimeout(500)

  // Start audio recording via Rec button (Chromium captures real audio)
  let audioPath: string | null = null
  const isChromium = browser.browserType().name() === 'chromium'
  if (isChromium) {
    // Intercept blob download — Recorder creates <a href="blob:..."> and clicks it
    await page.evaluate(() => {
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

    const recBtn = page.locator('button').filter({ hasText: 'Rec' }).first()
    const hasRec = await recBtn.count()
    if (hasRec > 0) {
      await recBtn.click()
      await page.waitForTimeout(duration - 1000)
      // Stop recording — button now says "Save"
      const saveBtn = page.locator('button').filter({ hasText: 'Save' }).first()
      const hasSave = await saveBtn.count()
      if (hasSave > 0) {
        await saveBtn.click()
      } else {
        await recBtn.click()
      }
      await page.waitForTimeout(2000) // wait for blob to be captured

      // Extract the captured WAV blob
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

      if (wavBase64) {
        audioPath = resolve(CAPTURES_DIR, `${prefix}_audio.wav`)
        writeFileSync(audioPath, Buffer.from(wavBase64, 'base64'))
      }
    } else {
      await page.waitForTimeout(duration - 1000)
    }
  } else {
    // Firefox: just wait (no reliable audio capture in headless)
    await page.waitForTimeout(duration)
  }

  // Screenshot after running
  const afterPath = resolve(CAPTURES_DIR, `${prefix}_after.png`)
  await page.screenshot({ path: afterPath, fullPage: true })

  // Capture app state
  const appFullText = await page.locator('#app').textContent() ?? ''

  // Try to isolate the console pane text (everything after "Audio engine ready" or "Happy live coding")
  let appConsoleText = ''
  const consoleStart = appFullText.indexOf('Happy live coding!')
  if (consoleStart >= 0) {
    appConsoleText = appFullText.slice(consoleStart)
  } else {
    const altStart = appFullText.indexOf('Audio engine ready')
    if (altStart >= 0) appConsoleText = appFullText.slice(altStart)
  }

  // Stop
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  await context.close()

  // Derive error/warning summaries
  const errorSummary: string[] = []
  const warningsSummary: string[] = []

  for (const e of pageErrors) {
    if (!e.message.includes('Aborted') && !e.message.includes('h1-check'))
      errorSummary.push(`[pageerror @ ${e.time}ms] ${e.message}`)
  }
  for (const c of consoleLog) {
    if (c.type === 'error') errorSummary.push(`[console.error @ ${c.time}ms] ${c.text}`)
    if (c.type === 'warning') warningsSummary.push(`[console.warn @ ${c.time}ms] ${c.text}`)
  }
  for (const n of networkErrors) {
    errorSummary.push(`[network ${n.status} @ ${n.time}ms] ${n.url}`)
  }

  // Check app console for runtime errors
  const runtimePatterns = [
    'not a function', 'not defined', 'Something went wrong',
    'Error in loop', "isn't available", 'SyntaxError', 'TypeError',
    'ReferenceError', 'Unexpected token',
  ]
  for (const pattern of runtimePatterns) {
    if (appConsoleText.includes(pattern)) {
      const idx = appConsoleText.indexOf(pattern)
      const context = appConsoleText.slice(Math.max(0, idx - 80), idx + 150).trim()
      errorSummary.push(`[app console] ...${context}...`)
    }
  }

  // Analyze captured audio if available
  let audioStats: CaptureResult['audioStats'] = null
  if (audioPath) {
    try {
      const wavBuf = readFileSync(audioPath)
      // Parse WAV header: offset 24 = sampleRate, offset 34 = bitsPerSample
      const sampleRate = wavBuf.readUInt32LE(24)
      const bitsPerSample = wavBuf.readUInt16LE(34)
      const numChannels = wavBuf.readUInt16LE(22)
      const dataOffset = 44
      const bytesPerSample = bitsPerSample / 8
      const numSamples = Math.floor((wavBuf.length - dataOffset) / (numChannels * bytesPerSample))

      let sumSq = 0
      let peak = 0
      let clipCount = 0
      for (let i = 0; i < numSamples; i++) {
        const off = dataOffset + i * numChannels * bytesPerSample
        const val = wavBuf.readInt16LE(off) / 32768.0
        sumSq += val * val
        const a = Math.abs(val)
        if (a > peak) peak = a
        if (a > 0.95) clipCount++
      }
      const rms = Math.sqrt(sumSq / numSamples)
      audioStats = {
        duration: numSamples / sampleRate,
        peak: Math.round(peak * 10000) / 10000,
        rms: Math.round(rms * 10000) / 10000,
        clipping: Math.round((clipCount / numSamples) * 10000) / 100,
      }
    } catch { /* WAV parse failed — skip stats */ }
  }

  return {
    timestamp: new Date().toISOString(),
    code,
    duration,
    url: BASE_URL,
    browser: browser.browserType().name(),
    console: consoleLog,
    pageErrors,
    networkErrors,
    appConsoleText,
    appFullText,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
    audioPath,
    audioStats,
    errorSummary,
    warningsSummary,
  }
}

// ---------------------------------------------------------------------------
// Write capture to readable markdown
// ---------------------------------------------------------------------------

function writeCaptureReport(result: CaptureResult, outputPath: string): void {
  const lines: string[] = []

  lines.push(`# Browser Capture: ${result.timestamp}`)
  lines.push('')
  lines.push(`- **Browser:** ${result.browser}`)
  lines.push(`- **URL:** ${result.url}`)
  lines.push(`- **Duration:** ${result.duration}ms`)
  lines.push(`- **Screenshots:** before: \`${result.screenshotBefore}\`, after: \`${result.screenshotAfter}\``)
  lines.push('')

  // Code
  lines.push('## Code')
  lines.push('```ruby')
  lines.push(result.code)
  lines.push('```')
  lines.push('')

  // Errors (the important part)
  lines.push('## Errors')
  if (result.errorSummary.length === 0) {
    lines.push('None.')
  } else {
    for (const e of result.errorSummary) {
      lines.push(`- ${e}`)
    }
  }
  lines.push('')

  // Warnings
  lines.push('## Warnings')
  if (result.warningsSummary.length === 0) {
    lines.push('None.')
  } else {
    for (const w of result.warningsSummary) {
      lines.push(`- ${w}`)
    }
  }
  lines.push('')

  // Audio capture
  if (result.audioPath) {
    lines.push('## Audio Capture')
    lines.push(`- **File:** \`${result.audioPath}\``)
    if (result.audioStats) {
      const s = result.audioStats
      lines.push(`- **Duration:** ${s.duration.toFixed(2)}s`)
      lines.push(`- **Peak:** ${s.peak}`)
      lines.push(`- **RMS:** ${s.rms}`)
      lines.push(`- **Clipping (>0.95):** ${s.clipping}%`)
      if (s.clipping > 1) lines.push(`- ⚠ **High clipping** — limiter may not be active`)
      if (s.rms > 0.3) lines.push(`- ⚠ **Loud output** — RMS ${s.rms} (original Sonic Pi ≈ 0.19)`)
      if (s.peak < 0.01) lines.push(`- ⚠ **Silent output** — no audio captured`)
    }
    lines.push('')
  }

  // App console (the real diagnostic gold)
  lines.push('## App Console Output')
  lines.push('```')
  lines.push(result.appConsoleText || '(empty)')
  lines.push('```')
  lines.push('')

  // Browser console (verbose, for deep debugging)
  lines.push('## Browser Console (all messages)')
  lines.push('```')
  for (const c of result.console) {
    lines.push(`[${c.type}] (${c.time}ms) ${c.text}`)
  }
  if (result.console.length === 0) lines.push('(empty)')
  lines.push('```')
  lines.push('')

  // Page errors
  if (result.pageErrors.length > 0) {
    lines.push('## Uncaught Page Errors')
    for (const e of result.pageErrors) {
      lines.push(`- (${e.time}ms) ${e.message}`)
    }
    lines.push('')
  }

  // Network errors
  if (result.networkErrors.length > 0) {
    lines.push('## Network Errors')
    for (const n of result.networkErrors) {
      lines.push(`- ${n.status} ${n.url} (${n.time}ms)`)
    }
    lines.push('')
  }

  writeFileSync(outputPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  mkdirSync(CAPTURES_DIR, { recursive: true })

  let code = ''
  let name = 'default'
  let duration = DEFAULT_DURATION
  let runAllExamples = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') {
      const filePath = args[++i]
      code = readFileSync(filePath, 'utf-8')
      name = filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'file'
    } else if (args[i] === '--duration') {
      duration = parseInt(args[++i])
    } else if (args[i] === '--all-examples') {
      runAllExamples = true
    } else if (args[i] === '--example') {
      name = args[++i]
      // Will be loaded from the app's example selector
    } else if (!args[i].startsWith('--')) {
      code = args[i]
      name = 'inline'
    }
  }

  // Default code if nothing specified
  if (!code && !runAllExamples) {
    code = `live_loop :test do
  play [:c4, :e4, :g4].choose
  sleep 0.5
end

live_loop :beat do
  sample :bd_haus
  sleep 1
end`
    name = 'default_test'
  }

  // Use Chromium headed by default — captures real audio via Rec button.
  // Firefox fallback: --firefox flag for headless event-only capture.
  const useFirefox = args.includes('--firefox')
  console.log(`Launching ${useFirefox ? 'Firefox (headless)' : 'Chromium (headed, audio capture)'}...`)
  const browser = useFirefox
    ? await firefox.launch({ headless: true })
    : await chromium.launch({
        headless: false,
        args: ['--autoplay-policy=no-user-gesture-required'],
      })

  if (runAllExamples) {
    // Run each built-in example
    const examples = [
      { name: 'Hello Beep', code: 'play 60\nsleep 1\nplay 64\nsleep 1\nplay 67' },
      { name: 'Basic Beat', code: 'live_loop :drums do\n  sample :bd_haus\n  sleep 0.5\n  sample :sn_dub\n  sleep 0.5\nend' },
      { name: 'Random Melody', code: 'use_random_seed 42\nlive_loop :melody do\n  use_synth :pluck\n  play scale(:c4, :minor_pentatonic).choose, release: 0.3\n  sleep 0.25\nend' },
      { name: 'Minimal Techno', code: 'use_bpm 130\n\nlive_loop :kick do\n  sample :bd_haus, amp: 1.5\n  sleep 1\nend\n\nlive_loop :hats do\n  pattern = spread(7, 16)\n  16.times do |i|\n    sample :hat_snap, amp: 0.4 if pattern[i]\n    sleep 0.25\n  end\nend\n\nlive_loop :acid do\n  use_synth :tb303\n  notes = ring(:e2, :e2, :e3, :e2, :g2, :e2, :a2, :e2)\n  play notes.tick, release: 0.2, cutoff: rrand(40, 120), res: 0.3\n  sleep 0.25\nend' },
    ]

    const summaryLines: string[] = ['# Capture Summary\n']

    for (const ex of examples) {
      console.log(`  Running: ${ex.name}...`)
      const result = await captureRun(browser, ex.code, { duration, name: ex.name })
      const reportPath = resolve(CAPTURES_DIR, `${ex.name.replace(/\s+/g, '_')}.md`)
      writeCaptureReport(result, reportPath)

      const status = result.errorSummary.length === 0 ? 'OK' : `${result.errorSummary.length} errors`
      summaryLines.push(`- **${ex.name}**: ${status} → \`${reportPath}\``)
      if (result.errorSummary.length > 0) {
        for (const e of result.errorSummary) {
          summaryLines.push(`  - ${e}`)
        }
      }
    }

    const summaryPath = resolve(CAPTURES_DIR, 'SUMMARY.md')
    writeFileSync(summaryPath, summaryLines.join('\n'))
    console.log(`\nSummary: ${summaryPath}`)
  } else {
    console.log(`  Running: ${name} (${duration}ms)...`)
    const result = await captureRun(browser, code, { duration, name })
    const reportPath = resolve(CAPTURES_DIR, `${name}.md`)
    writeCaptureReport(result, reportPath)

    console.log(`\nCapture saved: ${reportPath}`)
    if (result.errorSummary.length > 0) {
      console.log(`\nErrors found:`)
      for (const e of result.errorSummary) {
        console.log(`  ${e}`)
      }
    } else {
      console.log('No errors detected.')
    }
  }

  await browser.close()
}

main().catch((err) => {
  console.error('Capture failed:', err)
  process.exit(1)
})
