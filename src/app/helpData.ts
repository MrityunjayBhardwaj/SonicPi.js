/**
 * Help database for the Sonic Pi DSL — used by autocomplete and Help Panel.
 *
 * Each entry has a signature, short description, parameter list, and example.
 * Functions are hand-written below. Synths, FX, and samples are generated
 * dynamically from engine data at the bottom of this file.
 */

import { SYNTH_PARAMS, FX_PARAMS } from '../engine/SynthParams'
import { getAllSamples } from '../engine/SampleCatalog'

export interface HelpParam {
  name: string
  type: string
  default?: string
  desc: string
}

export interface HelpEntry {
  signature: string
  description: string
  params: HelpParam[]
  example: string
}

export const HELP_DB: Record<string, HelpEntry> = {
  play: {
    signature: 'play note, opts',
    description: 'Play a note with the current synth.',
    params: [
      { name: 'note', type: 'number|symbol', desc: 'MIDI note or note name (:c4, :eb3)' },
      { name: 'amp', type: 'number', default: '1', desc: 'Volume (0-5)' },
      { name: 'release', type: 'number', default: '1', desc: 'Release time in beats' },
      { name: 'attack', type: 'number', default: '0', desc: 'Attack time in beats' },
      { name: 'sustain', type: 'number', default: '0', desc: 'Sustain time in beats' },
      { name: 'decay', type: 'number', default: '0', desc: 'Decay time in beats' },
      { name: 'pan', type: 'number', default: '0', desc: 'Stereo pan (-1 to 1)' },
      { name: 'cutoff', type: 'number', desc: 'Low-pass filter cutoff (MIDI note 0-131)' },
    ],
    example: 'play :c4, amp: 0.5, release: 2',
  },

  sleep: {
    signature: 'sleep beats',
    description: 'Wait for the given number of beats before continuing.',
    params: [
      { name: 'beats', type: 'number', desc: 'Duration in beats (at current BPM)' },
    ],
    example: 'sleep 0.5',
  },

  sample: {
    signature: 'sample name, opts',
    description: 'Play a built-in or custom sample.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Sample name (:bd_haus, :sn_dub, etc.)' },
      { name: 'amp', type: 'number', default: '1', desc: 'Volume (0-5)' },
      { name: 'rate', type: 'number', default: '1', desc: 'Playback rate (negative = reverse)' },
      { name: 'pan', type: 'number', default: '0', desc: 'Stereo pan (-1 to 1)' },
      { name: 'attack', type: 'number', default: '0', desc: 'Fade-in time in beats' },
      { name: 'release', type: 'number', desc: 'Fade-out time in beats' },
      { name: 'start', type: 'number', default: '0', desc: 'Start position (0-1)' },
      { name: 'finish', type: 'number', default: '1', desc: 'End position (0-1)' },
      { name: 'rpitch', type: 'number', default: '0', desc: 'Relative pitch in semitones' },
    ],
    example: 'sample :bd_haus, amp: 2, rate: 0.8',
  },

  live_loop: {
    signature: 'live_loop name do ... end',
    description: 'Create a named loop that repeats forever and can be live-edited.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Unique loop name (e.g. :drums)' },
    ],
    example: `live_loop :beat do
  sample :bd_haus
  sleep 0.5
end`,
  },

  with_fx: {
    signature: 'with_fx name, opts do ... end',
    description: 'Wrap code in an audio effect. Everything inside is routed through the FX.',
    params: [
      { name: 'name', type: 'symbol', desc: 'FX name (:reverb, :echo, :distortion, etc.)' },
      { name: 'mix', type: 'number', default: '1', desc: 'Wet/dry mix (0-1)' },
      { name: 'amp', type: 'number', default: '1', desc: 'Output volume' },
    ],
    example: `with_fx :reverb, room: 0.8 do
  play :c4
end`,
  },

  use_synth: {
    signature: 'use_synth name',
    description: 'Set the current synth for subsequent play calls.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Synth name (:beep, :saw, :prophet, :tb303, etc.)' },
    ],
    example: 'use_synth :prophet',
  },

  use_bpm: {
    signature: 'use_bpm bpm',
    description: 'Set the tempo in beats per minute. Affects sleep durations.',
    params: [
      { name: 'bpm', type: 'number', desc: 'Beats per minute (e.g. 120)' },
    ],
    example: 'use_bpm 140',
  },

  ring: {
    signature: 'ring(values)',
    description: 'Create a ring buffer that wraps around when indexed past its length.',
    params: [
      { name: 'values', type: 'number...', desc: 'Comma-separated values' },
    ],
    example: 'ring(60, 62, 64, 67).tick',
  },

  knit: {
    signature: 'knit(value, count, ...)',
    description: 'Create a ring by repeating each value a given number of times.',
    params: [
      { name: 'value', type: 'any', desc: 'Value to repeat' },
      { name: 'count', type: 'number', desc: 'How many times to repeat it' },
    ],
    example: 'knit(:e3, 3, :c3, 1)',
  },

  spread: {
    signature: 'spread(hits, total)',
    description: 'Euclidean rhythm — distribute hits evenly across total steps.',
    params: [
      { name: 'hits', type: 'number', desc: 'Number of active beats' },
      { name: 'total', type: 'number', desc: 'Total number of steps' },
    ],
    example: 'spread(3, 8)  # => (true, false, false, true, false, false, true, false)',
  },

  choose: {
    signature: 'choose(list)',
    description: 'Pick a random element from a list or ring.',
    params: [
      { name: 'list', type: 'array', desc: 'Array or ring to choose from' },
    ],
    example: 'play choose(chord(:c4, :major))',
  },

  rrand: {
    signature: 'rrand(min, max)',
    description: 'Return a random float between min and max.',
    params: [
      { name: 'min', type: 'number', desc: 'Lower bound (inclusive)' },
      { name: 'max', type: 'number', desc: 'Upper bound (exclusive)' },
    ],
    example: 'play :c4, cutoff: rrand(60, 120)',
  },

  sync: {
    signature: 'sync name',
    description: 'Block until another thread sends a cue with the given name.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Cue name to wait for' },
    ],
    example: 'sync :beat',
  },

  cue: {
    signature: 'cue name',
    description: 'Send a named cue that unblocks any threads waiting with sync.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Cue name to send' },
    ],
    example: 'cue :beat',
  },

  control: {
    signature: 'control node, opts',
    description: 'Modify parameters of a running synth node.',
    params: [
      { name: 'node', type: 'SynthNode', desc: 'Node returned by play or synth' },
      { name: 'opts', type: 'hash', desc: 'Parameters to change (e.g. note:, cutoff:)' },
    ],
    example: `n = play :c4, sustain: 4
sleep 1
control n, note: :e4`,
  },

  define: {
    signature: 'define name do ... end',
    description: 'Define a reusable named function.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Function name' },
    ],
    example: `define :bass do |n|
  use_synth :tb303
  play n, release: 0.2
end`,
  },

  in_thread: {
    signature: 'in_thread do ... end',
    description: 'Run code in a new concurrent thread sharing the same time.',
    params: [],
    example: `in_thread do
  loop do
    sample :bd_haus
    sleep 0.5
  end
end`,
  },

  at: {
    signature: 'at times do ... end',
    description: 'Schedule code to run at specific beat offsets from now.',
    params: [
      { name: 'times', type: 'array', desc: 'List of beat offsets' },
    ],
    example: `at [0, 0.5, 1, 1.5] do
  sample :hat_snap
end`,
  },

  density: {
    signature: 'density factor do ... end',
    description: 'Speed up time within the block by the given factor.',
    params: [
      { name: 'factor', type: 'number', desc: 'Time compression factor (2 = twice as fast)' },
    ],
    example: `density 2 do
  play :c4
  sleep 0.5
  play :e4
  sleep 0.5
end`,
  },

  time_warp: {
    signature: 'time_warp beats do ... end',
    description: 'Shift virtual time forward or backward by the given beats.',
    params: [
      { name: 'beats', type: 'number', desc: 'Beats to shift (negative = backward)' },
    ],
    example: `time_warp -0.1 do
  sample :bd_haus
end`,
  },

  puts: {
    signature: 'puts message',
    description: 'Print a message to the log panel.',
    params: [
      { name: 'message', type: 'any', desc: 'Value to print' },
    ],
    example: 'puts "Hello from Sonic Pi!"',
  },

  set: {
    signature: 'set name, value',
    description: 'Store a value in the global time-state that persists across loops.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Key name' },
      { name: 'value', type: 'any', desc: 'Value to store' },
    ],
    example: 'set :my_val, 42',
  },

  get: {
    signature: 'get name',
    description: 'Retrieve a value from the global time-state.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Key name' },
    ],
    example: 'val = get(:my_val)',
  },

  tick: {
    signature: 'tick()',
    description: 'Advance the thread-local counter by 1 and return the new value.',
    params: [],
    example: 'play ring(60, 64, 67).tick',
  },

  look: {
    signature: 'look()',
    description: 'Return the current thread-local counter value without advancing.',
    params: [],
    example: 'play ring(60, 64, 67)[look]',
  },

  use_random_seed: {
    signature: 'use_random_seed seed',
    description: 'Set the random seed so random values are reproducible.',
    params: [
      { name: 'seed', type: 'number', desc: 'Seed value (any integer)' },
    ],
    example: 'use_random_seed 42',
  },

  play_pattern_timed: {
    signature: 'play_pattern_timed notes, times, opts',
    description: 'Play a sequence of notes with timed sleeps between them.',
    params: [
      { name: 'notes', type: 'array', desc: 'List of MIDI notes' },
      { name: 'times', type: 'array', desc: 'List of sleep durations (cycles)' },
    ],
    example: 'play_pattern_timed [:c4, :e4, :g4], [0.25, 0.25, 0.5]',
  },

  play_chord: {
    signature: 'play_chord notes, opts',
    description: 'Play multiple notes simultaneously as a chord.',
    params: [
      { name: 'notes', type: 'array', desc: 'List of MIDI notes or a chord() call' },
      { name: 'amp', type: 'number', default: '1', desc: 'Volume' },
    ],
    example: 'play_chord chord(:c4, :major)',
  },

  chord: {
    signature: 'chord(root, quality)',
    description: 'Return a ring of MIDI notes for the given chord.',
    params: [
      { name: 'root', type: 'symbol', desc: 'Root note (:c4, :e3, etc.)' },
      { name: 'quality', type: 'symbol', desc: 'Chord type (:major, :minor, :dom7, etc.)' },
    ],
    example: 'play_chord chord(:e3, :minor)',
  },

  scale: {
    signature: 'scale(root, name, num_octaves:)',
    description: 'Return a ring of MIDI notes for the given scale.',
    params: [
      { name: 'root', type: 'symbol', desc: 'Root note (:c4, :e3, etc.)' },
      { name: 'name', type: 'symbol', desc: 'Scale type (:major, :minor, :pentatonic, etc.)' },
      { name: 'num_octaves', type: 'number', default: '1', desc: 'Number of octaves' },
    ],
    example: 'play scale(:c4, :minor_pentatonic).choose',
  },

  rrand_i: {
    signature: 'rrand_i(min, max)',
    description: 'Return a random integer between min and max (inclusive).',
    params: [
      { name: 'min', type: 'number', desc: 'Lower bound' },
      { name: 'max', type: 'number', desc: 'Upper bound' },
    ],
    example: 'play 60 + rrand_i(0, 12)',
  },

  dice: {
    signature: 'dice(sides)',
    description: 'Roll a dice with the given number of sides (1 to sides).',
    params: [
      { name: 'sides', type: 'number', default: '6', desc: 'Number of sides' },
    ],
    example: 'play 60 if dice(6) > 4',
  },

  one_in: {
    signature: 'one_in(n)',
    description: 'Return true with probability 1/n.',
    params: [
      { name: 'n', type: 'number', desc: 'Denominator (e.g. 3 = 33% chance)' },
    ],
    example: 'sample :hat_snap if one_in(3)',
  },

  note: {
    signature: 'note(name)',
    description: 'Convert a note name to a MIDI number.',
    params: [
      { name: 'name', type: 'symbol|number', desc: 'Note name or MIDI number' },
    ],
    example: 'puts note(:c4)  # => 60',
  },

  stop: {
    signature: 'stop',
    description: 'Stop the current thread (exits the live_loop).',
    params: [],
    example: `live_loop :once do
  play :c4
  stop
end`,
  },

  // Tier B PR #2 — ring helpers
  doubles: {
    signature: 'doubles(start, num)',
    description: 'Ring of `num` values starting at `start`, each twice the previous (start, 2*start, 4*start, ...). Negative `num` yields halves.',
    params: [
      { name: 'start', type: 'number', desc: 'First value' },
      { name: 'num', type: 'number', desc: 'Number of doublings (positive) or halvings (negative)' },
    ],
    example: 'play_pattern doubles(60, 4)  # 60, 120, 240, 480',
  },
  halves: {
    signature: 'halves(start, num)',
    description: 'Ring of `num` values starting at `start`, each half the previous (start, start/2, start/4, ...). Negative `num` yields doubles.',
    params: [
      { name: 'start', type: 'number', desc: 'First value' },
      { name: 'num', type: 'number', desc: 'Number of halvings (positive) or doublings (negative)' },
    ],
    example: 'play_pattern halves(120, 4)  # 120, 60, 30, 15',
  },

  // Tier B PR #2 — defaults / setting introspection
  current_synth_defaults: {
    signature: 'current_synth_defaults()',
    description: 'Return the current synth defaults map — keys are arg names, values are the defaults set via use_synth_defaults.',
    params: [],
    example: `use_synth_defaults amp: 0.5, release: 2
puts current_synth_defaults  # => { amp: 0.5, release: 2 }`,
  },
  current_sample_defaults: {
    signature: 'current_sample_defaults()',
    description: 'Return the current sample defaults map — keys are arg names, values are the defaults set via use_sample_defaults.',
    params: [],
    example: `use_sample_defaults rate: 0.5
puts current_sample_defaults`,
  },
  current_arg_checks: {
    signature: 'current_arg_checks()',
    description: 'Return whether arg-name checking is currently active (true/false).',
    params: [],
    example: 'puts current_arg_checks',
  },
  current_debug: {
    signature: 'current_debug()',
    description: 'Return whether debug logging is currently enabled (true/false).',
    params: [],
    example: 'puts current_debug',
  },

  // Tier B PR #2 — tuplets
  tuplets: {
    signature: 'tuplets(notes, opts) do |x| ... end',
    description: 'Schedule N notes evenly across `duration` beats. Block runs once per element with the value bound to the block param.',
    params: [
      { name: 'notes', type: 'array', desc: 'List of values to iterate over' },
      { name: 'duration', type: 'number', default: '1', desc: 'Total beats for the tuplet' },
    ],
    example: `tuplets [60, 64, 67], duration: 1 do |n|
  play n
end`,
  },

  // Tier B PR #2 — defonce
  defonce: {
    signature: 'name = defonce("name") do ... end',
    description: 'Cache the result of a block by name — subsequent runs reuse the cached value, surviving hot-swap. Ideal for expensive computations.',
    params: [
      { name: 'name', type: 'string', desc: 'Cache key (must be unique)' },
      { name: 'override', type: 'boolean', default: 'false', desc: 'Force re-evaluation' },
    ],
    example: `notes = defonce("scale") do
  scale(:c4, :minor).to_a
end
play notes.choose`,
  },

  // Tier B PR #3 — sync_bpm
  sync_bpm: {
    signature: 'sync_bpm cue_name',
    description: 'Like sync, but also adopts the cuer\'s BPM. Inside live_loops only.',
    params: [
      { name: 'cue_name', type: 'symbol', desc: 'Cue name to wait for' },
    ],
    example: `live_loop :follower do
  sync_bpm :tempo
  play :c4
  sleep 1
end`,
  },

  // Tier B PR #3 — dynamic eval
  run_code: {
    signature: 'run_code(code_string)',
    description: 'Dynamically evaluate a Sonic Pi code string. Top-level only — throws inside live_loops.',
    params: [
      { name: 'code', type: 'string', desc: 'Sonic Pi source to evaluate' },
    ],
    example: 'run_code "play :c4; sleep 1; play :e4"',
  },
  eval_file: {
    signature: 'eval_file(path)',
    description: 'File-based eval — not supported in the browser sandbox. Use run_code(string) or load_example(:name) instead.',
    params: [
      { name: 'path', type: 'string', desc: 'File path (always rejected in browser)' },
    ],
    example: '# eval_file "snippet.rb"  # browser: throws — use run_code instead',
  },
  run_file: {
    signature: 'run_file(path)',
    description: 'File-based run — not supported in the browser sandbox. Use run_code(string) or load_example(:name) instead.',
    params: [
      { name: 'path', type: 'string', desc: 'File path (always rejected in browser)' },
    ],
    example: '# run_file "snippet.rb"  # browser: throws — use load_example instead',
  },
  load_example: {
    signature: 'load_example(name)',
    description: 'Look up a bundled example by name and load it into the editor — replaces the buffer + auto-runs. Top-level only.',
    params: [
      { name: 'name', type: 'string|symbol', desc: 'Example name as shown in View > Examples' },
    ],
    example: 'load_example "Basic Beat"',
  },

  // Tier B PR #3 — live_audio :stop overload (live_audio itself is engine-side)
  live_audio: {
    signature: 'live_audio :name [, :stop] [, opts]',
    description: 'Named live audio stream from the soundcard. Pass :stop as the second arg to kill a running stream.',
    params: [
      { name: 'name', type: 'symbol', desc: 'Stream identifier' },
      { name: 'amp', type: 'number', default: '1', desc: 'Volume' },
      { name: 'pan', type: 'number', default: '0', desc: 'Stereo pan (-1 to 1)' },
    ],
    example: `live_audio :mic, amp: 0.5
sleep 4
live_audio :mic, :stop`,
  },

  // Tier C PR #1 — state wrappers (use_*, with_*, current_*)
  use_arg_checks: {
    signature: 'use_arg_checks(true_or_false)',
    description: 'Enable or disable arg-name checking. When on, calls like `play 50, foo: 1` warn about the unknown opt `foo`. See with_arg_checks for a block-scoped variant.',
    params: [
      { name: 'true_or_false', type: 'boolean', desc: 'Whether to check arg names' },
    ],
    example: `play 50, release: 5  # Args are checked
use_arg_checks false
play 50, release: 5  # Args are not checked`,
  },
  with_arg_checks: {
    signature: 'with_arg_checks(true_or_false) do ... end',
    description: 'Block-scoped form of use_arg_checks — restores the previous setting after the block exits.',
    params: [
      { name: 'true_or_false', type: 'boolean', desc: 'Whether to check arg names inside the block' },
    ],
    example: `use_arg_checks true
with_arg_checks false do
  play 50, release: 3  # Args are not checked
end
play 90  # Args are checked again`,
  },
  use_timing_guarantees: {
    signature: 'use_timing_guarantees(true_or_false)',
    description: 'When true, synth and sample triggers are inhibited if the scheduler is running late. When false (default), late triggers still fire. See with_timing_guarantees for a block-scoped variant.',
    params: [
      { name: 'true_or_false', type: 'boolean', desc: 'Whether to drop late triggers' },
    ],
    example: `use_timing_guarantees true
sample :loop_amen  # dropped if even slightly late`,
  },
  with_timing_guarantees: {
    signature: 'with_timing_guarantees(true_or_false) do ... end',
    description: 'Block-scoped form of use_timing_guarantees — restores the previous setting after the block exits.',
    params: [
      { name: 'true_or_false', type: 'boolean', desc: 'Whether to drop late triggers inside the block' },
    ],
    example: `with_timing_guarantees true do
  sample :loop_amen  # dropped if late
end`,
  },
  use_merged_synth_defaults: {
    signature: 'use_merged_synth_defaults(opts)',
    description: 'Like use_synth_defaults, but merges the new opts with any existing defaults instead of replacing them.',
    params: [
      { name: 'opts', type: 'hash', desc: 'Default arg values to merge in' },
    ],
    example: `use_merged_synth_defaults amp: 0.5
play 50  # amp 0.5
use_merged_synth_defaults cutoff: 80
play 50  # amp 0.5 + cutoff 80`,
  },
  with_merged_synth_defaults: {
    signature: 'with_merged_synth_defaults(opts) do ... end',
    description: 'Block-scoped form of use_merged_synth_defaults — restores the previous defaults after the block exits.',
    params: [
      { name: 'opts', type: 'hash', desc: 'Default arg values to merge in for the block' },
    ],
    example: `with_merged_synth_defaults amp: 0.5, pan: 1 do
  play 50  # amp 0.5, pan 1
end`,
  },
  use_merged_sample_defaults: {
    signature: 'use_merged_sample_defaults(opts)',
    description: 'Like use_sample_defaults, but merges the new opts with any existing defaults instead of replacing them.',
    params: [
      { name: 'opts', type: 'hash', desc: 'Default arg values to merge in' },
    ],
    example: `use_merged_sample_defaults amp: 0.5, cutoff: 70
sample :loop_amen  # amp 0.5, cutoff 70
use_merged_sample_defaults cutoff: 90
sample :loop_amen  # amp 0.5, cutoff 90`,
  },
  with_merged_sample_defaults: {
    signature: 'with_merged_sample_defaults(opts) do ... end',
    description: 'Block-scoped form of use_merged_sample_defaults — restores the previous defaults after the block exits.',
    params: [
      { name: 'opts', type: 'hash', desc: 'Default arg values to merge in for the block' },
    ],
    example: `with_merged_sample_defaults cutoff: 90 do
  sample :loop_amen  # uses merged defaults
end`,
  },
  with_debug: {
    signature: 'with_debug(true_or_false) do ... end',
    description: 'Block-scoped form of use_debug — restores the previous debug setting after the block exits.',
    params: [
      { name: 'true_or_false', type: 'boolean', desc: 'Whether to log debug messages inside the block' },
    ],
    example: `with_debug false do
  play 50  # no debug log
end`,
  },
  current_timing_guarantees: {
    signature: 'current_timing_guarantees()',
    description: 'Return whether timing guarantees are currently active (true/false).',
    params: [],
    example: 'puts current_timing_guarantees',
  },

  // Tier C PR #2 — sample/buffer registry
  sample_paths: {
    signature: 'sample_paths(filter)',
    description: 'Return a ring of every sample name known to the engine (bundled catalog + any extra samples already loaded). In the browser, the optional `filter` is matched as a substring (not a filesystem glob).',
    params: [
      { name: 'filter', type: 'string', desc: 'Optional substring filter on sample names' },
    ],
    example: `puts sample_paths.length      # all bundled sample names
puts sample_paths "loop_amen" # names containing "loop_amen"`,
  },
  sample_buffer: {
    signature: 'sample_buffer(name)',
    description: 'Return a buffer-info object for a named sample. The browser stub exposes `.name` and `.duration` so code that reads `sample_buffer(:foo).duration` works. Recording into named buffers is not yet wired.',
    params: [
      { name: 'name', type: 'string|symbol', desc: 'Sample name' },
    ],
    example: 'puts sample_buffer(:loop_amen).duration',
  },
  sample_free: {
    signature: 'sample_free(name)',
    description: 'Drop a single sample from the loaded cache. The next `sample :name` call will re-load it. Returns true if it was loaded, false otherwise.',
    params: [
      { name: 'name', type: 'string|symbol', desc: 'Sample name to free' },
    ],
    example: `sample :loop_amen
sample_free :loop_amen   # frees from memory
sample :loop_amen        # re-loads`,
  },
  sample_free_all: {
    signature: 'sample_free_all()',
    description: 'Drop every sample from the loaded cache. Returns the number freed. Useful before benchmarks or under memory pressure.',
    params: [],
    example: `sample :loop_amen
sample :ambi_lunar_land
sample_free_all          # both freed
sample :loop_amen        # re-loads`,
  },
  load_samples: {
    signature: 'load_samples(*names)',
    description: 'Pre-load a list of bundled-catalog samples so the first `sample :name` call is instant (no first-load CDN fetch latency). Browser variant: takes one or more sample symbols/names — filesystem paths and globs are not supported.',
    params: [
      { name: 'names', type: 'symbols', desc: 'One or more bundled sample names' },
    ],
    example: 'load_samples :bd_haus, :sn_dub, :loop_amen',
  },
  buffer: {
    signature: 'buffer(name, duration?)',
    description: 'Browser stub for the desktop named-buffer API. Returns a buffer-info shape `{name, duration}` so code that reads `.duration` works. Recording into the buffer (via the `:record` FX) is not yet wired — duration defaults to 8 beats when the name is unknown.',
    params: [
      { name: 'name', type: 'string|symbol', desc: 'Buffer name' },
      { name: 'duration', type: 'number', default: '8', desc: 'Requested duration (beats)' },
    ],
    example: `b = buffer(:foo, 8)
puts b.duration   # => 8`,
  },

  // Tier C PR #3 — mixer + introspection
  set_mixer_control: {
    signature: 'set_mixer_control! opts',
    description: 'Control the main mixer that all sound passes through. Useful for sweeping a global lpf/hpf or trimming overall amp. Reset to defaults with reset_mixer!.',
    params: [
      { name: 'pre_amp', type: 'number', default: '1', desc: 'Amplitude before the FX stage' },
      { name: 'amp', type: 'number', default: '1', desc: 'Amplitude after the FX stage' },
      { name: 'lpf', type: 'number', default: '135.5', desc: 'Global low-pass cutoff (MIDI)' },
      { name: 'hpf', type: 'number', default: '0', desc: 'Global high-pass cutoff (MIDI)' },
      { name: 'lpf_bypass', type: 'number', default: '0', desc: 'Bypass global lpf (1 = bypass)' },
      { name: 'hpf_bypass', type: 'number', default: '0', desc: 'Bypass global hpf (1 = bypass)' },
    ],
    example: 'set_mixer_control! lpf: 30, lpf_slide: 16  # slide global lpf to 30 over 16 beats',
  },
  reset_mixer: {
    signature: 'reset_mixer!',
    description: 'Reset the main mixer to its default settings — undoes any changes made via set_mixer_control!.',
    params: [],
    example: `set_mixer_control! lpf: 70
sample :loop_amen
sleep 3
reset_mixer!
sample :loop_amen   # back to normal cutoff`,
  },
  scsynth_info: {
    signature: 'scsynth_info()',
    description: 'Return a flat dict of information about the running audio synthesiser (sample rate, control rate, bus counts, etc.). When no audio bridge is connected, returns a safe placeholder shape.',
    params: [],
    example: `info = scsynth_info
puts info.sample_rate        # => 44100
puts info.num_audio_busses   # => 1024`,
  },
  status: {
    signature: 'status()',
    description: 'Return a flat dict describing the synthesis environment (active ugens/synths/groups, CPU load, sample rate, bus counts). Mostly useful for debugging.',
    params: [],
    example: `s = status
puts s.synths     # currently active synths
puts s.avg_cpu    # average CPU load`,
  },
  vt: {
    signature: 'vt()',
    description: 'Return the current thread\'s virtual run time, in seconds. Alias of current_time.',
    params: [],
    example: `puts vt   # => 0
sleep 1
puts vt   # => 1`,
  },
  bt: {
    signature: 'bt(seconds)',
    description: 'Beat-time conversion — scales the given seconds to the current BPM (returns `seconds * 60 / bpm`). Useful for adding bpm scaling to a literal duration.',
    params: [
      { name: 'seconds', type: 'number', desc: 'Number to scale by current BPM' },
    ],
    example: `use_bpm 120
puts bt(1)   # => 0.5
use_bpm 30
puts bt(1)   # => 2`,
  },
  rt: {
    signature: 'rt(seconds)',
    description: 'Real-time conversion — bypasses BPM scaling, returning a value in beats that corresponds to a literal real-time duration (returns `seconds * bpm / 60`). Useful when you want a sleep that\'s always one wall-clock second regardless of BPM.',
    params: [
      { name: 'seconds', type: 'number', desc: 'Real-time seconds to convert to beats' },
    ],
    example: `use_bpm 120
sleep 1       # half a real second
sleep rt(1)   # a full real second`,
  },
}

