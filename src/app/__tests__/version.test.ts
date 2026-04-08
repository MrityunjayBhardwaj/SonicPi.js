/**
 * Composition pair enforcement — package.json version MUST match
 * src/app/version.ts APP_VERSION.
 *
 * This test exists because dharana §10 (Release Engineering Boundary)
 * identifies this as a composition pair: if the two drift, the running
 * app lies about its version and bug reports get triaged to the wrong
 * build. The release runbook (RELEASE.md) codifies this as a manual
 * step, but manual discipline is a weaker guarantee than a failing
 * test. This test turns that discipline into a mechanical gate.
 *
 * If this test fails, the fix is always the same: update one of the
 * two files to match the other. Usually you're bumping package.json
 * for a release and forgot to update src/app/version.ts (or vice
 * versa). They must be in lockstep in every commit.
 *
 * Implementation note: uses Vite's native JSON import (enabled by
 * resolveJsonModule in tsconfig) rather than fs.readFileSync to avoid
 * pulling in @types/node for a single test.
 */
import { describe, it, expect } from 'vitest'
import { APP_VERSION } from '../version'
import pkg from '../../../package.json'

// Semver with optional prerelease suffix: 1.2.3, 1.2.3-beta.0,
// 1.2.3-rc.1, 1.2.3-alpha.42. No build metadata (+...) — we don't use it.
// Capture groups intentionally omitted; this is a validity check, not a
// parser. If we ever need parsing, use a proper semver library.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc)\.(0|[1-9]\d*))?$/

describe('version composition pair (dharana §10)', () => {
  it('APP_VERSION must equal package.json version', () => {
    expect(APP_VERSION).toBe(pkg.version)
  })

  it('APP_VERSION must be a valid semver string', () => {
    // Catches the "both files say 'banana'" failure mode that the
    // equality test alone can't see. The regex enforces the cycle
    // convention from dharana §10: only alpha/beta/rc prerelease
    // suffixes, counters without leading zeros, no build metadata.
    expect(APP_VERSION).toMatch(SEMVER_RE)
  })

  it('package.json version must be a valid semver string', () => {
    expect(pkg.version).toMatch(SEMVER_RE)
  })

  it('semver regex rejects invalid versions (self-check)', () => {
    // Belt-and-suspenders: verify the regex actually discriminates.
    // Without this, a regex that accidentally matches everything
    // (e.g., `/.*/ `) would pass the positive cases silently.
    const invalid = [
      'banana',           // not a version at all
      '1.5',              // too few parts
      '1.5.0.0',          // too many parts
      '01.0.0',           // leading zero
      '1.05.0',           // leading zero in middle
      '1.5.0-dev',        // unknown cycle (only alpha/beta/rc allowed)
      'v1.5.0',           // v-prefix doesn't belong in package.json
      '1.5.0-beta',       // prerelease suffix without counter
      '1.5.0-beta.',      // prerelease suffix with empty counter
      '1.5.0-beta.0.1',   // too many prerelease parts
      '1.5.0+build.1',    // build metadata not allowed
      '1.5.0-beta.0+x',   // prerelease + build metadata
      '',                 // empty string
    ]
    for (const version of invalid) {
      expect(version, `expected "${version}" to fail semver check`).not.toMatch(SEMVER_RE)
    }
  })

  it('semver regex accepts valid versions (self-check)', () => {
    // Mirror of the negative case — verify the regex ALSO accepts
    // versions we'd plausibly ship in the future, not just the
    // current APP_VERSION.
    const valid = [
      '0.0.0',
      '1.0.0',
      '1.5.0',
      '10.20.30',
      '1.5.0-alpha.0',
      '1.5.0-beta.0',
      '1.5.0-beta.1',
      '1.5.0-beta.42',
      '1.5.0-rc.0',
      '2.0.0-alpha.99',
    ]
    for (const version of valid) {
      expect(version, `expected "${version}" to pass semver check`).toMatch(SEMVER_RE)
    }
  })
})
