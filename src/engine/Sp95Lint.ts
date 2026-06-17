/**
 * SP95-Loud — RETIRED 2026-05-28 (SP95(d) Slices 1 & 2, EPIC #392).
 *
 * This module was a build-time detector that converted three SILENT-failure
 * patterns of the old build-once-then-interpret model into visible warnings
 * (the SP95 launch co-gate, PR #381 / SV50). All three patterns now produce
 * CORRECT, desktop-matching audio, so every warning here became a false
 * positive — and a false positive erodes the lint's trust budget worse than
 * the original silence did (SV50's own negative-control discipline). The
 * detectors are removed; `detectSp95Limitations` returns `[]`.
 *
 * What changed (why each pattern is no longer a limitation):
 *   • #350 cross-loop set/get — RESOLVED by the time-indexed `TimeState` +
 *     eager `b.set` at build `current_time()` + `b.get` reader-vt routing
 *     (Slice 2, commits e5e13e8→0fe871c). r1 director/section reads the
 *     cuer's same-vt value: desktop-matching {55,59} (Level-3 PITCH-MATCH ×3).
 *   • #351-payload (`cue :x, k: v` + `sync :x`) and #351-index
 *     (`e = sync :x; e[:k]`) — RESOLVED by build-time `sync` await returning
 *     the cue payload (Slice 1, commit 402f691). r3/r4 Level-3 PITCH-MATCH.
 *
 * The generic warning CHANNEL it introduced (SonicPiEngine.setWarningHandler /
 * emitWarning, Console.logWarning, capture.ts `## Engine Warnings`) is kept —
 * it is reusable infrastructure for any future build-time lint. Only the
 * SP95-specific detectors are gone. SV50 still holds as a discipline; it just
 * no longer has an SP95 pattern to apply to.
 *
 * REFS: SV47 (IMPLEMENTED), krama SK16/SK17, hetvabhasa SP95 (RESOLVED blocks),
 * dharana §26 (RESOLVED). Issues #350/#351 (done); #400 (Slice 3 deferred —
 * reversed-loop-order (t,p,i,d) total order, a wake-phase parity feature, NOT
 * a silent-failure pattern this lint would catch). Prior loud-path: PR #381.
 */

export interface Sp95Warning {
  pattern: string
  title: string
  message: string
}

/**
 * DSL functions that exist on desktop Sonic Pi ONLY in their bang form. A
 * bangless call raises a NoMethodError on desktop — the thread dies and every
 * line after it is silent. Our transpiler strips the Ruby bang BEFORE the call
 * resolves (`set_mixer_control!` → `set_mixer_control`, ~line 1492) and
 * `DslNames.ts` lists the no-bang internal names, so the engine leniently runs
 * the bangless form too — working web audio, silent death on desktop. This
 * allowlist drives a source-level lint (run PRE-transpile, so it can still see
 * the bang) that makes the divergence loud instead of silent (#586/#594,
 * loud-not-silent / SV50).
 *
 * `set_volume` is the third member of this class (#586) but its detector lives
 * in PR #587; fold it into this list (and drop #587's inline block) once that
 * lands. Grounded: `sound.rb:1007` `reset_mixer!()`, `sound.rb:1027`
 * `set_mixer_control!(opts)`, `sound.rb:2076` `set_volume!`.
 */
const BANG_ONLY_DSL: ReadonlyArray<string> = ['set_mixer_control', 'reset_mixer']

/**
 * Run all build-time DSL lints over the given Ruby source. The SP95 detectors
 * are retired (see module header); this is the retained integration point for
 * non-fatal build-time warnings (the channel a future lint slots into). Pure.
 */
export function detectSp95Limitations(src: string): Sp95Warning[] {
  const warnings: Sp95Warning[] = []

  // `with_density` is NOT a Sonic Pi function — desktop has only `density`
  // (core.rb:3973) and RAISES on `with_density` (the thread dies, halting all
  // code after it). Our transpiler instead runs it AS `density` (squash AND
  // repeat). This warning makes the divergence-from-desktop visible and guides
  // the user to the real name rather than letting it pass silently (#379,
  // loud-not-silent / SV50). The `^[^#\n]*` guard matches a call position only,
  // skipping pure-comment lines and inline `# … with_density` comments.
  if (/^[^#\n]*\bwith_density\b/m.test(src)) {
    warnings.push({
      pattern: 'with_density',
      title: 'with_density is not a Sonic Pi function',
      message:
        'Did you mean `density`? Running `with_density` as `density` (squash and repeat). ' +
        'Desktop Sonic Pi has only `density` and errors on `with_density`.',
    })
  }

  // `with_tempo` is deprecated since Sonic Pi v2.0 — desktop RAISES a
  // DeprecationError (core.rb:3641-3642). We keep the user's code running by
  // aliasing it to `with_bpm` (transpiler) and surface this warning so the
  // divergence-from-desktop is visible and the user migrates. The `^[^#\n]*`
  // guard matches a call position only (skips comments).
  if (/^[^#\n]*\bwith_tempo\b/m.test(src)) {
    warnings.push({
      pattern: 'with_tempo',
      title: 'with_tempo is deprecated',
      message:
        '`with_tempo` is deprecated since Sonic Pi v2.0 — use `use_bpm` or `with_bpm`. ' +
        'Running it as `with_bpm`. Desktop Sonic Pi raises an error on `with_tempo`.',
    })
  }

  // Bang-only DSL functions (#594) — see BANG_ONLY_DSL. Each fires on the
  // no-bang form ONLY: the negative lookahead `(?![!\w])` excludes the valid
  // bang form (`set_mixer_control!`) and longer identifiers; the `^[^#\n]*`
  // guard matches a call position only (skips comment lines and inline
  // `# … reset_mixer` comments). Keep-accept-with-warning (SV50).
  for (const name of BANG_ONLY_DSL) {
    const re = new RegExp(`^[^#\\n]*\\b${name}(?![!\\w])`, 'm')
    if (re.test(src)) {
      warnings.push({
        pattern: name,
        title: `${name} is not a Sonic Pi function`,
        message:
          `Did you mean \`${name}!\`? Running the no-bang \`${name}\` as \`${name}!\`. ` +
          `Desktop Sonic Pi has only \`${name}!\` (with bang) and errors on \`${name}\`.`,
      })
    }
  }

  return warnings
}
