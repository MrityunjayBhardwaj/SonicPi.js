/**
 * non-gradeable.ts — the single source of truth for fixtures that CANNOT be
 * graded by desktop↔web `/s_new` event-parity, because the DESKTOP REFERENCE
 * side is not a usable target. The web output is correct; there is simply
 * nothing trustworthy to diff against.
 *
 * Two grounded sub-classes earn a place here:
 *
 *   (A) DESKTOP-SPARSE (#549) — desktop produces ~no usable voice events on
 *       every run (the run finishes before the dumpOSC window, or a fixture
 *       helper raises and halts it early). iso_density, e2e_08_math_misc.
 *
 *   (B) DESKTOP-NON-DETERMINISTIC (#560-adjacent, counter) — desktop produces
 *       events, but they are NOT REPRODUCIBLE: the fixture races two real
 *       desktop threads, so the same code yields a DIFFERENT note sequence on
 *       each desktop run. There is no stable reference to match, and web's
 *       deterministic VirtualTimeScheduler output is the CORRECT behaviour by
 *       design — replicating OS-thread jitter would be a regression of the
 *       project's central determinism guarantee. Proven by capturing desktop
 *       twice and observing the sequences differ while web is bit-identical.
 *
 * This is DISTINCT from a transient `DESKTOP-EMPTY` verdict (zero voice events
 * in THIS run only — usually a scsynth/harness hiccup worth investigating, so
 * it stays surfaced). The entries below are KNOWN-STRUCTURAL desktop-side
 * limits that recur on every run, so counting them as divergences (or even as
 * "empty, check scsynth") is an over-report (the SP139 class — the dashboard
 * claiming a web bug where the web engine is correct).
 *
 * Keep this list EXPLICIT and reasoned. Never replace it with a heuristic like
 * "desktop produced far fewer events than web" or "desktop run-to-run differs"
 * — either would silently swallow a genuine web regression. A fixture earns a
 * place here only after a grounded desktop A/B observation shows the desktop
 * side is the limit (sub-class A: re-capture shows ~0 events; sub-class B:
 * two desktop runs produce different sequences while web is identical).
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
  counter: {
    reason:
      'Sub-class B (DESKTOP-NON-DETERMINISTIC). Cross-loop shared var: a :writer ' +
      'live_loop increments `counter` and a :reader live_loop plays `60 + counter`, ' +
      'both on the same beat. On desktop the two are REAL threads that race within ' +
      'each beat, so the reader samples `counter` after a non-deterministic number ' +
      'of writer increments — the note sequence DIFFERS run-to-run (observed at ' +
      'use_bpm 60: run1 …66,68,68,69,70… vs run2 …66,67,68,70,71…; far larger jitter ' +
      'at use_bpm 600). Web\'s VirtualTimeScheduler runs both loops in deterministic ' +
      'lockstep (writer-first) → clean +1 per read, bit-identical run-to-run. Both ' +
      'sides agree on the writer-first deterministic part; desktop only diverges ' +
      'where its threads jitter. There is no stable desktop target to match, and ' +
      'web determinism is the intended behaviour — not a bug to fix.',
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
