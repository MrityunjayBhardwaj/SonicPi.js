/**
 * ProgramBuilder — fluent chain API for constructing Programs.
 *
 * User code calls: b.play(60).sleep(0.5).sample("bd_haus")
 * Result: a Program (Step[]) that interpreters can walk.
 *
 * Random functions (choose, rrand, etc.) resolve eagerly at build
 * time using a seeded PRNG. The result is baked into the Program.
 */

import type { Step, Program } from './Program'
import { SeededRandom } from './SeededRandom'
import { noteToMidi, midiToFreq } from './NoteToFreq'
import { ring, knit, range, line, Ring } from './Ring'
import { spread } from './EuclideanRhythm'
import { chord, scale, chord_invert, note, note_range } from './ChordScale'

export class ProgramBuilder {
  private steps: Step[] = []
  private currentSynth = 'beep'
  private rng: SeededRandom
  private ticks = new Map<string, number>()

  constructor(seed: number = 0) {
    this.rng = new SeededRandom(seed)
  }

  play(noteVal: number | string, opts?: Record<string, number>): this {
    const midi = typeof noteVal === 'string' ? noteToMidi(noteVal) : noteVal
    const freq = midiToFreq(midi)
    const synth = (opts as Record<string, unknown>)?.synth as string | undefined
    const srcLine = opts?._srcLine
    const cleanOpts = { ...opts }
    delete cleanOpts._srcLine
    delete (cleanOpts as Record<string, unknown>).synth
    this.steps.push({
      tag: 'play',
      note: midi,
      opts: { freq, ...cleanOpts },
      synth: synth ?? this.currentSynth,
      srcLine,
    })
    return this
  }

  sleep(beats: number): this {
    this.steps.push({ tag: 'sleep', beats })
    return this
  }

  sample(name: string, opts?: Record<string, number>): this {
    const srcLine = opts?._srcLine
    const cleanOpts = { ...opts }
    delete cleanOpts._srcLine
    this.steps.push({ tag: 'sample', name, opts: cleanOpts, srcLine })
    return this
  }

  use_synth(name: string): this {
    this.currentSynth = name
    this.steps.push({ tag: 'useSynth', name })
    return this
  }

  use_bpm(bpm: number): this {
    this.steps.push({ tag: 'useBpm', bpm })
    return this
  }

  use_random_seed(seed: number): this {
    this.rng.reset(seed)
    return this
  }

  cue(name: string, ...args: unknown[]): this {
    this.steps.push({ tag: 'cue', name, args })
    return this
  }

  sync(name: string): this {
    this.steps.push({ tag: 'sync', name })
    return this
  }

  control(nodeRef: number, params: Record<string, number>): this {
    this.steps.push({ tag: 'control', nodeRef, params })
    return this
  }

  with_fx(name: string, opts: Record<string, number>, buildFn: (b: ProgramBuilder) => ProgramBuilder): this
  with_fx(name: string, buildFn: (b: ProgramBuilder) => ProgramBuilder): this
  with_fx(
    name: string,
    optsOrFn: Record<string, number> | ((b: ProgramBuilder) => ProgramBuilder),
    maybeFn?: (b: ProgramBuilder) => ProgramBuilder
  ): this {
    let opts: Record<string, number>
    let fn: (b: ProgramBuilder) => ProgramBuilder
    if (typeof optsOrFn === 'function') {
      opts = {}
      fn = optsOrFn
    } else {
      opts = optsOrFn
      fn = maybeFn!
    }
    const inner = new ProgramBuilder(this.rng.next() * 0xFFFFFFFF)
    inner.currentSynth = this.currentSynth
    fn(inner)
    this.steps.push({ tag: 'fx', name, opts, body: inner.build() })
    return this
  }

  stop(): this {
    this.steps.push({ tag: 'stop' })
    return this
  }

  puts(...args: unknown[]): this {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    this.steps.push({ tag: 'print', message: msg })
    return this
  }

  print(...args: unknown[]): this {
    return this.puts(...args)
  }

  // --- Random (resolved eagerly at build time) ---

  rrand(min: number, max: number): number {
    return this.rng.rrand(min, max)
  }

  rrand_i(min: number, max: number): number {
    return this.rng.rrand_i(min, max)
  }

  rand(max: number = 1): number {
    return this.rng.rrand(0, max)
  }

  rand_i(max: number = 2): number {
    return this.rng.rrand_i(0, max - 1)
  }

  choose<T>(arr: T[]): T {
    return this.rng.choose(arr)
  }

  dice(sides: number): number {
    return this.rng.dice(sides)
  }

  one_in(n: number): boolean {
    return this.rng.rrand_i(1, n) === 1
  }

  // --- Tick (resolved at build time, per-builder counter) ---

  tick(name: string = '__default'): number {
    const v = (this.ticks.get(name) ?? -1) + 1
    this.ticks.set(name, v)
    return v
  }

  look(name: string = '__default'): number {
    return this.ticks.get(name) ?? 0
  }

  // --- Data constructors (pure, no side effects) ---

  ring = ring
  knit = knit
  range = range
  line = line
  spread = spread
  chord = chord
  scale = scale
  chord_invert = chord_invert
  note = note
  note_range = note_range
  noteToMidi = noteToMidi
  midiToFreq = midiToFreq

  noteToFreq(n: string | number): number {
    return midiToFreq(noteToMidi(n))
  }

  /** Build the final Program. */
  build(): Program {
    return [...this.steps]
  }
}
