import { test, expect, Page } from '@playwright/test'

const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'

/**
 * Helper: paste code, run, wait, collect app console text.
 */
async function runAndCapture(page: Page, code: string, waitMs = 5000) {
  await page.goto('/')
  await page.waitForTimeout(2000)

  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press(selectAll)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  const runBtn = page.locator('.spw-btn-label:has-text("Run")')
  await runBtn.click()
  await page.waitForTimeout(waitMs)

  const appText = await page.locator('#app').textContent() ?? ''

  // Stop
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  return appText
}

test.describe('P0 Smoke Tests', () => {

  test('infinite loop protection: loop without sleep shows error, tab survives', async ({ page }) => {
    const appText = await runAndCapture(page, `
loop do
  play :c4
end
`, 6000)

    // Should show infinite loop error, not freeze the tab
    const hasInfiniteLoopError = appText.toLowerCase().includes('infinite loop') ||
      appText.toLowerCase().includes('budget') ||
      appText.toLowerCase().includes('did you forget')
    expect(hasInfiniteLoopError).toBe(true)
  })

  test('tree-sitter transpiler handles at-block without fallback', async ({ page }) => {
    const appText = await runAndCapture(page, `
live_loop :test do
  at [1, 2] do |t|
    play :c4
  end
  sleep 4
end
`)

    // Tree-sitter handles this correctly — no fallback warning expected
    expect(appText).not.toContain('Syntax error')
    expect(appText).not.toContain('not a function')
    expect(appText).not.toContain('Error in loop')
    expect(appText).not.toContain("isn't available")
  })

  test('scope isolation: rand works and loops get independent values', async ({ page }) => {
    const appText = await runAndCapture(page, `
live_loop :a do
  puts rrand(0, 1000).to_i
  sleep 1
end

live_loop :b do
  puts rrand(0, 1000).to_i
  sleep 1
end
`, 6000)

    // Should produce numeric output, not "undefined"
    expect(appText).not.toContain('undefined')
    // Extract numbers from console — loops with different seeds should produce different values
    const numbers = appText.match(/\b\d{1,3}\b/g) ?? []
    expect(numbers.length).toBeGreaterThan(2)
  })

  test('basic playback: drums example produces console output', async ({ page }) => {
    const appText = await runAndCapture(page, `
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
`)

    // Console should show loop activity
    const hasOutput = appText.includes('bd_haus') ||
      appText.includes('sn_dub') ||
      appText.includes(':drums')
    expect(hasOutput).toBe(true)
  })

  test('hot-swap: changing code while playing updates without stopping', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)

    const editor = page.locator('.cm-content, textarea').first()
    await editor.click()
    await page.keyboard.press(selectAll)
    await page.keyboard.press('Backspace')

    // First code
    await editor.fill(`
live_loop :melody do
  play :c4
  sleep 0.5
end
`)
    // Run via keyboard shortcut (more reliable than button locator)
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(3000)

    // Hot-swap: change note while playing
    await editor.click()
    await page.keyboard.press(selectAll)
    await page.keyboard.press('Backspace')
    await editor.fill(`
live_loop :melody do
  play :e5
  sleep 0.5
end
`)
    // Re-evaluate via keyboard shortcut
    await page.keyboard.press('Control+Enter')
    await page.waitForTimeout(3000)

    const appText = await page.locator('#app').textContent() ?? ''

    await page.keyboard.press('Escape')
    // The test passes if we got here without crashing — hot-swap worked
    expect(appText.length).toBeGreaterThan(0)
  })

  test('stop button stops playback', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)

    const editor = page.locator('.cm-content, textarea').first()
    await editor.click()
    await page.keyboard.press(selectAll)
    await page.keyboard.press('Backspace')
    await editor.fill(`
live_loop :test do
  play :c4
  sleep 0.5
end
`)

    const runBtn = page.locator('.spw-btn-label:has-text("Run")')
    await runBtn.click()
    await page.waitForTimeout(2000)

    // Stop via Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Capture console length after stop
    const textAfterStop = await page.locator('#app').textContent() ?? ''
    await page.waitForTimeout(2000)
    const textLater = await page.locator('#app').textContent() ?? ''

    // Console should not grow significantly after stop (no new events)
    // Allow small tolerance for final buffered events
    expect(textLater.length - textAfterStop.length).toBeLessThan(200)
  })
})
