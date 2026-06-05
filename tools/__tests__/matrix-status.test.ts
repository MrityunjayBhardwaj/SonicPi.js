/**
 * #477 — the diff-matrix status classifier must flag a mis-timed-but-
 * count-correct cell as 'timing' via the SV61 onset-sequence signal, so the
 * #475 class (nested in_thread forking 0.3s early — well below the coarse 3s
 * first-onset gap) is caught in-grid and blocks the launch gate.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveStatus,
  isSequenceMistimed,
  hasCoarseOnsetGap,
  ONSET_GAP,
  type StatusCell,
  type StatusReport,
} from '../lib/matrix-status.ts'

const row = (o: Partial<StatusReport['rows'][number]> = {}): StatusReport['rows'][number] => ({
  significant: true,
  status: 'count-match',
  desktopOnset: 2.0,
  webOnset: 2.0,
  ...o,
})

const report = (o: Partial<StatusReport> = {}): StatusReport => ({
  verdict: 'STRUCTURE-MATCH',
  rows: [row()],
  sequenceParity: { match: true },
  ...o,
})

const cell = (report: StatusReport | null, o: Partial<StatusCell> = {}): StatusCell => ({
  skip: null,
  status: 'ok',
  report,
  ...o,
})

describe('#477 matrix status — onset-sequence as a timing oracle', () => {
  describe('isSequenceMistimed', () => {
    it('true when sequenceParity.match === false', () => {
      expect(isSequenceMistimed(report({ sequenceParity: { match: false } }))).toBe(true)
    })
    it('false when match === true', () => {
      expect(isSequenceMistimed(report({ sequenceParity: { match: true } }))).toBe(false)
    })
    it('false when match === null (no judgeable layer — SV50 conservative)', () => {
      expect(isSequenceMistimed(report({ sequenceParity: { match: null } }))).toBe(false)
    })
    it('false when sequenceParity absent (pre-#476 results) or report null', () => {
      expect(isSequenceMistimed(report({ sequenceParity: undefined }))).toBe(false)
      expect(isSequenceMistimed(null)).toBe(false)
    })
  })

  describe('deriveStatus', () => {
    it("#475 shape: STRUCTURE-MATCH + onset-seq DIVERGE (0.3s, no coarse gap) → 'timing'", () => {
      // Onsets within ONSET_GAP (no coarse gap) but the fine-grained sequence
      // parity failed — exactly the signal the 3s heuristic missed.
      const r = report({
        rows: [row({ desktopOnset: 2.0, webOnset: 1.7 })], // 0.3s — below ONSET_GAP
        sequenceParity: { match: false },
      })
      expect(hasCoarseOnsetGap(r)).toBe(false) // coarse heuristic alone would say 'match'
      expect(deriveStatus(cell(r))).toBe('timing')
    })

    it("well-timed count-match → 'match'", () => {
      expect(deriveStatus(cell(report()))).toBe('match')
    })

    it("coarse ≥ONSET_GAP first-onset gap (no seq signal) still → 'timing' (fallback intact)", () => {
      const r = report({
        rows: [row({ desktopOnset: 5, webOnset: 5 + ONSET_GAP })],
        sequenceParity: { match: null }, // unjudgeable — only the coarse gap fires
      })
      expect(deriveStatus(cell(r))).toBe('timing')
    })

    it("STRUCTURE-DIVERGE verdict → 'diverge' (verdict takes precedence)", () => {
      expect(deriveStatus(cell(report({ verdict: 'STRUCTURE-DIVERGE', sequenceParity: { match: false } })))).toBe('diverge')
    })

    it("WEB-EMPTY → 'web_empty', DESKTOP-EMPTY → 'desktop_empty'", () => {
      expect(deriveStatus(cell(report({ verdict: 'WEB-EMPTY' })))).toBe('web_empty')
      expect(deriveStatus(cell(report({ verdict: 'DESKTOP-EMPTY' })))).toBe('desktop_empty')
    })

    it("skip → 'skipped', error → 'error', no report → 'pending'", () => {
      expect(deriveStatus(cell(report(), { skip: 'no-op cell' }))).toBe('skipped')
      expect(deriveStatus(cell(null, { status: 'error' }))).toBe('error')
      expect(deriveStatus(cell(null))).toBe('pending')
    })
  })
})
