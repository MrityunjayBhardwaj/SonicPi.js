import { describe, it, expect } from 'vitest'
import { NON_GRADEABLE, isNonGradeable, nonGradeableReason } from '../lib/non-gradeable.ts'

describe('non-gradeable fixtures (#549)', () => {
  it('flags the two known desktop-side non-gradeable fixtures', () => {
    expect(isNonGradeable('iso_density')).toBe(true)
    expect(isNonGradeable('e2e_08_math_misc')).toBe(true)
  })

  it('does NOT flag a normal gradeable fixture', () => {
    expect(isNonGradeable('cloud_beat')).toBe(false)
    expect(isNonGradeable('crossloop')).toBe(false)
    expect(isNonGradeable('')).toBe(false)
  })

  it('every entry carries a non-empty documented reason', () => {
    for (const [name, entry] of Object.entries(NON_GRADEABLE)) {
      expect(entry.reason, `reason for ${name}`).toBeTruthy()
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  it('nonGradeableReason returns the reason for listed fixtures, null otherwise', () => {
    expect(nonGradeableReason('iso_density')).toContain('non-looping')
    expect(nonGradeableReason('e2e_08_math_misc')).toContain('halts early')
    expect(nonGradeableReason('cloud_beat')).toBeNull()
  })

  it('is not driven by a fragile own/inherited-property confusion', () => {
    // hasOwnProperty guards against Object.prototype keys leaking in as "flagged".
    expect(isNonGradeable('toString')).toBe(false)
    expect(isNonGradeable('constructor')).toBe(false)
    expect(isNonGradeable('hasOwnProperty')).toBe(false)
  })
})
