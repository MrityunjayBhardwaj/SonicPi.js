/**
 * DSL builder contract — structural guard (issue #193).
 *
 * Every DSL function in `dslNames` with observable side effects on scheduler,
 * audio engine, MIDI, or OSC state must exist as a method on ProgramBuilder
 * and be in `BUILDER_METHODS` in the transpiler. Otherwise the transpiler
 * emits a bare call with no `__b.` prefix, the call fires at BUILD time
 * (beat 0 of every iteration), not at the scheduled virtual time.
 *
 * This test is load-bearing: it catches new additions to `dslValues` that
 * forget the corresponding ProgramBuilder step. The alternative is human
 * memory (see `.claude/.../memory/feedback_deferred_set.md`) which is how
 * we got 17 latent gaps in the first place — `set` was fixed in 2026-04-03
 * with a memo flagging the class; siblings like `stop_loop`, 14 MIDI-out,
 * `osc` shorthand, `use_osc`, and `set_volume` were never audited.
 *
 * If this test fails when you add a new DSL function:
 *   - If the function has observable side effects → add a ProgramBuilder
 *     method that pushes a step, an AudioInterpreter handler, and list
 *     the name in BUILDER_METHODS (TreeSitterTranspiler.ts).
 *   - If the function is pure (math, chord/scale theory, catalog lookups,
 *     or random resolved at build by desktop Sonic Pi convention) →
 *     add it to PURE_OR_INTENTIONAL_BUILD_TIME below with a one-line
 *     justification.
 *
 * See issues #193–#197.
 */
import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'
import { DSL_NAMES } from '../DslNames'

// Single source of truth — same array the engine registers in the Sandbox
// proxy. Pre-G6 (#204) this list was a hand-maintained mirror; the test's
// drift protection was a vibe-check (`length > 70`). Now drift is impossible:
// adding a name in SonicPiEngine's dslNames means it shows up here too,
// because both read DSL_NAMES from src/engine/DslNames.ts.
const ALL_DSL_NAMES = DSL_NAMES

/**
 * Names that are INTENTIONALLY immediate (not deferred). Must carry a
 * justification so a reviewer can tell build-time-by-design from
 * build-time-by-accident. "Pure" here means no observable side effect on
 * scheduler/engine/MIDI/OSC state.
 */
