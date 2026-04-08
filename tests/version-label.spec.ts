/**
 * E2E test — version label render path.
 *
 * The unit test at src/app/__tests__/version.test.ts verifies that
 * APP_VERSION matches package.json. This test verifies that APP_VERSION
 * is actually rendered in the DOM. Together they cover both sides of
 * the distribution-boundary observation tool from dharana §10:
 *
 *   unit test  → "the constant is in sync"
 *   e2e test   → "the constant is actually shown to the user"
 *
 * Failure modes this catches that the unit test can't:
 * - A refactor removes or breaks the version label render path
 * - CSS hides the element (display: none, visibility: hidden, opacity: 0)
 * - A condition skips rendering it in some app state
 * - The button is rendered but the text is stripped / overridden later
 *
 * Tracked as issue #161.
 *
 * Implementation note: reads package.json via fs because Playwright's
 * runtime doesn't support bare JSON imports. (Vitest does — see the
 * unit test for the cleaner import approach.)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgPath = resolve(__dirname, '../package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

test.describe('version label — distribution boundary observation (dharana §10)', () => {
  test('renders in the top-right of the menu bar with the package.json version', async ({ page }) => {
    await page.goto('/')
    // Menu bar renders early; give the app a moment to mount.
    // Match p0-smoke.spec.ts convention — 500ms was flaky on slow CI.
    await page.waitForTimeout(2000)

    // The version label is a button whose textContent is `v${APP_VERSION}`.
    // We look it up by its aria-label prefix, which is stable and unique.
    const versionLabel = page.locator('button[aria-label^="SonicPi.js v"]')
    await expect(versionLabel).toBeVisible()

    const text = await versionLabel.textContent()
    expect(text).toBeTruthy()
    expect(text!.trim()).toBe(`v${pkg.version}`)
  })

  test('aria-label carries the full SonicPi.js version string', async ({ page }) => {
    await page.goto('/')
    // Match p0-smoke.spec.ts convention — 500ms was flaky on slow CI.
    await page.waitForTimeout(2000)

    const versionLabel = page.locator('button[aria-label^="SonicPi.js v"]')
    const aria = await versionLabel.getAttribute('aria-label')
    expect(aria).toBe(`SonicPi.js v${pkg.version} — click to copy`)
  })
})
