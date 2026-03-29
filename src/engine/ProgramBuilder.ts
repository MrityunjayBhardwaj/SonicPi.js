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

/** Default maximum iterations before a loop is considered infinite. */
export const DEFAULT_LOOP_BUDGET = 100_000

export class InfiniteLoopError extends Error {
  constructor(message = 'Infinite loop detected — did you forget a sleep?') {
    super(message)
    this.name = 'InfiniteLoopError'
  }
}

export class ProgramBuilder {
  private steps: Step[] = []
  private currentSynth = 'beep'
  private rng: SeededRandom
  private ticks = new Map<string, number>()
  private densityFactor: number = 1
  private nextRef: number = 1
  private _lastRef: number = 0
  private _budgetRemaining: number = DEFAULT_LOOP_BUDGET
  private _transpose: number = 0
  private _synthDefaults: Record<string, number> = {}
  private _debug: boolean = true

  constructor(seed: number = 0, initialTicks?: Map<string, number>) {
    this.rng = new SeededRandom(seed)
    if (initialTicks) this.ticks = new Map(initialTicks)
  }

  /** Snapshot current tick state — saved by the engine between loop iterations. */
  getTicks(): Map<string, number> {
    return new Map(this.ticks)
  }

  get density(): number { return this.densityFactor }
  set density(d: number) { this.densityFactor = d }

  /** Returns the node reference of the last play() call, for use with control(). */
  get lastRef(): number { return this._lastRef }

  play(noteVal: number | string | Ring<number> | number[], opts?: Record<string, unknown>): this {
    // Chord: Ring or array — push one play step per note (all at the same virtual time).
    if (noteVal instanceof Ring || Array.isArray(noteVal)) {
      const notes: number[] = noteVal instanceof Ring ? noteVal.toArray() : noteVal
      for (const n of notes) this._pushPlayStep(n, opts)
      return this
    }
    this._pushPlayStep(noteVal, opts)
    return this
  }

  private _pushPlayStep(noteVal: number | string, opts?: Record<string, unknown>): void {
    const midi = (typeof noteVal === 'string' ? noteToMidi(noteVal) : noteVal) + this._transpose
    const synth = opts?.synth as string | undefined
    const srcLine = opts?._srcLine as number | undefined
    // Strip non-numeric keys before storing; remaining values are synthesis params (all numbers).
    // Merge synth defaults first, then overlay explicit opts
    const cleanOpts = { ...this._synthDefaults, ...opts } as Record<string, number>
    delete (cleanOpts as Record<string, unknown>)._srcLine
    delete (cleanOpts as Record<string, unknown>).synth
    this._lastRef = this.nextRef++
    this.steps.push({
      tag: 'play',
      note: midi,
      opts: cleanOpts,
      synth: synth ?? this.currentSynth,
      srcLine,
    })
  }

  sleep(beats: number): this {
    this.steps.push({ tag: 'sleep', beats: beats / this.densityFactor })
    // Reset budget on every sleep — loops with sleep are not infinite
    this._budgetRemaining = DEFAULT_LOOP_BUDGET
    return this
  }

  /**
   * Decrement loop iteration budget. Throws InfiniteLoopError when budget
   * is exhausted. Injected by the transpiler at loop back-edges.
   */
  __checkBudget__(): void {
    if (--this._budgetRemaining <= 0) {
      throw new InfiniteLoopError()
    }
  }