const PURE_OR_INTENTIONAL_BUILD_TIME = new Map<string, string>([
  ['__b',              'The ProgramBuilder itself.'],
  // Top-level-only wrappers — loop-body equivalents already exist on builder.
  ['live_loop',        'Registers a task at top-level. Nested live_loop is a known gap tracked separately.'],
  ['with_fx',          'Transpiler emits a dedicated call with a sub-Program; builder has its own `with_fx` method used inside loops.'],
  ['in_thread',        'Top-level helper; __b.in_thread exists for loop bodies.'],
  ['at',               'Top-level helper; __b.at exists for loop bodies.'],
  ['density',          'Top-level helper; __b.use_density / __b.with_density cover loop bodies.'],
  ['use_bpm',          'Top-level defaults setter; __b.use_bpm exists for loop bodies.'],
  ['use_synth',        'Top-level defaults setter; __b.use_synth exists for loop bodies.'],
  ['use_random_seed',  'Top-level defaults setter; __b.use_random_seed exists for loop bodies.'],
  ['use_arg_bpm_scaling',  'Top-level defaults setter; __b.use_arg_bpm_scaling exists for loop bodies.'],
  ['with_arg_bpm_scaling', 'Top-level helper; __b.with_arg_bpm_scaling exists for loop bodies.'],
  ['use_debug',        'No-op in browser; __b.use_debug exists for symmetry.'],
  ['use_real_time',    'Top-level schedAheadTime flag; __b.use_real_time exists for loop bodies.'],
  ['use_sample_bpm',   '__b.use_sample_bpm exists for loop bodies.'],
  // Pure data constructors
  ['ring',             'Pure constructor.'],
  ['knit',             'Pure constructor.'],
  ['range',            'Pure constructor.'],
  ['line',             'Pure constructor.'],
  ['spread',           'Pure Euclidean-rhythm constructor.'],
  ['doubles',          'Pure: ring of successive doubling.'],
  ['halves',           'Pure: ring of successive halving.'],
  // Pure math
  ['note',             'Pure: note name → MIDI number.'],
  ['note_range',       'Pure constructor.'],
  ['noteToMidi',       'Pure.'],
  ['midiToFreq',       'Pure.'],
  ['noteToFreq',       'Pure.'],
  ['note_info',        'Pure: name/midi → SonicPi::Note-like {midi_note, octave, pitch_class}.'],
  ['hz_to_midi',       'Pure.'],
  ['midi_to_hz',       'Pure.'],
  ['quantise',         'Pure.'],
  ['quantize',         'Pure.'],
  ['octs',             'Pure.'],
  // Music theory (pure)
  ['chord',            'Pure constructor.'],
  ['scale',            'Pure constructor.'],
  ['chord_invert',     'Pure.'],
  ['chord_degree',     'Pure.'],
  ['degree',           'Pure.'],
  ['chord_names',      'Pure catalog lookup.'],
  ['scale_names',      'Pure catalog lookup.'],
  // Tick context — build-time per-builder counter; tick is per-iteration deterministic.
  ['tick',             'Build-time named-tick counter. ProgramBuilder.tick — same surface as desktop SP.'],
  ['look',             'Build-time named-tick read without advancing.'],
  ['tick_set',         'Build-time named-tick assignment.'],
  ['tick_reset',       'Build-time named-tick reset.'],
  ['tick_reset_all',   'Build-time reset of all named-tick counters.'],
  // Ring helpers — pure data transforms (#211).
  ['pick',             'Pure: random sample (build-time seeded against the live_loop seed).'],
  ['shuffle',          'Pure: Fisher-Yates shuffle (build-time seeded).'],
  ['stretch',          'Pure: repeat each element n times.'],
  ['bools',            'Pure: boolean ring constructor.'],
  ['ramp',             'Pure: non-cycling ring constructor (clamps to last value).'],
  // Asserts + counter helpers — pure build-time (#211). Failures throw
  // synchronously so the editor error overlay surfaces them.
  ['assert',           'Pure: throws AssertionFailedError on falsy condition.'],
  ['assert_equal',     'Pure: throws on inequality (deep for objects).'],
  ['assert_similar',   'Pure: float epsilon comparison.'],
  ['assert_not',       'Pure: throws on truthy condition.'],
  ['assert_error',     'Pure: throws if block does NOT raise.'],
  ['inc',              'Pure: x + 1.'],
  ['dec',              'Pure: x - 1.'],
  ['define',           'Transpiler emits a JS function decl (TreeSitterTranspiler.transpileDefine). Runtime stub is a no-op.'],
  ['ndefine',          'Alias for define on the transpile path; same JS function decl. (#211 — non-persistence is identical to define until cross-eval persistence ships.)'],
  ['time_warp',        'Transpiler turns `time_warp 0.5 do … end` into `__b.at([0.5], null, …)` (transpileTimeWarp). Runtime stub forwards to topLevelAt for the regex fallback path.'],
  // Random — desktop Sonic Pi resolves these at build-time deterministically (seeded)
  ['rrand',            'Desktop SP convention: resolved at build-time against the live_loop seed.'],
  ['rrand_i',          'Desktop SP convention: build-time seeded.'],
  ['rand',             'Desktop SP convention: build-time seeded.'],
  ['rand_i',           'Desktop SP convention: build-time seeded.'],
  ['choose',           'Desktop SP convention: build-time seeded.'],
  ['dice',             'Desktop SP convention: build-time seeded.'],
  ['one_in',           'Desktop SP convention: build-time seeded.'],
  ['rdist',            'Desktop SP convention: build-time seeded.'],
  // Catalog / introspection (static data)
  ['synth_names',      'Static catalog.'],
  ['fx_names',         'Static catalog.'],
  ['all_sample_names', 'Static catalog.'],
  ['sample_names',     'Static catalog.'],
  ['sample_groups',    'Static catalog.'],
  ['sample_loaded',    'Read-only predicate against static catalog.'],
  ['sample_duration',  'Read-only; duration is constant once loaded.'],
  ['sample_info',      'Read-only metadata.'],
  ['load_sample',      'Documented no-op — samples lazy-load on first use.'],
  ['midi_devices',     'Read-only device list.'],
  // Output that has __b counterparts (pairs with BUILDER_METHODS)
  ['puts',             'Top-level print; __b.puts exists for loop bodies.'],
  ['print',            'Top-level print; __b.print exists for loop bodies.'],
  ['stop',             'Top-level halt sentinel; __b.stop exists for loop bodies.'],
  // Stale-read class — tracked as P2 design question (NOT in this PR's scope).
  // These read engine state at build-time, which is semantically wrong for
  // step-time reads. Fixing them needs a different primitive (step-time
  // resolution) and is out of scope for the deferred-step contract.
  ['get',              'Global store read. Stale-read P2 — tracked separately.'],
  ['current_bpm',      'Stale-read P2 — returns build-time bpm snapshot.'],
  ['current_synth',    'Stale-read P2 — returns build-time synth snapshot.'],
  ['current_volume',   'Stale-read P2 — returns build-time volume snapshot.'],
  ['get_cc',           'Stale-read P2 — returns MIDI-CC value at build time.'],
  ['get_pitch_bend',   'Stale-read P2.'],
  ['get_note_on',      'Stale-read P2.'],
  ['get_note_off',     'Stale-read P2.'],
])

