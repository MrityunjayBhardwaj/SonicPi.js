/**
 * Web engine /s_new EVENT capture (issue #446).
 *
 * The OUR side of the event-parity diff. The web engine ALREADY emits every
 * OSC message as a trace line via `SuperSonicBridge.queueMessage` →
 * `formatOscTrace` → `oscTraceHandler` → `printHandler` (SonicPiEngine.ts:256).
 * The #221 print-interception hook (mirrored from tools/capture.ts) captures
 * every `printHandler` call into an UNCAPPED `window.__capturedPuts` array —
 * unaffected by the App Console ring-buffer cap (~500 lines; bach emits
 * 1400+ /s_new). We re-parse those trace lines into the same normalized
 * `OscEvent` shape the desktop side produces, so the diff is symmetric.
 *
 * Trace format (formatOscTrace, SuperSonicBridge.ts:64):
 *   [t:1.2345] /s_new "sonic-pi-beep" 1056 0 100 {note: 60, amp: 1.0}
 *   [t:1.2345] /n_set 1056 {amp: 0}
 */

import { chromium, type Browser } from '@playwright/test'
import type { OscEvent } from './desktop-events.ts'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface WebEventCapture {
  events: OscEvent[]
  rawPuts: number
  notes: string[]
}

/** Parse one formatOscTrace line into an OscEvent, or null if it isn't one. */
export function parseTraceLine(line: string): OscEvent | null {
  const sNew = line.match(
    /^\[t:([\d.-]+)\]\s+\/s_new\s+"([^"]+)"\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+\{(.*)\}\s*$/,
  )
  if (sNew) {
    return {
      addr: '/s_new',
      synthdef: sNew[2],
      nodeId: Number(sNew[3]),
      addAction: Number(sNew[4]),
      group: Number(sNew[5]),
      params: parseParams(sNew[6]),
      tRel: Number(sNew[1]),
      raw: line,
    }
  }
  const nSet = line.match(/^\[t:([\d.-]+)\]\s+\/n_set\s+(-?\d+)\s+\{(.*)\}\s*$/)
  if (nSet) {
    return {
      addr: '/n_set',
      nodeId: Number(nSet[2]),
      params: parseParams(nSet[3]),
      tRel: Number(nSet[1]),
      raw: line,
    }
  }
  const nFree = line.match(/^\[t:([\d.-]+)\]\s+\/n_free\s+(-?\d+)/)
  if (nFree) {
    return { addr: '/n_free', nodeId: Number(nFree[2]), params: {}, tRel: Number(nFree[1]), raw: line }
  }
  return null
}

function parseParams(body: string): Record<string, number | string> {
  const params: Record<string, number | string> = {}
  if (!body.trim()) return params
  for (const pair of body.split(',')) {
    const m = pair.match(/^\s*([^:]+):\s*(.+?)\s*$/)
    if (!m) continue
    const key = m[1].trim()
    const num = Number(m[2])
    params[key] = Number.isNaN(num) ? m[2].trim() : num
  }
  return params
}

function rebase(events: OscEvent[]): OscEvent[] {
  // Anchor on the EARLIEST event (minimum tRel), not the first-in-order — the
  // trace stream is emission-ordered, not strictly time-sorted, so a
  // first-in-order anchor produces spurious negative onsets.
  const ts = events.filter((e) => e.tRel !== null).map((e) => e.tRel as number)
  if (ts.length === 0) return events
  const t0 = Math.min(...ts)
  for (const e of events) {
    if (e.tRel !== null) e.tRel = Math.round((e.tRel - t0) * 1000) / 1000
  }
  return events
}

/**
 * Run `code` in the web engine (headless Chromium) and return the parsed
 * /s_new event stream. Lean: installs only the print hook + Run; no audio
 * recording or screenshots (those belong to tools/capture.ts).
 */
export async function captureWebEvents(
  code: string,
  opts: { duration?: number } = {},
): Promise<WebEventCapture> {
  const duration = opts.duration ?? 8000
  const notes: string[] = []
  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(BASE_URL)
    await page.waitForTimeout(2000)

    const isSonicPi = await page.evaluate(() => Boolean(document.querySelector('#app')))
    if (!isSonicPi) {
      throw new Error(`${BASE_URL} is not serving the SonicPi.js app (no #app mount).`)
    }

    // Paste code
    const editor = page.locator('.cm-content, textarea').first()
    await editor.click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await editor.fill(code)
    await page.waitForTimeout(200)

    // Install the #221 uncapped print hook BEFORE Run (mirrors capture.ts).
    // Trace lines flow through printHandler, so __capturedPuts holds every
    // /s_new regardless of Console ring-buffer pruning.
    await page.evaluate(`(function() {
      var _engine = null;
      window.__capturedPuts = [];
      Object.defineProperty(window, '__spw_engine', {
        configurable: true,
        get: function() { return _engine; },
        set: function(e) {
          _engine = e;
          var origPrint = e.printHandler;
          e.printHandler = function(msg) {
            window.__capturedPuts.push(msg);
            if (origPrint) origPrint(msg);
          };
        }
      });
    })()`)

    const runBtn = page.locator('.spw-btn-label:has-text("Run")')
    await runBtn.click()
    await page
      .waitForFunction(
        () => document.querySelector('#app')?.textContent?.includes('Audio engine ready'),
        { timeout: 10000 },
      )
      .catch(() => {})
    await page.waitForTimeout(500)

    // Let the piece schedule for the capture window.
    await sleep(duration)

    const puts = (await page.evaluate(
      () => (window as unknown as { __capturedPuts?: string[] }).__capturedPuts || [],
    )) as string[]

    const events = rebase(
      puts.map(parseTraceLine).filter((e): e is OscEvent => e !== null),
    )
    notes.push(`captured ${puts.length} puts, parsed ${events.length} /s_new-family events`)
    return { events, rawPuts: puts.length, notes }
  } finally {
    if (browser) await browser.close()
  }
}
