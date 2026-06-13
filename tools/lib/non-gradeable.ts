/**
 * non-gradeable.ts — the single source of truth for fixtures that CANNOT be
 * graded by desktop↔web `/s_new` event-parity, because the DESKTOP REFERENCE
 * side produces ~no usable events (#549). The web output is correct; there is
 * simply nothing trustworthy to diff against.
 *
 * This is DISTINCT from a `DESKTOP-EMPTY` verdict. DESKTOP-EMPTY means desktop
 * produced zero voice events in THIS run — which is usually a transient
 * scsynth/harness failure worth investigating (so it stays surfaced). The
 * entries below are KNOWN-STRUCTURAL desktop-side limits that recur on every
 * run, so counting them as divergences (or even as "empty, check scsynth") is
 * an over-report (the SP139 class — the dashboard claiming a web bug where the
 * web engine is correct).
 *
 * Keep this list EXPLICIT and reasoned. Never replace it with a heuristic like
 * "desktop produced far fewer events than web" — that would silently swallow a
 * genuine web over-production regression. A fixture earns a place here only
 * after a grounded desktop A/B observation shows the desktop side is the limit.
 */

export interface NonGradeableEntry {
  /** Why this fixture cannot be graded against the desktop reference. */
  reason: string
}

/**
 * Keyed by the capture `name` (the .rb basename without extension, as written
 * by event-parity.ts into `eventparity_*.json`).
 */
export const NON_GRADEABLE: Record<string, NonGradeableEntry> = {
  iso_density: {
    reason:
      'Ultra-short (~0.75s) non-looping piece: desktop produces 0 voice /s_new ' +
      'because the run finishes before/around the dumpOSC capture window. Web ' +
      'emits the correct 5 beeps (with_density 2 → 60,64 ×2, plus 72).',
  },
  e2e_08_math_misc: {
    reason:
      'Synthetic E2E coverage fixture (factor_q / bools / play_pattern_timed / ' +
      'play_chord soup) ending in `stop`. Desktop halts early (~2 events) when a ' +
      'helper not present on this Sonic Pi version raises; web runs the full ~18. ' +
      'Web is correct — the divergence is the desktop fixture, not the engine.',
  },
}

/** True when this fixture is a known non-gradeable desktop-side case. */
export function isNonGradeable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NON_GRADEABLE, name)
}

/** The documented reason a fixture is non-gradeable, or null if it is gradeable. */
export function nonGradeableReason(name: string): string | null {
  return NON_GRADEABLE[name]?.reason ?? null
}