// ---------------------------------------------------------------------------
// Synth descriptions (brief, for help panel)
// ---------------------------------------------------------------------------
const SYNTH_DESCRIPTIONS: Record<string, string> = {
  beep: 'Simple sine wave — clean, pure tone.',
  saw: 'Classic sawtooth wave — bright, buzzy.',
  sine: 'Pure sine wave — smooth, no harmonics.',
  square: 'Square wave — hollow, retro sound.',
  tri: 'Triangle wave — softer than square.',
  pulse: 'Pulse wave with adjustable width.',
  noise: 'White noise generator.',
  pnoise: 'Pink noise — less high frequency than white.',
  bnoise: 'Brown noise — deep, rumbling.',
  gnoise: 'Grey noise — perceptually flat.',
  cnoise: 'Clip noise — random +1/-1 values.',
  prophet: 'Detuned saw pair — thick, analog feel. Inspired by the Prophet synth.',
  tb303: 'Acid bass — squelchy filter, classic 303 sound.',
  supersaw: 'Multiple detuned saws — huge, wide lead.',
  dsaw: 'Detuned saw pair.',
  dpulse: 'Detuned pulse pair.',
  dtri: 'Detuned triangle pair.',
  pluck: 'Karplus-Strong plucked string.',
  pretty_bell: 'FM bell — bright, shimmery.',
  piano: 'Velocity-sensitive piano.',
  fm: 'FM synthesis — two-operator FM.',
  mod_fm: 'Modulated FM synthesis.',
  mod_saw: 'Amplitude-modulated sawtooth.',
  mod_pulse: 'Amplitude-modulated pulse.',
  mod_tri: 'Amplitude-modulated triangle.',
  chipbass: '8-bit bass — retro game style.',
  chiplead: '8-bit lead — retro game style.',
  chipnoise: '8-bit noise — retro game style.',
  dark_ambience: 'Dark, atmospheric pad with ring modulation.',
  hollow: 'Hollow resonant sound with noise.',
  growl: 'Growling bass synth.',
  zawa: 'Phasing wave with controllable shape.',
  blade: 'Vangelis-style pad with vibrato — lush, cinematic.',
  tech_saws: 'Multiple detuned saws — big techno lead.',
  sound_in: 'Live audio input (mono).',
  sound_in_stereo: 'Live audio input (stereo).',
}

