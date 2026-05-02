/**
 * Single source of truth for the DSL name table.
 *
 * Both `SonicPiEngine.ts` (the runtime Sandbox proxy registration) and
 * `__tests__/DslBuilderContract.test.ts` (the structural guard, issue #193)
 * import from here. Pre-G6 the test had a hand-maintained mirror of this
 * list — drift was undetected by anything stronger than a vibe-check
 * `length > 70` assertion. Centralising the list eliminates that class
 * of drift (SP41-prevention applied to the fence itself, issue #204).
 *
 * If you add a new DSL function:
 *   1. Append the name here (in the appropriate category section).
 *   2. Update `dslValues` in SonicPiEngine.ts at the matching index.
 *   3. If the function has observable side effects, add a method to
 *      ProgramBuilder + an interpreter handler + entry in
 *      BUILDER_METHODS (TreeSitterTranspiler.ts). The contract test
 *      enforces this — it will fail otherwise.
 */
export const DSL_NAMES = [
  '__b',
  'live_loop', 'with_fx', 'use_bpm', 'use_synth', 'use_random_seed',
  'use_arg_bpm_scaling', 'with_arg_bpm_scaling',
  'in_thread', 'at', 'density',
  'ring', 'knit', 'range', 'line', 'spread',
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in', 'rdist',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
  'chord_degree', 'degree', 'chord_names', 'scale_names',
  'noteToMidi', 'midiToFreq', 'noteToFreq', 'note_info',
  'hz_to_midi', 'midi_to_hz',
  'quantise', 'quantize', 'octs',
  'current_bpm',
  'puts', 'print', 'stop', 'stop_loop',
  // Volume & introspection
  'set_volume', 'current_synth', 'current_volume',
  // Catalog queries
  'synth_names', 'fx_names', 'all_sample_names',
  // Sample management
  'load_sample', 'sample_info',
  // Global store
  'get', 'set',
  // Sample catalog
  'sample_names', 'sample_groups', 'sample_loaded', 'sample_duration',
  // MIDI input
  'get_cc', 'get_pitch_bend', 'get_note_on', 'get_note_off',
  // MIDI output
  'midi', 'midi_note_on', 'midi_note_off', 'midi_cc',
  'midi_pitch_bend', 'midi_channel_pressure', 'midi_poly_pressure',
  'midi_prog_change', 'midi_clock_tick',
  'midi_start', 'midi_stop', 'midi_continue',
  'midi_all_notes_off', 'midi_notes_off', 'midi_devices',
  // OSC
  'use_osc', 'osc', 'osc_send',
  // Sample BPM
  'use_sample_bpm',
  // Debug (no-op in browser — silences log output in Desktop SP)
  'use_debug',
  // Latency — set schedule-ahead to 0 for responsive MIDI input (#149)
  'use_real_time',
  // Tier A — global tick context (#211)
  'tick', 'look', 'tick_set', 'tick_reset', 'tick_reset_all',
  // Tier A — ring helpers (#211)
  'pick', 'shuffle', 'stretch', 'bools', 'ramp',
  // Tier A — pattern helpers (#211)
  'play_pattern', 'play_chord', 'play_pattern_timed',
  // Tier A — asserts + counter helpers (#211)
  'assert', 'assert_equal', 'assert_similar', 'assert_not', 'assert_error',
  'inc', 'dec',
  // Tier A — define is transpiler-handled (TreeSitterTranspiler.transpileDefine);
  // these names are blocklist-safe entries so user code that introspects them
  // doesn't fall through to globalThis. (#211)
  'define', 'ndefine',
  // Tier A — time_warp is transpiler-handled (transpileTimeWarp → __b.at(...)).
  // Runtime stub is a fallback for the regex transpiler path. (#211)
  'time_warp',
  // Tier B — timing introspection (#226). Inside live_loops these route to
  // __b.current_* for per-task reads; at top level they read engine state.
  'current_beat', 'current_beat_duration', 'current_time', 'current_sched_ahead_time',
  // Tier B — PRNG inspection (#227). Per-task reads/mutations of the rand
  // stream. All four are pure build-time on the per-loop builder's RNG.
  'current_random_seed', 'rand_back', 'rand_skip', 'rand_reset',
  // Tier B — recording (#228). Deferred ProgramBuilder steps that fire at
  // scheduled virtual time so the lifecycle sequences with the surrounding
  // play / sleep program — running them at build time would mis-order
  // recording_save before any audio plays. Rest-arg + length guards in
  // ProgramBuilder.recording_* enforce Desktop SP fixed-arity. The handler
  // wired into runProgram's ctx taps masterOutputNode (downstream of all
  // SoundLayer param normalization), so the WAV captures exactly what the
  // user hears. Top-level dslValues entries forward to topLevelBuilder.
  'recording_start', 'recording_stop', 'recording_save', 'recording_delete',
  // Tier B PR #2 — pure ring constructors (#233). Both delegate to each
  // other for negative counts (matches upstream `core.rb:1919-1970`).
  'doubles', 'halves',
] as const

export type DslName = typeof DSL_NAMES[number]