  sample(name: string, opts?: Record<string, unknown>): this {
    const srcLine = opts?._srcLine as number | undefined
    // Strip internal keys before storing; remaining values are sample playback params.
    const cleanOpts = { ...opts } as Record<string, number>
    delete (cleanOpts as Record<string, unknown>)._srcLine
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

  with_fx(name: string, opts: Record<string, number>, buildFn: (b: ProgramBuilder, fxRef?: number) => ProgramBuilder): this
  with_fx(name: string, buildFn: (b: ProgramBuilder, fxRef?: number) => ProgramBuilder): this
  with_fx(
    name: string,
    optsOrFn: Record<string, number> | ((b: ProgramBuilder, fxRef?: number) => ProgramBuilder),
    maybeFn?: (b: ProgramBuilder, fxRef?: number) => ProgramBuilder
  ): this {
    let opts: Record<string, number>
    let fn: (b: ProgramBuilder, fxRef?: number) => ProgramBuilder
    if (typeof optsOrFn === 'function') {
      opts = {}
      fn = optsOrFn
    } else {
      opts = optsOrFn
      fn = maybeFn!
    }
    // Assign a nodeRef so the FX can be targeted by control()
    const fxRef = this.nextRef++
    this._lastRef = fxRef
    const inner = new ProgramBuilder(this.rng.next() * 0xFFFFFFFF)
    inner.currentSynth = this.currentSynth
    inner.densityFactor = this.densityFactor
    fn(inner, fxRef)
    this.steps.push({ tag: 'fx', name, opts, body: inner.build(), nodeRef: fxRef })
    return this
  }

  in_thread(buildFn: (b: ProgramBuilder) => void): this {
    const inner = new ProgramBuilder(this.rng.next() * 0xFFFFFFFF)
    inner.currentSynth = this.currentSynth
    inner.densityFactor = this.densityFactor
    buildFn(inner)
    this.steps.push({ tag: 'thread', body: inner.build() })
    return this
  }

  at(times: number[], values: unknown[] | null, buildFn: (b: ProgramBuilder, ...args: unknown[]) => void): this {
    for (let i = 0; i < times.length; i++) {
      const offset = times[i]
      const val = values ? values[i % values.length] : i
      const inner = new ProgramBuilder(this.rng.next() * 0xFFFFFFFF)
      inner.currentSynth = this.currentSynth
      inner.densityFactor = this.densityFactor
      if (offset > 0) inner.sleep(offset)
      buildFn(inner, val)
      this.steps.push({ tag: 'thread', body: inner.build() })
    }
    return this
  }

  live_audio(name: string, opts?: Record<string, number>): this {
    this.steps.push({ tag: 'liveAudio', name, opts: opts ?? {} })
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

  rand_look(): number {
    return this.rng.peek()
  }

  choose<T>(arr: T[]): T {
    return this.rng.choose(arr)
  }

  shuffle<T>(arr: T[] | Ring<T>): Ring<T> {
    const items = arr instanceof Ring ? arr.toArray() : [...arr]
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.rng.rrand_i(0, i)
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return new Ring(items)
  }

  pick<T>(arr: T[] | Ring<T>, n: number = 1): Ring<T> {
    const items = arr instanceof Ring ? arr.toArray() : [...arr]
    const result: T[] = []
    for (let i = 0; i < n; i++) {
      result.push(items[Math.floor(this.rng.next() * items.length)])
    }
    return new Ring(result)
  }

  dice(sides: number, bonus: number = 0): number {
    return this.rng.dice(sides) + bonus
  }

  one_in(n: number): boolean {
    return this.rng.rrand_i(1, n) === 1
  }

  // --- Tick (resolved at build time, per-builder counter) ---

  tick(name: string = '__default', opts?: { step?: number }): number {
    const step = opts?.step ?? 1
    const v = (this.ticks.get(name) ?? -step) + step
    this.ticks.set(name, v)
    return v
  }

  look(name: string = '__default', offset: number = 0): number {
    return (this.ticks.get(name) ?? 0) + offset
  }

  /** Reset a named tick counter (or the default counter). */
  tick_reset(name: string = '__default'): void {
    this.ticks.delete(name)
  }

  /** Reset ALL tick counters. */
  tick_reset_all(): void {
    this.ticks.clear()
  }

  // --- Transpose ---

  /** Set transpose offset (semitones) for all subsequent play calls. */
  use_transpose(semitones: number): this {
    this._transpose = semitones
    return this
  }

  /** Temporarily set transpose for a block, then restore. */
  with_transpose(semitones: number, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._transpose
    this._transpose = semitones
    buildFn(this)
    this._transpose = prev
    return this
  }

  // --- Synth defaults ---

  /** Set default synthesis parameters for all subsequent play calls. */
  use_synth_defaults(opts: Record<string, number>): this {
    this._synthDefaults = { ...opts }
    return this
  }

  // --- BPM block ---

  /** Temporarily set BPM for a block. Sleeps inside are scaled. */
  with_bpm(bpm: number, buildFn: (b: ProgramBuilder) => void): this {
    this.steps.push({ tag: 'useBpm', bpm })
    buildFn(this)
    return this
  }

  /** Temporarily set synth for a block, then restore. */
  with_synth(name: string, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this.currentSynth
    this.currentSynth = name
    this.steps.push({ tag: 'useSynth', name })
    buildFn(this)
    this.currentSynth = prev
    this.steps.push({ tag: 'useSynth', name: prev })
    return this
  }

  // --- Debug ---

  /** Enable/disable debug output. In browser, this is a no-op flag. */
  use_debug(enabled: boolean): this {
    this._debug = enabled
    return this
  }

  // --- Utility functions ---

  /**
   * Returns true if `val` is divisible by `factor`.
   * Sonic Pi's `factor?(val, factor)` → `val % factor === 0`
   */
  factor_q(val: number, factor: number): boolean {
    return val % factor === 0
  }

  /**
   * Create a ring of booleans from 0/1 values.
   * `bools(1,0,1,0)` → Ring([true, false, true, false])
   */
  bools(...values: number[]): Ring<boolean> {
    return new Ring(values.map(v => v !== 0))
  }

  /**
   * Play a sequence of notes with timed intervals.
   * `play_pattern_timed [:c4, :e4, :g4], [0.5, 0.25]`
   */
  play_pattern_timed(
    notes: (number | string)[],
    times: number | number[],
    opts?: Record<string, unknown>
  ): this {
    const timeArr = Array.isArray(times) ? times : [times]
    for (let i = 0; i < notes.length; i++) {
      this.play(notes[i], opts)
      if (i < notes.length - 1) {
        this.sleep(timeArr[i % timeArr.length])
      }
    }
    return this
  }

  /**
   * Get the duration of a sample in beats. Stub: returns 1.
   * Real implementation needs SuperSonic bridge access.
   */
  sample_duration(_name: string, _opts?: Record<string, unknown>): number {
    return 1
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