// ---------------------------------------------------------------------------
// FX descriptions
// ---------------------------------------------------------------------------
const FX_DESCRIPTIONS: Record<string, string> = {
  reverb: 'Room reverb — adds space and depth.',
  echo: 'Echo/delay with feedback and decay.',
  delay: 'Simple delay line.',
  distortion: 'Waveshaping distortion — gritty, overdriven.',
  slicer: 'Amplitude slicer — rhythmic gating.',
  wobble: 'Wobble bass filter — LFO-controlled cutoff.',
  ixi_techno: 'Techno-style resonant filter sweep.',
  compressor: 'Dynamic range compressor.',
  rlpf: 'Resonant low-pass filter.',
  rhpf: 'Resonant high-pass filter.',
  hpf: 'High-pass filter.',
  lpf: 'Low-pass filter.',
  normaliser: 'Audio normaliser — keeps level consistent.',
  pan: 'Stereo panner.',
  band_eq: 'Band equalizer — boost/cut a frequency.',
  flanger: 'Flanger — sweeping comb filter.',
  krush: 'Lo-fi crusher with filter.',
  bitcrusher: 'Bit depth and sample rate reducer.',
  ring_mod: 'Ring modulation — metallic, bell-like.',
  chorus: 'Chorus — thickens with modulated delay.',
  octaver: 'Octave doubler — adds sub and super octaves.',
  vowel: 'Vowel formant filter.',
  tanh: 'Hyperbolic tangent distortion — warm saturation.',
  gverb: 'Large-space reverb with spread control.',
  pitch_shift: 'Pitch shifter — transpose audio up/down.',
  whammy: 'Whammy bar effect — granular pitch bend.',
  tremolo: 'Tremolo — amplitude modulation.',
  record: 'Record audio to a buffer.',
  sound_out: 'Route audio to a specific output.',
  sound_out_stereo: 'Route stereo audio to a specific output.',
  level: 'Volume control — adjusts amplitude.',
  mono: 'Mono mixer — collapses stereo to mono.',
  autotuner: 'Auto-tune to nearest note.',
}

