/**
 * matrix-status.ts — the SINGLE source of truth for classifying a diff-matrix
 * cell's verdict into a status (issue #477).
 *
 * Before #477 the classification lived in TWO places that had to agree by hand:
 * the driver (`diff-matrix.ts statusFromVerdict`, coarse) and the viewer
 * (`build-diff-matrix.ts deriveStatus`, rich — it feeds `counts` → the launch
 * gate). Consolidating here makes them agree STRUCTURALLY, not coincidentally,
 * and makes the logic unit-testable (both scripts are side-effecting at import).
 *
 * The §36-Finding-1 blind spot: the event-parity multiset VERDICT keys on a
 * DROPPED/extra layer (count). A cell where every layer is present and correctly
 * counted but MIS-TIMED is STRUCTURE-MATCH — invisible to the verdict. The
 * matrix exists to measure that class, so we recompute a richer status:
 *
 *   (a) SV61 onset-SEQUENCE parity (#476, ε=15ms) — the FINE-GRAINED signal.
 *       Catches sub-second mis-timing the coarse gap below misses (e.g. #475's
 *       0.3s nested-`in_thread` fork drift). `sequenceParity.match === false`.
 *       `null` (no judgeable significant shared layer) is NOT a divergence —
 *       conservative, SV50 discipline.
 *   (b) A ≥ ONSET_GAP first-onset gap on any significant shared layer — the
 *       COARSE fallback, covers layers the SV61 significance floor excludes.
 *
 * Either ⇒ a TIMING divergence (a real engine bug the count-verdict hid).
 */

/** Minimal structural shape of a parity report's timing-relevant fields. */
export interface StatusSeqRow {
  significant: boolean
  status: string
  desktopOnset: number | null
  webOnset: number | null
}
export interface StatusReport {
  verdict: string
  rows: StatusSeqRow[]
  // Optional so older results files (pre-#476, no sequenceParity) still classify
  // via the coarse gap rather than throwing.
  sequenceParity?: { match: boolean | null } | null
}
/** Minimal structural shape of a stored cell result. */
export interface StatusCell {
  skip: string | null
  status: string
  report: StatusReport | null
}

export type Derived =
  | 'match' | 'diverge' | 'timing'
  | 'web_empty' | 'desktop_empty'
  | 'error' | 'skipped' | 'pending'

export const ONSET_GAP = 3 // seconds — matches event-parity ONSET_GAP_SEC

/**
 * (a) SV61 onset-sequence mis-timing — STRUCTURE-MATCH but a significant shared
 * layer's onset SEQUENCE diverges (ε=15ms). `null` match ⇒ not mis-timed.
 */
export function isSequenceMistimed(report: StatusReport | null): boolean {
  return report?.sequenceParity?.match === false
}

/**
 * (b) Coarse first-onset gap — a significant shared layer whose first onsets
 * differ by ≥ ONSET_GAP seconds. Covers layers below the SV61 significance floor.
 */
export function hasCoarseOnsetGap(report: StatusReport | null): boolean {
  if (!report) return false
  return report.rows.some(
    (r) =>
      r.significant &&
      r.status !== 'only-desktop' &&
      r.status !== 'only-web' &&
      Number.isFinite(r.desktopOnset as number) &&
      Number.isFinite(r.webOnset as number) &&
      Math.abs((r.desktopOnset as number) - (r.webOnset as number)) >= ONSET_GAP,
  )
}

/**
 * Rich status used by the viewer (feeds `counts` → launch gate). WEB-EMPTY = web
 * rendered nothing → an engine bug. DESKTOP-EMPTY = desktop produced nothing →
 * a harness/staleness issue, never counted against the engine.
 */
export function deriveStatus(c: StatusCell): Derived {
  if (c.skip) return 'skipped'
  if (c.status === 'error') return 'error'
  if (!c.report) return 'pending'
  if (c.report.verdict === 'STRUCTURE-DIVERGE') return 'diverge'
  if (c.report.verdict === 'WEB-EMPTY') return 'web_empty'
  if (c.report.verdict === 'DESKTOP-EMPTY') return 'desktop_empty'
  // STRUCTURE-MATCH → look for a hidden timing divergence (a) fine then (b) coarse.
  return isSequenceMistimed(c.report) || hasCoarseOnsetGap(c.report) ? 'timing' : 'match'
}
