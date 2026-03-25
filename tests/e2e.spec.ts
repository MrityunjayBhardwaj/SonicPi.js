import { test, expect } from '@playwright/test'

test.describe('Sonic Pi Web — E2E Smoke Tests', () => {

  test('app loads without JS errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/')
    await page.waitForTimeout(2000)

    await expect(page.locator('#app')).toBeVisible()

    // Filter out browser extension noise
    const appErrors = errors.filter(e =>
      !e.includes('h1-check') &&
      !e.includes('detectStore') &&
      !e.includes('InstallTrigger') &&
      !e.includes('lockdown')
    )
    expect(appErrors).toHaveLength(0)
  })

  test('Run executes code without SyntaxError', async ({ page }) => {
    const syntaxErrors: string[] = []
    page.on('pageerror', (err) => {
      if (err.message.includes('SyntaxError') || err.message.includes('missing )')) {
        syntaxErrors.push(err.message)
      }
    })

    await page.goto('/')
    await page.waitForTimeout(2000)

    // Find Run button by its label span
    const runBtn = page.locator('.spw-btn-label:has-text("Run")')
    await expect(runBtn).toBeVisible()
    await runBtn.click()

    await page.waitForTimeout(3000)

    // No SyntaxError should have occurred
    expect(syntaxErrors).toHaveLength(0)

    // The console area should show engine init messages, not errors
    // Use a broad selector since the console is nested
    const pageText = await page.locator('#app').textContent() ?? ''
    expect(pageText).not.toContain('Something went wrong')
    expect(pageText).not.toContain('missing )')
  })

  test('Stop works after Run', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)

    // Run
    await page.locator('.spw-btn-label:has-text("Run")').click()
    await page.waitForTimeout(2000)

    // Button should now say "Update"
    await expect(page.locator('.spw-btn-label:has-text("Update")')).toBeVisible()

    // Stop
    await page.locator('.spw-btn-label:has-text("Stop")').click()
    await page.waitForTimeout(500)

    // Should revert to "Run"
    await expect(page.locator('.spw-btn-label:has-text("Run")')).toBeVisible()
  })

  test('example selector loads code', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)

    // Use the select dropdown
    const select = page.locator('select')
    await select.selectOption({ label: 'Basic Beat' })
    await page.waitForTimeout(500)

    // Page text should contain the loaded example name somewhere
    const pageText = await page.locator('#app').textContent() ?? ''
    expect(pageText).toContain('Basic Beat')
  })

  test('buffer tabs switch', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)

    // Click buffer 1 tab
    const bufferBtns = page.locator('button[title^="Buffer"]')
    const buf1 = bufferBtns.nth(1)
    await buf1.click()
    await page.waitForTimeout(300)

    await expect(page.locator('#spw-buffer-title')).toHaveText('Buffer 1')
  })
})