// ---------------------------------------------------------------------------
// Generate synth entries
// ---------------------------------------------------------------------------
for (const [name, specific] of Object.entries(SYNTH_PARAMS)) {
  if (name === '_common' || HELP_DB[name]) continue
  const common = SYNTH_PARAMS._common ?? []
  const allParams = [...common, ...specific]
  const desc = SYNTH_DESCRIPTIONS[name] || `${name} synth.`
  HELP_DB[name] = {
    signature: `use_synth :${name}`,
    description: desc,
    params: allParams.map(p => ({ name: p, type: 'number', desc: '' })),
    example: `use_synth :${name}\nplay :c4, release: 0.5`,
  }
}

// ---------------------------------------------------------------------------
// Generate FX entries
// ---------------------------------------------------------------------------
for (const [name, specific] of Object.entries(FX_PARAMS)) {
  if (name === '_common' || HELP_DB[name]) continue
  const common = FX_PARAMS._common ?? []
  const allParams = [...common, ...specific]
  const desc = FX_DESCRIPTIONS[name] || `${name} effect.`
  HELP_DB[name] = {
    signature: `with_fx :${name}, opts do ... end`,
    description: desc,
    params: allParams.map(p => ({ name: p, type: 'number', desc: '' })),
    example: `with_fx :${name} do\n  play :c4\n  sleep 1\nend`,
  }
}

// ---------------------------------------------------------------------------
// Generate sample entries
// ---------------------------------------------------------------------------
for (const s of getAllSamples()) {
  if (HELP_DB[s.name]) continue
  HELP_DB[s.name] = {
    signature: `sample :${s.name}`,
    description: `${s.category} sample.`,
    params: [
      { name: 'amp', type: 'number', default: '1', desc: 'Volume (0-5)' },
      { name: 'rate', type: 'number', default: '1', desc: 'Playback rate (negative = reverse)' },
      { name: 'pan', type: 'number', default: '0', desc: 'Stereo pan (-1 to 1)' },
      { name: 'attack', type: 'number', default: '0', desc: 'Fade-in time in beats' },
      { name: 'release', type: 'number', desc: 'Fade-out time in beats' },
      { name: 'start', type: 'number', default: '0', desc: 'Start position (0-1)' },
      { name: 'finish', type: 'number', default: '1', desc: 'End position (0-1)' },
      { name: 'rpitch', type: 'number', default: '0', desc: 'Relative pitch in semitones' },
      { name: 'cutoff', type: 'number', desc: 'Low-pass filter cutoff (0-130)' },
    ],
    example: `sample :${s.name}`,
  }
}
