import { test, expect, Page } from '@playwright/test'

/**
 * Helper: paste code into the editor, click Run, wait, collect console errors.
 * Returns { errors, consoleText } from the app's UI.
 */
async function runSonicPiCode(page: Page, code: string) {
  const jsErrors: string[] = []
  const consoleMessages: string[] = []

  page.on('pageerror', (err) => jsErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleMessages.push(msg.text())
  })

  await page.goto('/')
  await page.waitForTimeout(2000)

  // Clear editor and type new code
  // Focus the editor area (CodeMirror or textarea)
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  // Select all and replace
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)

  // Type the code
  await editor.fill(code)
  await page.waitForTimeout(200)

  // Click Run
  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()

  // Wait for engine init + first loop iteration
  await page.waitForTimeout(5000)

  // Collect app console text (the UI console pane, not browser console)
  const appText = await page.locator('#app').textContent() ?? ''

  // Check for error indicators in the app console
  const hasAppError = appText.includes('not a function') ||
    appText.includes('not defined') ||
    appText.includes('Something went wrong') ||
    appText.includes('Syntax error')

  // Stop — use Escape key (more reliable than button locator)
  await page.keyboard.press('Escape')

  return {
    jsErrors: jsErrors.filter(e =>
      !e.includes('h1-check') &&
      !e.includes('detectStore') &&
      !e.includes('InstallTrigger') &&
      !e.includes('lockdown')
    ),
    consoleMessages,
    appText,
    hasAppError,
  }
}

test.describe('DSL E2E — Code Execution Tests', () => {

  test('bare code: play 60, sleep 1', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
play 60
sleep 0.5
play 64
sleep 0.5
play 67
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('basic live_loop with sample', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('live_loop with play and use_synth', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :melody do
  use_synth :saw
  play 60, release: 0.2
  sleep 0.25
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('use_bpm + multiple live_loops', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
use_bpm 120

live_loop :kick do
  sample :bd_haus
  sleep 1
end

live_loop :hat do
  sleep 0.5
  sample :hat_snap, amp: 0.5
  sleep 0.5
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('with_fx wrapping live_loop', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
with_fx :reverb, room: 0.8 do
  live_loop :lead do
    use_synth :tb303
    play 60, release: 0.1, cutoff: 80
    sleep 0.125
  end
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('if with one_in inside live_loop', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :random do
  if one_in(3)
    play 60
  end
  sleep 0.25
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('define + call from live_loop', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
define :bass do |n|
  play n, release: 0.2
  sleep 0.25
end

live_loop :test do
  bass :c2
  bass :e2
  sleep 0.5
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('ring with tick', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :arp do
  notes = (ring :c4, :e4, :g4, :b4)
  play notes.tick, release: 0.2
  sleep 0.25
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('density inside live_loop', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :test do
  density 2 do
    play 60
    sleep 1
  end
  sleep 1
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('rrand and choose in expressions', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :gen do
  play rrand(60, 80), release: 0.1
  sleep choose([0.25, 0.5])
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('scale and chord', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :chords do
  play chord(:c4, :major)
  sleep 1
  play scale(:e4, :minor_pentatonic).choose
  sleep 1
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('full techno example', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
use_bpm 130

live_loop :kick do
  sample :bd_haus, amp: 2, cutoff: 110
  sleep 1
end

live_loop :bass do
  use_synth :tb303
  play :e2, release: 0.2, cutoff: rrand(70, 100)
  sleep 0.25
end

with_fx :reverb, room: 0.8 do
  live_loop :lead do
    use_synth :tb303
    if one_in(3)
      play scale(:e2, :minor_pentatonic).choose, release: 0.1, cutoff: rrand(60, 120), res: 0.8
    end
    sleep 0.125
  end
end

live_loop :ambient do
  use_synth :hollow
  play :e4, attack: 4, release: 4, amp: 0.4
  sleep 8
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('N.times loop', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :test do
  4.times do |i|
    play 60 + i
    sleep 0.25
  end
  sleep 1
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('.each iteration', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :melody do
  [60, 64, 67, 72].each do |n|
    play n, release: 0.2
    sleep 0.25
  end
  sleep 0.5
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('begin/rescue error handling', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :safe do
  begin
    play 60
    sleep 0.5
  rescue
    sleep 1
  end
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('string interpolation', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :test do
  n = 60
  puts "playing note #{n}"
  play n
  sleep 1
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })

  test('control with slide params', async ({ page }) => {
    const { hasAppError, jsErrors } = await runSonicPiCode(page, `
live_loop :slide do
  s = play 60, release: 4, note_slide: 1
  sleep 1
  control s, note: 65
  sleep 3
end
`)
    expect(jsErrors).toHaveLength(0)
    expect(hasAppError).toBe(false)
  })
})