describe('DSL builder contract (issue #193)', () => {
  it('every side-effecting DSL name has a ProgramBuilder method', () => {
    const builder = ProgramBuilder.prototype as unknown as Record<string, unknown>
    const gaps: string[] = []

    for (const name of ALL_DSL_NAMES) {
      if (PURE_OR_INTENTIONAL_BUILD_TIME.has(name)) continue
      if (typeof builder[name] !== 'function') {
        gaps.push(name)
      }
    }

    if (gaps.length > 0) {
      throw new Error(
        `Side-effecting DSL names missing from ProgramBuilder.prototype: [${gaps.join(', ')}].\n` +
        `Each one fires at BUILD time (beat 0 of each live_loop iteration) instead of at the scheduled virtual time.\n` +
        `Fix: add a ProgramBuilder method that pushes a step, an AudioInterpreter handler, and list in BUILDER_METHODS (TreeSitterTranspiler.ts).\n` +
        `See issue #193 and sub-issues #194–#197.`,
      )
    }
    expect(gaps).toEqual([])
  })

  it('every name in the allow-list also appears in DSL_NAMES (no orphan justifications)', () => {
    // If the allow-list grows stale (e.g. a name is removed from DSL_NAMES
    // but its justification stays here), the orphan would never be checked.
    // Catch that explicitly so the allow-list stays a contract, not a wishlist.
    const dslSet = new Set<string>(ALL_DSL_NAMES)
    const orphans: string[] = []
    for (const name of PURE_OR_INTENTIONAL_BUILD_TIME.keys()) {
      if (!dslSet.has(name)) orphans.push(name)
    }
    expect(orphans).toEqual([])
  })

  it('deferred-step methods push steps in declaration order (regression for stop_loop bug)', () => {
    // The exact bug that hid for a year: stop_loop("kick") fired at build
    // time, BEFORE the preceding sleep step was even built into the program.
    // After the fix, the step ordering must match source order so the
    // interpreter walks them in lock-step with sleep advances.
    const b = new ProgramBuilder()
    b.sleep(144)
    b.stop_loop('kick')
    b.set_volume(0.3)
    b.use_osc('host', 4560)
    b.osc('/path', 1)
    b.midi_note_on(60, 100, { channel: 1 })
    const program = b.build()

    expect(program[0].tag).toBe('sleep')
    expect(program[1].tag).toBe('stopLoop')
    expect((program[1] as { tag: 'stopLoop'; name: string }).name).toBe('kick')
    expect(program[2].tag).toBe('setVolume')
    expect(program[3].tag).toBe('useOsc')
    expect(program[4].tag).toBe('oscSend')
    expect(program[5].tag).toBe('midiOut')
    expect((program[5] as { tag: 'midiOut'; kind: string }).kind).toBe('noteOn')
  })

  it('midi shorthand emits noteOn + scheduled noteOff with sustain', () => {
    const b = new ProgramBuilder()
    b.midi(60, { sustain: 0.5, velocity: 90, channel: 2 })
    const program = b.build()

    expect(program.length).toBe(2)
    expect(program[0].tag).toBe('midiOut')
    expect((program[0] as { tag: 'midiOut'; kind: string }).kind).toBe('noteOn')
    expect((program[0] as { tag: 'midiOut'; args: unknown[] }).args).toEqual([60, 90, 2])
    expect(program[1].tag).toBe('midiOut')
    expect((program[1] as { tag: 'midiOut'; kind: string }).kind).toBe('noteOff')
    // Third arg carries the sustain in BEATS — interpreter scales by current bpm.
    expect((program[1] as { tag: 'midiOut'; args: unknown[] }).args).toEqual([60, 2, 0.5])
  })
})
