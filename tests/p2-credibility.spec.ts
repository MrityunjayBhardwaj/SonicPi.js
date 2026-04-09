/**
 * P2 credibility E2E tests — PR #166.
 *
 * Automated Playwright coverage for the 4 P2 features so they can be verified
 * without MIDI hardware or a real microphone:
 *
 *   #149 use_real_time       — smoke test: runs inside live_loop without crashing
 *   #150 wildcard sync/cue   — * and ? match globs, exact non-match never fires
 *   #151 MIDI cue path dual  — /midi:*:ch/type AND /midi/type both resolve from one event
 *   #152 sound_in mic input  — synth :sound_in triggers getUserMedia, routes to worklet
 *
 * Strategy
 * --------
 * - Chromium is required: Web MIDI API is Chromium-only, and we stub
 *   `navigator.requestMIDIAccess` + `navigator.mediaDevices.getUserMedia`
 *   in addInitScript so the tests run with zero hardware.
 * - The Web MIDI mock returns one fake input "Mock MIDI Keyboard" and
 *   exposes `window.__fireMidi([status, data1, data2])` to synthesise
 *   incoming messages. It also exposes `window.__midiListenerCount()` so
 *   we can assert the bridge actually wired a listener.
 * - The getUserMedia mock returns a silent MediaStream from a fresh
 *   AudioContext's MediaStreamDestination — real enough that
 *   createMediaStreamSource in the app doesn't throw.
 * - MIDI tests drive the real UI to call MidiBridge.selectInput (there is
 *   no public JS hook on the engine), by clicking the MIDI toolbar button
 *   open→close→open to trigger lazy init + rebuild, then clicking the
 *   mock input row.
 *
 * These tests are Level-2 observation (events/console), not Level-3 audio
 * — they verify the feature wiring, not audio output. Audio verification
 * for sound_in would require `tools/capture.ts` + WAV analysis.
 */
import { test, expect, Page } from '@playwright/test'

// Browser is pinned to Chromium via the dedicated project in playwright.config.ts.

const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'

/**
 * Return just the Log-pane portion of the app text, stripping the editor
 * source and toolbar so `expect(...).not.toContain(...)` doesn't match
 * literals in the user's code.
 */
function logPaneText(fullAppText: string): string {
  const marker = 'Happy live coding!'
  const idx = fullAppText.indexOf(marker)
  return idx >= 0 ? fullAppText.slice(idx + marker.length) : fullAppText
}

// ---------------------------------------------------------------------------
// Pre-navigation stubs: Web MIDI + getUserMedia
// ---------------------------------------------------------------------------

async function installMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // ---- Web MIDI mock ---------------------------------------------------
    const listeners = new Set<(evt: { data: Uint8Array }) => void>()

    const mockInput = {
      id: 'mock-keyboard-1',
      name: 'Mock MIDI Keyboard',
      manufacturer: 'PlaywrightMock',
      type: 'input' as const,
      state: 'connected' as const,
      connection: 'open' as const,
      version: '1.0',
      onmidimessage: null as ((e: unknown) => void) | null,
      addEventListener(type: string, cb: (evt: { data: Uint8Array }) => void) {
        if (type === 'midimessage') listeners.add(cb)
      },
      removeEventListener(type: string, cb: (evt: { data: Uint8Array }) => void) {
        if (type === 'midimessage') listeners.delete(cb)
      },
      open() { return Promise.resolve(this) },
      close() { return Promise.resolve(this) },
      dispatchEvent() { return true },
    }

    const inputs = new Map<string, typeof mockInput>()
    inputs.set(mockInput.id, mockInput)
    const outputs = new Map()

    const midiAccess = {
      inputs,
      outputs,
      sysexEnabled: false,
      onstatechange: null as ((e: unknown) => void) | null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true },
    }

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: () => Promise.resolve(midiAccess),
      writable: true,
      configurable: true,
    })

    ;(window as unknown as { __fireMidi: (bytes: number[]) => number }).__fireMidi = (bytes) => {
      const evt = { data: new Uint8Array(bytes) }
      let fired = 0
      for (const cb of listeners) {
        try { cb(evt); fired++ } catch { /* don't crash on bad listener */ }
      }
      return fired
    }
    ;(window as unknown as { __midiListenerCount: () => number }).__midiListenerCount = () => listeners.size

    // ---- getUserMedia mock: silent MediaStream via MediaStreamDestination
    ;(window as unknown as { __gumCalls: string[] }).__gumCalls = []
    if (navigator.mediaDevices) {
      const mockGUM = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
        ;(window as unknown as { __gumCalls: string[] }).__gumCalls.push(JSON.stringify(constraints))
        const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
        const ctx = new Ctx()
        const dst = ctx.createMediaStreamDestination()
        // Silent source — just keeps the track alive
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        gain.gain.value = 0
        osc.connect(gain).connect(dst)
        osc.start()
        return dst.stream
      }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: mockGUM,
        writable: true,
        configurable: true,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gotoAndWaitBanner(page: Page): Promise<void> {
  await page.goto('/')
  // The startup banner is printed before the engine is lazily initialised.
  await page.waitForFunction(
    () => (document.querySelector('#app')?.textContent ?? '').includes('Happy live coding'),
    { timeout: 15000 }
  )
}

