import { test, expect } from '@playwright/test'

const EXAMPLES = [
  'Hello Beep',
  'Basic Beat',
  'Ambient Pad',
  'Arpeggio',
  'Euclidean Rhythm',
  'Random Melody',
  'Sync/Cue',
  'Multi-Layer',
  'FX Chain',
  'Minimal Techno',
]

for (const name of EXAMPLES) {
  test(`example: ${name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Filter CORS/network noise from SuperSonic CDN
        if (!text.includes('Cross-Origin') && !text.includes('CORS') && !text.includes('404')) {
          errors.push(text)
        }
      }
    })

    await page.goto('/')
    await page.waitForTimeout(2000)

    // Select example from dropdown
    const select = page.locator('select')
    await select.selectOption({ label: name })
    await page.waitForTimeout(500)

    // Click Run
    const runBtn = page.locator('.spw-btn-label:has-text("Run")')
    await runBtn.click()
    await page.waitForTimeout(5000)

    // Check app UI for error messages
    const appText = await page.locator('#app').textContent() ?? ''
    const hasUIError = appText.includes('not a function') ||
      appText.includes('not defined') ||
      appText.includes('Something went wrong') ||
      appText.includes('Syntax error') ||
      appText.includes('Error in loop') ||
      appText.includes("isn't available")

    if (hasUIError) {
      // Extract the actual error from the UI
      const errorLines = appText.split('\n').filter(l =>
        l.includes('not a function') || l.includes('not defined') ||
        l.includes('Something went wrong') || l.includes('Syntax error') ||
        l.includes('Error in loop') || l.includes("isn't available")
      )
      console.log(`[${name}] UI ERROR:`, errorLines.join(' | '))
    }

    if (errors.length > 0) {
      console.log(`[${name}] JS ERRORS:`, errors.join(' | '))
    }

    // Stop
    await page.keyboard.press('Escape')

    expect(hasUIError, `Example "${name}" showed error in UI`).toBe(false)
    expect(errors, `Example "${name}" had JS errors`).toHaveLength(0)
  })
}