/**
 * Paste code, click Run, and wait for the engine to finish initialising
 * (the "Audio engine ready" log line) before returning. The engine is
 * created lazily on the first Run click, so CDN + scsynth setup happens here.
 */
async function runCode(page: Page, code: string): Promise<void> {
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press(selectAll)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  // Click the Run button explicitly — matches capture.ts and p0-smoke convention.
  // Keyboard shortcut (Ctrl+Enter) has intermittent focus issues in headed Chromium.
  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()

  // Engine creation is lazy — first Run click triggers CDN import + scsynth init.
  // Poll for readiness with a longer window than the default test timeout allows.
  await page.waitForFunction(
    () => (document.querySelector('#app')?.textContent ?? '').includes('Audio engine ready'),
    { timeout: 60000 }
  )
}

async function stopCode(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

/**
 * Call engine.midiBridge.init() + selectInput() directly via the globally
 * exposed `globalThis.__spw_engine` (App.ts:897 sets it for diagnostics).
 * This avoids the brittle UI dropdown dance and works regardless of the
 * toolbar's lazy-init race.
 */
async function enableMockMidiInput(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const engine = (globalThis as unknown as { __spw_engine?: {
      midiBridge: {
        init: () => Promise<boolean>
        getDevices: () => { id: string; name: string; type: string }[]
        selectInput: (id: string) => boolean
      }
    } }).__spw_engine
    if (!engine) throw new Error('__spw_engine not exposed — app did not complete engine init')
    const ok = await engine.midiBridge.init()
    if (!ok) throw new Error('midiBridge.init() returned false — mock requestMIDIAccess not installed?')
    const devices = engine.midiBridge.getDevices().filter(d => d.type === 'input')
    if (devices.length === 0) throw new Error('No mock MIDI input devices visible to bridge')
    const attached = engine.midiBridge.selectInput(devices[0].id)
    if (!attached) throw new Error(`selectInput(${devices[0].id}) returned false`)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The engine is created lazily on first Run: CDN import + scsynth init adds
// 10–40s per test on top of normal exercise time. Bump the per-test timeout
// well above the config default.
test.describe.configure({ timeout: 120_000 })

test.describe('P2 credibility (PR #166)', () => {

  test('#150 wildcard sync — * and ? match, exact non-match never fires', async ({ page }) => {
    await installMocks(page)
    await gotoAndWaitBanner(page)

    await runCode(page, `
live_loop :ticker do
  cue "/foo/bar/tick"
  sleep 0.4
end

live_loop :star_match do
  sync "/foo/*/tick"
  puts "STAR_OK"
end

live_loop :question_match do
  sync "/foo/?ar/tick"
  puts "QUESTION_OK"
end

live_loop :exact_nonmatch do
  sync "/foo/baz/tick"
  puts "EXACT_NONMATCH_FAIL"
end
`)

    await page.waitForTimeout(2500)
    const appText = await page.locator('#app').textContent() ?? ''
    await stopCode(page)

    const log = logPaneText(appText)
    expect(log).toContain('STAR_OK')
    expect(log).toContain('QUESTION_OK')
    expect(log).not.toContain('EXACT_NONMATCH_FAIL')
    expect(log).not.toContain('Error in loop')
    expect(log).not.toContain('not a function')
  })

  test('#149 use_real_time runs inside live_loop without crashing', async ({ page }) => {
    await installMocks(page)
    await gotoAndWaitBanner(page)

    // use_real_time inside a live_loop should flip schedAheadTime to 0 for
    // that task. We can't easily observe the latency change wall-clock, but
    // we can assert the keyword transpiles, runs, and the loop resumes on cue.
    await runCode(page, `
live_loop :rt do
  use_real_time
  sync "/trigger"
  puts "RT_RESUMED"
end

live_loop :driver do
  sleep 0.3
  cue "/trigger"
end
`)

    await page.waitForTimeout(2000)
    const appText = await page.locator('#app').textContent() ?? ''
    await stopCode(page)

    const log = logPaneText(appText)
    expect(log).toContain('RT_RESUMED')
    expect(log).not.toContain('Error in loop')
    expect(log).not.toContain('not a function')
    expect(log).not.toContain("isn't available")
    expect(log).not.toContain('SyntaxError')
  })

  test('#149 use_real_time at top level is a safe no-op', async ({ page }) => {
    await installMocks(page)
    await gotoAndWaitBanner(page)

    await runCode(page, `
use_real_time
live_loop :top do
  puts "TOP_LEVEL_OK"
  sleep 0.3
end
`)

    await page.waitForTimeout(1500)
    const appText = await page.locator('#app').textContent() ?? ''
    await stopCode(page)

    const log = logPaneText(appText)
    expect(log).toContain('TOP_LEVEL_OK')
    expect(log).not.toContain('Error in loop')
    expect(log).not.toContain('not a function')
  })

  test('#151 MIDI event dual-fires /midi:*:channel/type and /midi/type', async ({ page }) => {
    await installMocks(page)
    await gotoAndWaitBanner(page)

    // Two loops sync on different cue-path formats. A single mocked MIDI
    // note_on must wake BOTH — that's what the dual fireCue in
    // SonicPiEngine.init's midiBridge.onMidiEvent handler guarantees.
    // A third loop syncs on channel 2 and must NOT wake from a channel 1 event.
    await runCode(page, `
live_loop :desktop_format do
  sync "/midi:*:1/note_on"
  puts "DESKTOP_FORMAT_OK"
end

live_loop :short_format do
  sync "/midi/note_on"
  puts "SHORT_FORMAT_OK"
end

live_loop :wrong_channel do
  sync "/midi:*:2/note_on"
  puts "WRONG_CHANNEL_FAIL"
end
`)

    // Let loops park at sync points
    await page.waitForTimeout(800)

    // Attach the mock MIDI input via the engine's public midiBridge
    await enableMockMidiInput(page)

    // The bridge should now have attached a listener to the mock input
    const listenerCount = await page.evaluate(
      () => (window as unknown as { __midiListenerCount: () => number }).__midiListenerCount()
    )
    expect(listenerCount).toBeGreaterThan(0)

    // Fire note_on on channel 1: status = 0x90 | (1-1) = 0x90, note 60, vel 100
    await page.evaluate(() => {
      ;(window as unknown as { __fireMidi: (b: number[]) => number }).__fireMidi([0x90, 60, 100])
    })
    await page.waitForTimeout(800)

    // Fire once more so the loops cycle a second time through sync
    await page.evaluate(() => {
      ;(window as unknown as { __fireMidi: (b: number[]) => number }).__fireMidi([0x90, 62, 100])
    })
    await page.waitForTimeout(800)

    const appText = await page.locator('#app').textContent() ?? ''
    await stopCode(page)

    const log = logPaneText(appText)
    expect(log).toContain('DESKTOP_FORMAT_OK')
    expect(log).toContain('SHORT_FORMAT_OK')
    expect(log).not.toContain('WRONG_CHANNEL_FAIL')
    expect(log).not.toContain('Error in loop')
  })

  test('#152 sound_in triggers getUserMedia and runs without mic errors', async ({ page }) => {
    await installMocks(page)
    // Chromium also gates getUserMedia on permission — grant it pre-emptively
    // even though our mock bypasses the real mic path.
    await page.context().grantPermissions(['microphone'])
    await gotoAndWaitBanner(page)

    await runCode(page, `
live_loop :mic_in do
  use_real_time
  synth :sound_in, amp: 0.5
  sleep 0.2
end
`)

    await page.waitForTimeout(2000)
    const appText = await page.locator('#app').textContent() ?? ''
    const gumCalls = await page.evaluate(
      () => (window as unknown as { __gumCalls: string[] }).__gumCalls
    )
    await stopCode(page)

    // The AudioInterpreter's sound_in handler calls bridge.startLiveAudio
    // which calls getUserMedia — assert it was invoked at least once.
    expect(gumCalls.length).toBeGreaterThan(0)
    const log = logPaneText(appText)
    // The PR's whole point is the routing fix — must not log the failure path
    expect(log).not.toContain('Mic input failed')
    expect(log).not.toContain('Error in loop')
    expect(log).not.toContain('not a function')
    expect(log).not.toContain("isn't available")
  })
})
