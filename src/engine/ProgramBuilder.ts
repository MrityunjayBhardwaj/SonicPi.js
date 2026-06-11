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
import { noteToMidi, noteToMidiStrict, midiToFreq, hzToMidi, noteInfo } from './NoteToFreq'
import { ring, knit, range, line, Ring, Ramp } from './Ring'
import { spread } from './EuclideanRhythm'
import { sampleDurationSeconds } from './SoundLayer'
import { chord, scale, chord_invert, note, note_range, chord_degree, degree, chord_names, scale_names } from './ChordScale'

/** Default maximum iterations before a loop is considered infinite. */
export const DEFAULT_LOOP_BUDGET = 100_000

/**
 * A range materialized by the transpiler (`case 'range'`, #508) is a plain array
 * annotated with its TRUE numeric endpoints. `rangeSpan` recovers `{from, to}`
 * from such a value so `rand`/`rand_i` can treat `a..b` as a continuous interval
 * (desktop semantics) rather than reading the array (which corrupts float ranges
 * and produced NaN). A non-range arg returns null → numeric fast-path. A bare
 * array (no annotation) falls back to [first, last] so it degrades to a sane
 * interval instead of NaN.
 */
interface RangeAnnotated extends Array<number> { __rangeFrom?: number; __rangeTo?: number }
function rangeSpan(arg: number | number[] | undefined): { from: number; to: number } | null {
  if (!Array.isArray(arg)) return null
  const a = arg as RangeAnnotated
  if (typeof a.__rangeFrom === 'number' && typeof a.__rangeTo === 'number') {
    return { from: a.__rangeFrom, to: a.__rangeTo }
  }
  if (a.length > 0) return { from: a[0], to: a[a.length - 1] }
  return null
}

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
  private _sampleDefaults: Record<string, number> = {}
  private _debug: boolean = true
  private _argChecks: boolean = true
  private _timingGuarantees: boolean = false
  private _argBpmScaling: boolean = true
  private _currentBpm: number = 60
  // Iteration-context fields for current_time / current_beat introspection (#226).
  // Set once per iteration by SonicPiEngine before invoking the user body callback.
  // _currentBeat persists across iterations via engine's loopBeats map; the other
  // two reset because the builder is recreated each iteration.
  private _iterationStartAudioTime: number = 0
  private _currentBuildSeconds: number = 0
  private _currentBeat: number = 0
  private _schedAheadTime: number = 0
  // SP95(d) #393: scheduler access for build-time sync resolution. When set
  // (the audio build path wires it before builderFn), `sync` awaits the
  // scheduler-resolved cue payload mid-build instead of pushing a runtime
  // step — so the value binds to `e` and post-sync reads (get / e[:val]) run
  // AFTER the cue fires. Null on manual / capture builders, which keep the
  // legacy runtime-step path (the QueryInterpreter never wires it, so an
  // S3 sync loop can't register a phantom waiter through the capture pass).
  private _syncScheduler: {
    waitForSync(name: string, taskId: string, argMatcher?: (args: unknown) => boolean): Promise<{ args: unknown[]; bpm: number }>
    getTask?(taskId: string): { virtualTime: number } | undefined
    // #498: a live `set` wakes an already-parked `sync` (desktop EventHistory.set
    // → @event_matchers.match). Optional — only the audio scheduler provides it.
    notifySet?(name: string, vt: number, idPath: number[], value: unknown): void
  } | null = null
  private _syncTaskId: string | null = null
  // SP95(d) #350 slice 2: the virtual-time-indexed Time State the engine wires
  // during build (setTimeStateContext). `b.set` writes EAGERLY here at
  // current_time() so the write lands before the loop's first await — giving a
  // cross-loop post-sync `get` a write-before-read happens-before by causation,
  // not by scheduler wake order. Null on builders that were never wired (the
  // deferred {tag:'set'} step still records the write at interpret time).
  private _timeState: {
    set(key: string | symbol, value: unknown, t: number, writerIdPath?: number[]): void
    get(key: string | symbol, t: number, readerIdPath?: number[]): unknown
  } | null = null
  // GAP A2 (#400): the owning task's thread-id path (desktop ThreadId). `b.set`
  // tags its write with it and `b.get` reads at it, so a same-virtual-time
  // cross-loop set/get resolves by the (t, idPath) total order (writer idPath ≤
  // reader idPath is visible). Defaults to `[0]` (main) until the engine wires
  // the real path via setTimeStateContext.
  private _ownerIdPath: number[] = [0]

  // Injected by the engine: returns a sample's decoded RAW buffer duration in
  // seconds, or undefined if not yet decoded. ProgramBuilder is otherwise pure
  // (no bridge access); this callback is the one seam to the async decode cache
  // (SuperSonicBridge.getSampleDuration). Needed so `sample_duration` /
  // `use_sample_bpm` derive from the real buffer length instead of the old
  // hardcoded `1` stub (#513/SV66). Inherited by sub-builders (with_fx/in_thread)
  // like _currentBpm so loop bodies can call `__b.sample_duration`.
  private _sampleDurationProvider?: (name: string) => number | undefined

  // #519: one-time warn seam for `use_sample_bpm` / `with_sample_bpm` when the
  // sample's duration is unknown (runtime-computed / unrecognized name → not
  // pre-decoded) so the tempo is left unchanged. The engine wires a deduping
  // closure (warns once per name via printHandler). Inherited by sub-builders
  // (with_fx/in_thread/at) like _sampleDurationProvider so the warn fires from
  // anywhere the no-op can occur, not just the top level.
  private _warnHandler?: (name: string) => void

  constructor(seed: number = 0, initialTicks?: Map<string, number>) {
    this.rng = new SeededRandom(seed)
    if (initialTicks) this.ticks = new Map(initialTicks)
  }

  /** Engine wires the sample-duration lookup (reads the bridge's decoded
   *  buffer durations). See `_sampleDurationProvider`. (#513) */
  setSampleDurationProvider(fn: (name: string) => number | undefined): this {
    this._sampleDurationProvider = fn
    return this
  }

  /** Engine wires the one-time warn closure for the `use_sample_bpm` /
   *  `with_sample_bpm` unknown-duration no-op. See `_warnHandler`. (#519) */
  setWarnHandler(fn: (name: string) => void): this {
    this._warnHandler = fn
    return this
  }

  /** Snapshot current tick state — saved by the engine between loop iterations. */
  getTicks(): Map<string, number> {
    return new Map(this.ticks)
  }

  get density(): number { return this.densityFactor }
  set density(d: number) { this.densityFactor = d }

  /** Returns the node reference of the last play() call, for use with control(). */
  get lastRef(): number { return this._lastRef }

  play(noteVal: number | string | Ring<number> | number[] | null | undefined, opts?: Record<string, unknown>): this {
    // Chord: Ring or array — push one play step per note (all at the same virtual time).
    if (noteVal instanceof Ring || Array.isArray(noteVal)) {
      const notes: number[] = noteVal instanceof Ring ? noteVal.toArray() : noteVal
      for (const n of notes) this._pushPlayStep(n, opts)
      return this
    }
    this._pushPlayStep(noteVal, opts)
    return this
  }

  private _pushPlayStep(noteVal: number | string | null | undefined, opts?: Record<string, unknown>): void {
    // :rest / nil — Desktop SP skips the synth trigger entirely
    if (noteVal === null || noteVal === undefined || noteVal === 'rest') return
    // B4 (#388): resolve string note names strictly. An unparseable name (e.g.
    // "not a note") yields NaN here instead of silently coercing to middle C;
    // the NaN note is carried with its original string so the dispatch-time
    // guard can skip it and name the bad input. Numeric notes pass through.
    let midi: number
    let noteName: string | undefined
    if (typeof noteVal === 'string') {
      const resolved = noteToMidiStrict(noteVal)
      if (Number.isNaN(resolved)) noteName = noteVal
      midi = resolved + this._transpose
    } else {
      midi = noteVal + this._transpose
    }
    const synth = opts?.synth as string | undefined
    const srcLine = opts?._srcLine as number | undefined
    // Strip non-numeric keys before storing; remaining values are synthesis params (all numbers).
    // Merge synth defaults first, then overlay explicit opts
    const cleanOpts = { ...this._synthDefaults, ...opts } as Record<string, number>
    delete (cleanOpts as Record<string, unknown>)._srcLine
    delete (cleanOpts as Record<string, unknown>).synth
    if (!this._argBpmScaling) cleanOpts._argBpmScaling = 0
    this._lastRef = this.nextRef++
    this.steps.push({
      tag: 'play',
      note: midi,
      opts: cleanOpts,
      synth: synth ?? this.currentSynth,
      srcLine,
      ...(noteName !== undefined ? { noteName } : {}),
    })
  }

  sleep(beats: number): this {
    const scaled = beats / this.densityFactor
    this.steps.push({ tag: 'sleep', beats: scaled })
    // Advance build-phase counters used by current_beat / current_time (#226).
    // _currentBeat matches Desktop SP's __get_spider_beat — sum of sleep arguments.
    // _currentBuildSeconds tracks the bpm-scaled seconds from this iteration's start.
    this._currentBeat += scaled
    this._currentBuildSeconds += (scaled * 60) / this._currentBpm
    // Reset budget on every sleep — loops with sleep are not infinite
    this._budgetRemaining = DEFAULT_LOOP_BUDGET
    return this
  }

  /** Alias for sleep — Sonic Pi accepts both. */
  wait(beats: number): this {
    return this.sleep(beats)
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
    // Merge sample defaults first, then overlay explicit opts
    const cleanOpts = { ...this._sampleDefaults, ...opts } as Record<string, number>
    delete (cleanOpts as Record<string, unknown>)._srcLine
    if (!this._argBpmScaling) cleanOpts._argBpmScaling = 0
    this.steps.push({ tag: 'sample', name, opts: cleanOpts, srcLine })
    return this
  }

  use_synth(name: string): this {
    this.currentSynth = name
    this.steps.push({ tag: 'useSynth', name })
    return this
  }

  use_bpm(bpm: number): this {
    this._currentBpm = bpm
    this.steps.push({ tag: 'useBpm', bpm })
    return this
  }

  /** Read-only view of the builder's current bpm. Used by SonicPiEngine when a
   *  nested `live_loop` registers from inside another's builderFn — the
   *  nested loop must inherit the *parent's* in-flight bpm (set by `b.use_bpm`
   *  during this build phase), not the engine-level `defaultBpm` (which is
   *  only mutated by top-level `use_bpm`). See SP72. */
  get currentBpm(): number { return this._currentBpm }

  /** Read-only view of the builder's current default synth. Same rationale as
   *  currentBpm: nested `live_loop` registrations need the parent's in-flight
   *  synth, not the engine-level `defaultSynth`. */
  get currentDefaultSynth(): string { return this.currentSynth }

  /**
   * Set BPM to match a sample's natural tempo. Desktop `sound.rb:542-552`:
   * disable bpm-scaling, read the RAW-seconds sample duration, then
   * `use_bpm(num_beats * 60.0 / raw_dur)`. `num_beats` (default 1) lets the
   * caller declare how many beats the sample spans (e.g. `num_beats: 4`).
   *
   * Guards div-by-zero: if the buffer duration is unknown (decode not done /
   * failed) the bpm is left UNCHANGED rather than set to Infinity (SV66).
   */
  use_sample_bpm(name: string, opts?: Record<string, unknown>): this {
    const o = (opts ?? {}) as Record<string, number>
    const numBeats = typeof o.num_beats === 'number' && o.num_beats > 0 ? o.num_beats : 1
    const rawSeconds = this.sampleDurationSeconds(name, opts)
    if (rawSeconds === undefined) {
      // unknown → keep current bpm, but warn once (#519) instead of silent no-op
      this._warnHandler?.(name)
      return this
    }
    return this.use_bpm(numBeats * (60.0 / rawSeconds))
  }

  /**
   * Raw playback length of a sample in seconds, honoring rate/start/finish/
   * sustain, or undefined when the buffer duration isn't decoded yet. The
   * provider returns the decoded buffer length; SoundLayer applies the opts
   * math (mirrors desktop `sound.rb:2236`). The bpm→beats conversion is the
   * caller's responsibility (use_sample_bpm wants seconds; sample_duration
   * wants beats).
   */
  private sampleDurationSeconds(name: string, opts?: Record<string, unknown>): number | undefined {
    const buffer = this._sampleDurationProvider?.(name)
    return sampleDurationSeconds(buffer, opts as Record<string, number> | undefined)
  }

  use_random_seed(seed: number): this {
    this.rng.reset(seed)
    return this
  }

  /** Read seed + idx — matches Desktop SP's current_random_seed. (#227) */
  current_random_seed(): number {
    return this.rng.getSeedPlusIdx()
  }

  /**
   * Roll the rand stream back by `amount` draws. Returns the value the next
   * `rand` would now produce (peek). Matches Desktop SP rand_back. (#227)
   */
  rand_back(amount: number = 1): number {
    this.rng.decIdx(amount)
    return this.rng.peek()
  }

  /**
   * Skip the rand stream forward by `amount` draws. Returns the value the next
   * `rand` would now produce (peek). Matches Desktop SP rand_skip. (#227)
   */
  rand_skip(amount: number = 1): number {
    this.rng.incIdx(amount)
    return this.rng.peek()
  }

  /** Reset rand stream to its last seed (equivalent to setIdx 0). (#227) */
  rand_reset(): this {
    this.rng.setIdx(0)
    return this
  }

  /**
   * Seed the per-iteration introspection state. Called by SonicPiEngine before
   * invoking the user's body callback.
   *
   * - `audioTime` is the task's virtualTime at iteration start (current_time)
   * - `beat` is the persisted across-iteration beat counter (current_beat)
   * - `schedAhead` is the engine's schedule-ahead window (current_sched_ahead_time)
   * - `bpm` (optional) seeds _currentBpm so current_beat_duration reflects the
   *    task's bpm without pushing a useBpm step. User's `use_bpm` inside the
   *    body still overrides per-step.
   * (#226)
   */
  setIterationContext(audioTime: number, beat: number, schedAhead: number, bpm?: number): void {
    this._iterationStartAudioTime = audioTime
    this._currentBeat = beat
    this._currentBuildSeconds = 0
    this._schedAheadTime = schedAhead
    if (bpm !== undefined) this._currentBpm = bpm
  }

  /**
   * SP95(d) #393: give this builder scheduler access so `sync` can await a
   * cue payload during build (audio path only). The scheduler is the SOLE
   * resolver — same invariant as scheduleSleep (SV2). Cleared implicitly by
   * builder recreation each iteration; manual / capture builders never call
   * this, so their `sync` keeps the legacy runtime-step behavior.
   */
  setSyncContext(
    scheduler: {
      waitForSync(name: string, taskId: string, argMatcher?: (args: unknown) => boolean): Promise<{ args: unknown[]; bpm: number }>
      getTask?(taskId: string): { virtualTime: number } | undefined
      notifySet?(name: string, vt: number, idPath: number[], value: unknown): void
    },
    taskId: string,
  ): void {
    this._syncScheduler = scheduler
    this._syncTaskId = taskId
  }

  /**
   * SP95(d) #350 slice 2: wire the virtual-time-indexed Time State so `b.set`
   * can apply eagerly at build current_time() and `b.get` can read at the
   * reader's current_time(). Set alongside setIterationContext/setSyncContext
   * during the engine's build setup; null on builders that never wire it.
   */
  setTimeStateContext(
    timeState: {
      set(key: string | symbol, value: unknown, t: number, writerIdPath?: number[]): void
      get(key: string | symbol, t: number, readerIdPath?: number[]): unknown
    },
    ownerIdPath: number[] = [0],
  ): void {
    this._timeState = timeState
    this._ownerIdPath = ownerIdPath
  }

  /** Read the build-phase beat counter (engine persists this across iterations). */
  get currentBeatRaw(): number { return this._currentBeat }

  /** Sum of `sleep` arguments since the loop started. Matches Desktop SP. (#226) */
  current_beat(): number { return this._currentBeat }

  /** Duration of one beat in seconds at the current bpm. (#226) */
  current_beat_duration(): number { return 60 / this._currentBpm }

  // Tier C PR #3 (#255). bt/rt are pure BPM math — NOT current_beat / current_time
  // wrappers (audit-corrected scope). vt is an alias of current_time (= the
  // thread's local virtual run time). Per-task bpm scoping matters: a
  // bt(1) inside a live_loop at use_bpm 120 must read THAT loop's bpm.
  bt(t: number): number { return t * 60 / this._currentBpm }
  rt(t: number): number { return t * this._currentBpm / 60 }
  vt(): number { return this.current_time() }

  /**
   * Logical (virtual) time in seconds at the current build position. Quantised
   * to the most recent sleep — matches Desktop SP's "wall-clock time quantised
   * to a nearby sleep point". (#226)
   */
  current_time(): number {
    return this._iterationStartAudioTime + this._currentBuildSeconds
  }

  /** Engine's schedule-ahead window in seconds. (#226) */
  current_sched_ahead_time(): number { return this._schedAheadTime }

  cue(name: string, ...args: unknown[]): this {
    this.steps.push({ tag: 'cue', name, args })
    return this
  }

  sync(name: string, opts?: { bpm_sync?: boolean; arg_matcher?: (args: unknown) => boolean }): this | Promise<unknown> {
    const bpmSync = opts?.bpm_sync === true
    const argMatcher = typeof opts?.arg_matcher === 'function' ? opts.arg_matcher : undefined
    // SP95(d) #393: build-time await path. The scheduler resolves the cue
    // payload through the SAME channel as sleep (a Promise only tick() can
    // resolve), so the build "blocks" in virtual time exactly like desktop's
    // `prom.get` (event_history.rb:221, krama SK15). The resolved payload
    // becomes sync's return value, so `e = sync :beat; e[:val]` binds the
    // real value and `play get(:root)` after a bare sync reads fresh state.
    //
    // Gated to plain `sync` only: `sync_bpm` still needs the runtime step to
    // mutate task.bpm mid-iteration (#236) — and only when a scheduler is
    // wired (audio path). Manual / capture builders fall through to the
    // legacy runtime step, returning `this` for chaining.
    if (!bpmSync && this._syncScheduler && this._syncTaskId !== null) {
      const taskId = this._syncTaskId
      const scheduler = this._syncScheduler
      // Capture pre-sync task vt so we can compute the delta the cue's wake
      // injected (waiterTask.virtualTime = cueVirtualTime, fireCue path). The
      // builder's current_time() = _iterationStartAudioTime + _currentBuildSeconds,
      // none of which advance on await; we add the delta into _currentBuildSeconds
      // so a post-sync b.get / b.set / current_time reads the cuer's vt, not the
      // syncer's frozen iteration-start. The plan's pre-mortem (a): "Confirm
      // current_time() advances across await b.sync ... before wiring" — this
      // closes that gap. (#350 / SV47 slice 2.)
      const taskBefore = scheduler.getTask?.(taskId)?.virtualTime
      return scheduler.waitForSync(name, taskId, argMatcher).then(
        (payload) => {
          const taskAfter = scheduler.getTask?.(taskId)?.virtualTime
          if (typeof taskBefore === 'number' && typeof taskAfter === 'number') {
            const delta = taskAfter - taskBefore
            // Defensive: a cue should advance the syncer's vt monotonically.
            // A negative delta would mean a cuer fired at a past vt — Slice 1's
            // strictly-after gate (VirtualTimeScheduler.ts:425) forbids that,
            // but guard anyway so we never rewind current_time().
            if (delta > 0) this._currentBuildSeconds += delta
          }
          return syncArgsToMap(payload.args)
        },
      )
    }
    this.steps.push(
      bpmSync
        ? { tag: 'sync', name, bpmSync: true, argMatcher }
        : { tag: 'sync', name, argMatcher },
    )
    return this
  }

  /**
   * sync_bpm — alias for sync with bpm_sync: true (#236).
   * Inherits both virtual time AND BPM from the cuer at wake time.
   * Matches desktop `core.rb:4490-4494`.
   */
  sync_bpm(name: string): this {
    // sync_bpm keeps the runtime-step path (it must mutate task.bpm mid-
    // iteration, #236), so it never takes sync's build-time await branch and
    // always returns `this`. Push the step directly to keep the return type.
    this.steps.push({ tag: 'sync', name, bpmSync: true })
    return this
  }

  control(nodeRef: number, params: Record<string, number>): this {
    const p = !this._argBpmScaling ? { ...params, _argBpmScaling: 0 } : params
    this.steps.push({ tag: 'control', nodeRef, params: p })
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
    // with_fx is a synchronous same-thread FX wrapper — tick map AND random
    // stream continue through it (#340/#341 + #343 Defect C). forkBuilder is
    // the single source of truth for sub-builder state threading.
    const inner = this.forkBuilder('same-thread')
    fn(inner, fxRef)
    const fxOpts = !this._argBpmScaling ? { ...opts, _argBpmScaling: 0 } : opts
    this.steps.push({ tag: 'fx', name, opts: fxOpts, body: inner.build(), nodeRef: fxRef })
    return this
  }

  in_thread(buildFn: (b: ProgramBuilder) => void): this
  in_thread(opts: Record<string, unknown>, buildFn: (b: ProgramBuilder) => void): this
  in_thread(
    optsOrFn: Record<string, unknown> | ((b: ProgramBuilder) => void),
    maybeFn?: (b: ProgramBuilder) => void
  ): this {
    // `in_thread name: :x do … end` passes an options hash first (desktop SP
    // supports name:/delay:/sync:/seed:). The transpiler faithfully emits
    // `in_thread({name:"x"}, fn)`; without this overload the hash landed in the
    // block slot and `buildFn(inner)` threw "buildFn is not a function" (#435).
    // Mirror with_fx's optsOrFn/maybeFn resolution.
    const buildFn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn
    if (typeof buildFn !== 'function') {
      throw new Error('in_thread requires a block')
    }
    // #447: `in_thread delay: N` — sleep N beats before the body (desktop
    // runtime.rb:1196 `sleep delay if delay`, in beats). Mirrors `at`'s offset
    // sleep. The opts hash was previously parsed only to find the block.
    const opts = typeof optsOrFn === 'object' ? optsOrFn : null
    const delayBeats = opts && typeof opts.delay === 'number' ? opts.delay : 0
    // in_thread forks a thread → fresh tick scope + re-seeded rng, but
    // inherits a snapshot of thread-locals (synth/bpm/transpose/density/
    // defaults/iteration introspection). #343 Defect: _currentBpm now threads.
    const inner = this.forkBuilder('forked')
    if (delayBeats > 0) inner.sleep(delayBeats)
    buildFn(inner)
    this.steps.push({ tag: 'thread', body: inner.build() })
    return this
  }

  at(times: number | number[], values: unknown[] | null, buildFn: (b: ProgramBuilder, ...args: unknown[]) => void): this {
    // Desktop SP accepts BOTH `at 1 do … end` (scalar) and `at [1, 2] do … end`
    // (array). Our transpiler currently emits a scalar unwrapped (`__b.at(1,
    // null, fn)`) and pre-#383 the runtime iterated `times.length` — `(1).length`
    // is `undefined`, the for-loop body never ran, and the callback silently
    // never fired. Normalize here so both call shapes work without depending
    // on the transpiler emitting consistent forms. (#383)
    const timesArr: number[] = Array.isArray(times) ? times : [times]
    for (let i = 0; i < timesArr.length; i++) {
      const offset = timesArr[i]
      const val = values ? values[i % values.length] : i
      // `at` forks a thread per time like in_thread. forkBuilder also threads
      // iteration introspection (#226 Defect B — `at` used to drop it) and
      // _currentBpm (#343 Defect A).
      const inner = this.forkBuilder('forked')
      if (offset > 0) inner.sleep(offset)
      buildFn(inner, val)
      this.steps.push({ tag: 'thread', body: inner.build() })
    }
    return this
  }

  /**
   * time_warp — run the block INLINE (same thread) with virtual time shifted by
   * `delta` beats, then RESTORE the pre-warp time (desktop `core.rb:1040-1092`,
   * `__with_preserved_spider_time_and_beat`). Unlike `at`/`in_thread` it does NOT
   * fork: ticks and the random stream are SHARED (forkBuilder('same-thread'),
   * SV45) — `with_swing` relies on the `tick` inside it advancing the surrounding
   * loop's stream. Negative deltas shift the block EARLIER in time (bounded by
   * schedAhead). A list of times runs the block once per time, each independently
   * preserved (params ring through). The shift is NOT density-scaled
   * (core.rb:1108), though sleeps inside the block are.
   */
  time_warp(times: number | number[], values: unknown[] | null, buildFn: (b: ProgramBuilder, ...args: unknown[]) => void): this {
    const timesArr: number[] = Array.isArray(times) ? times : [times]
    for (let i = 0; i < timesArr.length; i++) {
      const delta = timesArr[i]
      const val = values ? values[i % values.length] : i
      const inner = this.forkBuilder('same-thread')
      // Shift the build-phase clock by delta (NOT density-scaled) so
      // current_time / get inside the warp read the shifted time. The interpreter
      // applies the matching shift to task.virtualTime, then restores it.
      inner._currentBeat += delta
      inner._currentBuildSeconds += (delta * 60) / inner._currentBpm
      buildFn(inner, val)
      this.steps.push({ tag: 'timeWarp', deltaBeats: delta, body: inner.build() })
    }
    return this
  }

  /**
   * Single source of truth for which per-thread / per-build state threads into
   * a nested block's sub-builder. Replaces three hand-maintained copies that
   * had drifted (#343). Desktop SP semantics (ref/sources/desktop-sp):
   *  - 'same-thread' (with_fx): no thread fork → ALL thread-locals continue,
   *    including the tick map and the random STREAM, shared by reference.
   *  - 'forked' (in_thread / at): forks a thread → inherits a SNAPSHOT of
   *    thread-locals but gets a FRESH tick scope and a RE-SEEDED rng
   *    (runtime.rb:1062-1067 only re-seeds on a new thread).
   */
  private forkBuilder(mode: 'same-thread' | 'forked'): ProgramBuilder {
    // 'forked' re-seeds the rng from the parent stream (deterministic fork);
    // 'same-thread' shares the parent rng instance (set below) so the seed
    // here is irrelevant and must NOT consume from the parent stream.
    const inner = mode === 'forked'
      ? new ProgramBuilder(this.rng.next() * 0xFFFFFFFF)
      : new ProgramBuilder()
    // Common — inherited by every sub-builder regardless of mode.
    inner.currentSynth = this.currentSynth
    inner.densityFactor = this.densityFactor
    inner._argBpmScaling = this._argBpmScaling
    inner._transpose = this._transpose
    inner._synthDefaults = { ...this._synthDefaults }
    inner._sampleDefaults = { ...this._sampleDefaults }
    // #343 Defect A: use_bpm is thread-local in desktop SP (runtime.rb:155).
    // with_fx (same thread) continues it; in_thread/at snapshot it at fork.
    // Previously NO sub-builder inherited it → silent 2× tempo error.
    inner._currentBpm = this._currentBpm
    // #513: sub-builders (with_fx / in_thread / at) must reach the same sample
    // duration cache so `sample_duration` / `use_sample_bpm` inside them resolve
    // the real buffer length rather than falling back to the stub.
    inner._sampleDurationProvider = this._sampleDurationProvider
    // #519: sub-builders must reach the same one-time warn closure so an unknown
    // sample name inside with_fx/in_thread/at also warns (not just at top level).
    inner._warnHandler = this._warnHandler
    // #345: use_osc sets :sonic_pi_osc_client as a thread-local in desktop SP
    // (core.rb:649-653). Same SP94 drift class as #343 — the inherit-list
    // omitted this field. Same handling as _currentBpm: with_fx (same thread)
    // continues; in_thread/at snapshot at fork. Without this, `osc "/path"`
    // inside a sub-builder targets the default localhost:4560 instead of the
    // outer's use_osc target.
    inner._oscHost = this._oscHost
    inner._oscPort = this._oscPort
    // Iteration introspection (#226) so current_time / current_beat inside
    // with_fx / in_thread / at return the outer's values. #343 Defect B:
    // `at` used to drop these.
    inner._iterationStartAudioTime = this._iterationStartAudioTime
    inner._currentBuildSeconds = this._currentBuildSeconds
    inner._currentBeat = this._currentBeat
    inner._schedAheadTime = this._schedAheadTime
    if (mode === 'same-thread') {
      // with_fx forks no thread: tick map AND random stream continue. Sharing
      // the tick Map by reference is the #340/#341 fix; sharing the rng
      // instance is its seed-fork analog (#343 Defect C). 'forked' leaves
      // inner.ticks a fresh Map and inner.rng the re-seeded generator.
      inner.ticks = this.ticks
      inner.rng = this.rng
    }
    return inner
  }

  live_audio(name: string, optsOrStop?: Record<string, number> | 'stop', maybeOpts?: Record<string, number>): this {
    // `live_audio :name, :stop` (#236) — kills the named live_audio synth.
    // Symbols transpile to JS strings, so the second arg is "stop" when the
    // user writes `:stop`. Match upstream `sound.rb:195-197` which dispatches
    // on args[1] == :stop. Also accept `live_audio :name, :stop, opts` for
    // forward-compat though desktop ignores trailing args after :stop.
    if (optsOrStop === 'stop') {
      this.steps.push({ tag: 'liveAudio', name, opts: maybeOpts ?? {}, stop: true })
      return this
    }
    this.steps.push({ tag: 'liveAudio', name, opts: (optsOrStop as Record<string, number>) ?? {} })
    return this
  }

  stop(): this {
    this.steps.push({ tag: 'stop' })
    return this
  }

  /**
   * Stop a named live_loop at the scheduled time (issue #194).
   * Without this deferred step, `stop_loop :name` inside a live_loop
   * fires at BUILD time (beat 0), killing target loops before any
   * preceding `sleep` elapses — silent failure mode confirmed by
   * the welcome-buffer finale bug.
   */
  stop_loop(name: string): this {
    this.steps.push({ tag: 'stopLoop', name })
    return this
  }

  /** Free a running synth node immediately. */
  kill(nodeRef: number): this {
    this.steps.push({ tag: 'kill', nodeRef })
    return this
  }

  /**
   * Set master volume at the scheduled time (issue #197).
   * Without this deferred step, ducking patterns
   * (`set_volume 0.3; sleep 4; set_volume 1.0`) collapse: both calls
   * fire at beat 0, last-writer wins, no ducking.
   */
  set_volume(vol: number): this {
    this.steps.push({ tag: 'setVolume', vol })
    return this
  }

  // --- Mixer setters (Tier C PR #3, #255) — deferred steps -----------------
  // Fire at scheduled virtual time so sweeps sequence against playback.
  // `set_mixer_control!` accepts an opts hash (pre_amp/amp/hpf/lpf/*_bypass);
  // `reset_mixer!` restores the MIXER config defaults. Cross-engine ethic:
  // arity is enforced where the step pushes (here), not in the bridge.

  set_mixer_control(opts: Record<string, number>): this {
    if (typeof opts !== 'object' || opts === null) {
      throw new TypeError(`set_mixer_control! expects an opts hash, got ${typeof opts}`)
    }
    this.steps.push({ tag: 'setMixerControl', opts })
    return this
  }

  reset_mixer(...args: unknown[]): this {
    if (args.length > 0) {
      throw new Error(`reset_mixer! expects no arguments, got ${args.length}`)
    }
    this.steps.push({ tag: 'resetMixer' })
    return this
  }

  // --- Recording (#228) — deferred steps -----------------------------------
  // Lifecycle is sequenced against the scheduled program, not the build
  // pass. The user's mental model is "start, play 8 notes, stop, save" —
  // running them at build time fires save before any audio plays.
  // Cross-engine arity ethic: rest args + length guard so passing extras
  // errors instead of silently swallowing.

  recording_start(...args: unknown[]): this {
    if (args.length > 0) {
      throw new Error(`recording_start expects no arguments, got ${args.length}`)
    }
    this.steps.push({ tag: 'recordingStart' })
    return this
  }

  recording_stop(...args: unknown[]): this {
    if (args.length > 0) {
      throw new Error(`recording_stop expects no arguments, got ${args.length}`)
    }
    this.steps.push({ tag: 'recordingStop' })
    return this
  }

  recording_save(...args: unknown[]): this {
    if (args.length === 0 || args.length > 1) {
      throw new Error(`recording_save expects 1 argument (filename), got ${args.length}`)
    }
    const filename = args[0]
    if (typeof filename !== 'string') {
      throw new Error(`recording_save: filename must be a string, got ${typeof filename}`)
    }
    this.steps.push({ tag: 'recordingSave', filename })
    return this
  }

  recording_delete(...args: unknown[]): this {
    if (args.length > 0) {
      throw new Error(`recording_delete expects no arguments, got ${args.length}`)
    }
    this.steps.push({ tag: 'recordingDelete' })
    return this
  }

  // --- OSC: deferred (issue #196) ---
  /**
   * Builder-captured OSC defaults for the `osc` shorthand. `use_osc`
   * mutates these synchronously at build time AND emits a deferred
   * `useOsc` step (the latter is for cross-task visibility).
   * `osc(path, ...)` reads these at build time and pushes a deferred
   * `oscSend` step using the captured destination.
   */
  private _oscHost = 'localhost'
  private _oscPort = 4560

  use_osc(host: string, port: number): this {
    this._oscHost = host
    this._oscPort = port
    this.steps.push({ tag: 'useOsc', host, port })
    return this
  }

  /** Emit an OSC message to the use_osc-set default destination. */
  osc(path: string, ...args: unknown[]): this {
    this.steps.push({ tag: 'oscSend', host: this._oscHost, port: this._oscPort, path, args })
    return this
  }

  /** Emit an OSC message — the host provides the actual transport. */
  osc_send(host: string, port: number, path: string, ...args: unknown[]): this {
    this.steps.push({ tag: 'oscSend', host, port, path, args })
    return this
  }

  // --- MIDI output: 14 deferred entry points (issue #195) ---
  // All push a `midiOut` step with a `kind` discriminator. The interpreter
  // dispatches at scheduled virtual time. Auto note-off for `midi(...)` is
  // BPM-aware (sustain in beats → seconds via the task's current bpm).

  /** midi shorthand: note-on + auto note-off after `sustain` beats. */
  midi(note: number | string, opts: Record<string, number | string> = {}): this {
    const sustain = (opts.sustain as number) ?? 1
    const velocity = (opts.velocity as number) ?? (opts.vel as number) ?? 100
    const channel = (opts.channel as number) ?? 1
    this.steps.push({ tag: 'midiOut', kind: 'noteOn', args: [note, velocity, channel] })
    // Schedule note-off via virtual-time-aware sleep+off pair handled by interpreter:
    // we encode the off as a 'noteOff' step with a beat offset. Interpreter resolves
    // the offset to seconds using the task's current bpm.
    this.steps.push({ tag: 'midiOut', kind: 'noteOff', args: [note, channel, sustain] })
    return this
  }

  midi_note_on(note: number | string, velocity: number = 100, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'noteOn', args: [note, velocity, opts.channel ?? 1] })
    return this
  }

  midi_note_off(note: number | string, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'noteOff', args: [note, opts.channel ?? 1, 0] })
    return this
  }

  midi_cc(controller: number, value: number, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'cc', args: [controller, value, opts.channel ?? 1] })
    return this
  }

  midi_pitch_bend(val: number, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'pitchBend', args: [val, opts.channel ?? 1] })
    return this
  }

  midi_channel_pressure(val: number, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'channelPressure', args: [val, opts.channel ?? 1] })
    return this
  }

  midi_poly_pressure(note: number, val: number, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'polyPressure', args: [note, val, opts.channel ?? 1] })
    return this
  }

  midi_prog_change(program: number, opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'progChange', args: [program, opts.channel ?? 1] })
    return this
  }

  midi_clock_tick(): this {
    this.steps.push({ tag: 'midiOut', kind: 'clockTick', args: [] })
    return this
  }

  midi_start(): this {
    this.steps.push({ tag: 'midiOut', kind: 'start', args: [] })
    return this
  }

  midi_stop(): this {
    this.steps.push({ tag: 'midiOut', kind: 'stop', args: [] })
    return this
  }

  midi_continue(): this {
    this.steps.push({ tag: 'midiOut', kind: 'continue', args: [] })
    return this
  }

  midi_all_notes_off(opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'allNotesOff', args: [opts.channel ?? 1] })
    return this
  }

  midi_notes_off(opts: Record<string, number> = {}): this {
    this.steps.push({ tag: 'midiOut', kind: 'allNotesOff', args: [opts.channel ?? 1] })
    return this
  }

  /** Play multiple notes simultaneously as a chord. */
  play_chord(notes: number | string | Ring<number> | number[], opts?: Record<string, unknown>): this {
    return this.play(notes, opts)
  }

  /** Play notes sequentially with sleep(1) between each. */
  play_pattern(notes: (number | string)[], opts?: Record<string, unknown>): this {
    for (const n of notes) {
      this.play(n, opts)
      this.sleep(1)
    }
    return this
  }

  /**
   * Tier B PR #2 (#233) — block-form tuplet scheduling.
   *
   * `tuplets [70, [72, 72], 70, [82, 82, 82]] do |n| play n end`
   *   - Bare element → `block.call(n); sleep duration` (default 1 beat).
   *   - Sub-list of size N → fits N `block + sleep` calls into `duration`
   *     beats by wrapping in `with_density(N)`.
   *
   * Optional `swing:` opt offsets every Nth tuplet by that many beats via
   * `at([swing], …)`. Swing is density-scaled inside sub-lists so the
   * offset stays proportional to the local pulse. Mirrors upstream
   * `core.rb:486-512`. Pre-resolved at build time (the block runs N times
   * synchronously, pushing N play+sleep step pairs); the resulting steps
   * fire at scheduled virtual time exactly like a hand-written sequence.
   */
  tuplets<T = unknown>(
    tuplet_list: ReadonlyArray<T | ReadonlyArray<T>> | Ring<T | T[]>,
    optsOrFn:
      | { duration?: number; swing?: number; swing_pulse?: number; swing_offset?: number }
      | ((b: ProgramBuilder, value: T) => void),
    maybeFn?: (b: ProgramBuilder, value: T) => void,
  ): this {
    const opts = typeof optsOrFn === 'function' ? {} : optsOrFn
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn
    if (typeof fn !== 'function') {
      throw new Error('tuplets requires a block')
    }

    const duration = opts.duration ?? 1
    const swing = opts.swing ?? 0
    const swing_pulse = opts.swing_pulse ?? 2
    const swing_offset = (opts.swing_offset ?? 0) + 1

    const items = tuplet_list instanceof Ring
      ? tuplet_list.toArray()
      : Array.from(tuplet_list)

    for (const el of items) {
      if (Array.isArray(el)) {
        const n = el.length
        this.with_density(n, b => {
          el.forEach((tuplet, idx) => {
            const should_swing =
              swing !== 0 &&
              (n % swing_pulse === 0) &&
              ((idx + swing_offset) % swing_pulse === 0)
            if (should_swing) {
              // Density-scale the swing so the offset stays proportional
              // to the local pulse (mirrors upstream's __with_spider_time_density
              // which time-scales everything inside the block).
              b.at([swing / n], null, inner => fn(inner, tuplet as T))
            } else {
              fn(b, tuplet as T)
            }
            b.sleep(duration)
          })
        })
      } else {
        fn(this, el as T)
        this.sleep(duration)
      }
    }
    return this
  }

  /** Return the current synth name. */
  get current_synth_name(): string { return this.currentSynth }

  /**
   * Tier B PR #2 (#233) — defaults / setting introspection. All four are
   * called bare (`puts current_debug`) so they're methods returning a value,
   * not getters — see BARE_CALLABLE in TreeSitterTranspiler.ts which emits
   * `__b.NAME()` with parens.
   */
  current_synth_defaults(): Record<string, number> { return { ...this._synthDefaults } }
  current_sample_defaults(): Record<string, number> { return { ...this._sampleDefaults } }
  current_debug(): boolean { return this._debug }
  /**
   * We don't validate synth arg names against synthinfo — unknown args are
   * silently dropped at SoundLayer normalization. Returning the upstream
   * default (`true`) keeps existing user code that branches on this read
   * working. When `use_arg_checks` ships in Tier C, this becomes a real read.
   */
  current_arg_checks(): boolean { return this._argChecks }
  current_timing_guarantees(): boolean { return this._timingGuarantees }

  /**
   * `set` does BOTH (SP95(d) #350 slice 2, Decision Q3):
   *   1. EAGERLY writes to the Time State at current_time() — synchronously,
   *      during build, before the loop's first await. This is the ORDERING fix:
   *      a cross-loop post-sync `get` (a microtask queued by the cuer's cue) can
   *      only run once the writer yields, so the eager write happens-before it
   *      by causation — independent of scheduler wake order.
   *   2. STILL pushes the deferred {tag:'set'} step (SV20/SP41 contract — set
   *      stays a builder method with a step, DslBuilderContract green) for the
   *      QueryInterpreter / capture / event-stream paths.
   * The timestamp is current_time() AT the call, which has already advanced by
   * any preceding intra-iteration b.sleep — so `set :x,1; sleep 2; set :x,2`
   * records x=1@T and x=2@(T+2) (SV20 preserved). The interpreter's deferred
   * `case 'set'` is a no-op on the Time State path so this stays the single
   * write per (key, build-vt) — no phantom shadow entry at a different vt.
   */
  set(key: string | symbol, value: unknown): this {
    // GAP A2: tag the write with the owning task's idPath so a same-vt reader
    // resolves it by the (t, idPath) total order (#400).
    this._timeState?.set(key, value, this.current_time(), this._ownerIdPath)
    // #498: desktop's EventHistory.set runs @event_matchers.match after the
    // insert (event_history.rb:204), so a `set` wakes an already-parked `sync`,
    // not just the set-before-sync case the history-first scan covers. The eager
    // write above already landed `value` in the shared store; notifySet only runs
    // the match. Audio path only (the scheduler is the sole waiter holder); the
    // capture / query builders never wire it, so an S3 sync there can't be woken.
    this._syncScheduler?.notifySet?.(String(key), this.current_time(), this._ownerIdPath, value)
    this.steps.push({ tag: 'set', key, value })
    return this
  }

  /**
   * `get` reads the Time State at the READER's virtual time (SP95(d) #350
   * slice 2). Routing through the builder (rather than the shared
   * SonicPiEngine `get` closure) makes the reader vt come from the body's OWN
   * builder — SV28-safe across interleaved/awaited builds, the same reason
   * Slice 1 routed `sync` through `b.sync`.
   *
   * Returns a Proxy callable so BOTH Sonic Pi forms resolve to the same
   * vt-aware lookup:
   *   - `get(:k)`  → transpiles to `__b.get("k")` → the Proxy's apply trap
   *   - `get[:k]`  → transpiles to `__b.get["k"]` → the Proxy's get trap
   * Reads `current_time()` AT the call site (post-sync, post-sleep), never a
   * cached value. Falls back to the no-vt facade (latest value) if no Time
   * State is wired. `?? null` matches the prior sandbox-get behavior.
   */
  get get(): ((key: string | symbol) => unknown) & Record<string | symbol, unknown> {
    const read = (key: string | symbol): unknown => {
      if (!this._timeState) return null
      // GAP A2: read at the owning task's idPath so the (t, idPath) tiebreak
      // resolves a same-vt cross-loop write by writer-idPath ≤ reader-idPath (#400).
      return this._timeState.get(key, this.current_time(), this._ownerIdPath) ?? null
    }
    return new Proxy(read, {
      apply(_target, _thisArg, args) {
        return read(args[0] as string | symbol)
      },
      get(target, property, receiver) {
        // Real function internals (name, length, call, apply, Symbol.*) fall
        // through to the function so the value stays a normal callable.
        if (typeof property === 'symbol' || property in target) {
          return Reflect.get(target, property, receiver)
        }
        return read(property)
      },
    }) as ((key: string | symbol) => unknown) & Record<string | symbol, unknown>
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

  rand(...args: (number | number[])[]): number {
    if (args.length > 1) {
      throw new Error(
        `wrong number of arguments to rand (given ${args.length}, expected 0..1). ` +
        `For a [min, max] range, use rrand(min, max) instead.`
      )
    }
    // rand(a..b) — desktop returns a random float WITHIN the range. The
    // transpiler materializes a Ruby range to an array annotated with its true
    // endpoints (#508); read them so float ranges (0.01..2) keep their real max.
    const span = rangeSpan(args[0])
    if (span) return this.rng.rrand(span.from, span.to)
    const max = (args[0] as number) ?? 1
    return this.rng.rrand(0, max)
  }

  rand_i(...args: (number | number[])[]): number {
    if (args.length > 1) {
      throw new Error(
        `wrong number of arguments to rand_i (given ${args.length}, expected 0..1). ` +
        `For a [min, max] integer range, use rrand_i(min, max) instead.`
      )
    }
    // rand_i(a..b) — desktop returns a random INTEGER within the range (inclusive).
    const span = rangeSpan(args[0])
    if (span) return this.rng.rrand_i(span.from, span.to)
    const max = (args[0] as number) ?? 2
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

  /**
   * Rotate an array or Ring by n positions (default 1). Positive = left,
   * matching Ruby `Array#rotate` / `Ring.rotate`. Returns a Ring (#430). Used
   * by the transpiler for `.rotate` / `.rotate!` (bang stripped, copy
   * semantics) — see `transpileReceiverMethodCall`.
   */
  rotate<T>(arr: T[] | Ring<T>, n: number = 1): Ring<T> {
    const ring = arr instanceof Ring ? arr : new Ring([...arr])
    return ring.rotate(n)
  }

  pick<T>(arr: T[] | Ring<T>, n: number = 1): Ring<T> {
    const items = arr instanceof Ring ? arr.toArray() : [...arr]
    const result: T[] = []
    for (let i = 0; i < n; i++) {
      result.push(items[Math.floor(this.rng.next() * items.length)])
    }
    return new Ring(result)
  }

  /** Random distribution — returns a value between -max and +max. */
  rdist(max: number, centre: number = 0): number {
    return centre + this.rng.rrand(-max, max)
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

  /** Set a named tick counter to a specific value. Subsequent `tick(name)` returns value+step. */
  tick_set(nameOrValue: string | number, value?: number): void {
    if (typeof nameOrValue === 'number') {
      this.ticks.set('__default', nameOrValue)
    } else {
      this.ticks.set(nameOrValue, value ?? 0)
    }
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

  /** Temporarily shift by N octaves within block, then restore. */
  with_octave(octaves: number, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._transpose
    this._transpose = prev + (octaves * 12)
    buildFn(this)
    this._transpose = prev
    return this
  }

  /** Run block with a specific random seed, then restore. */
  with_random_seed(seed: number, buildFn: (b: ProgramBuilder) => void): this {
    const prevState = this.rng.getState()
    this.rng.reset(seed)
    buildFn(this)
    this.rng.setState(prevState)
    return this
  }

  // --- Synth defaults ---

  /** Set default synthesis parameters for all subsequent play calls. */
  use_synth_defaults(opts: Record<string, number>): this {
    this._synthDefaults = { ...opts }
    return this
  }

  /** Set default sample parameters for all subsequent sample calls. */
  use_sample_defaults(opts: Record<string, number>): this {
    this._sampleDefaults = { ...opts }
    return this
  }

  /** Temporarily set synth defaults for a block, then restore. */
  with_synth_defaults(opts: Record<string, number>, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._synthDefaults
    this._synthDefaults = { ...opts }
    buildFn(this)
    this._synthDefaults = prev
    return this
  }

  /** Temporarily set sample defaults for a block, then restore. */
  with_sample_defaults(opts: Record<string, number>, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._sampleDefaults
    this._sampleDefaults = { ...opts }
    buildFn(this)
    this._sampleDefaults = prev
    return this
  }

  /** Merge new opts into the existing synth defaults (vs `use_synth_defaults` which replaces). */
  use_merged_synth_defaults(opts: Record<string, number>): this {
    this._synthDefaults = { ...this._synthDefaults, ...opts }
    return this
  }

  /** Merge new opts into the existing sample defaults. */
  use_merged_sample_defaults(opts: Record<string, number>): this {
    this._sampleDefaults = { ...this._sampleDefaults, ...opts }
    return this
  }

  /** Block-form merge of synth defaults — restores the previous map after the block. */
  with_merged_synth_defaults(opts: Record<string, number>, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._synthDefaults
    this._synthDefaults = { ...prev, ...opts }
    buildFn(this)
    this._synthDefaults = prev
    return this
  }

  /** Block-form merge of sample defaults — restores the previous map after the block. */
  with_merged_sample_defaults(opts: Record<string, number>, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._sampleDefaults
    this._sampleDefaults = { ...prev, ...opts }
    buildFn(this)
    this._sampleDefaults = prev
    return this
  }

  // --- BPM block ---

  /** Temporarily set BPM for a block. Sleeps inside are scaled. Restores previous BPM after. */
  with_bpm(bpm: number, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._currentBpm
    this._currentBpm = bpm
    this.steps.push({ tag: 'useBpm', bpm })
    buildFn(this)
    this._currentBpm = prev
    this.steps.push({ tag: 'useBpm', bpm: prev })
    return this
  }

  /**
   * Block-scoped form of `use_sample_bpm` (#518). Desktop `sound.rb:588`:
   * `with_sample_bpm(name, num_beats: 1, &block)` reads the sample's RAW-seconds
   * duration then `with_bpm(num_beats * 60.0 / dur, &block)` — the same BPM math
   * as `use_sample_bpm`, applied through the block-scoped `with_bpm` (sets bpm
   * for the block, restores after) instead of the rest-of-thread `use_bpm`.
   *
   * The transpiler emits either `with_sample_bpm(name, opts, fn)` or
   * `with_sample_bpm(name, fn)` (opts elided when none) — same variadic shape as
   * with_fx — so `buildFn` may arrive as the 2nd or 3rd argument.
   *
   * When the buffer duration is unknown (runtime-computed / unrecognized name →
   * not pre-decoded) the block STILL runs at the current bpm — a block wrapper
   * must always execute its body — and we warn once (#519), unlike a plain
   * setting which can no-op silently.
   */
  with_sample_bpm(
    name: string,
    optsOrFn: Record<string, unknown> | ((b: ProgramBuilder) => void),
    maybeFn?: (b: ProgramBuilder) => void,
  ): this {
    const buildFn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn!
    const opts = typeof optsOrFn === 'function' ? undefined : optsOrFn
    const o = (opts ?? {}) as Record<string, number>
    const numBeats = typeof o.num_beats === 'number' && o.num_beats > 0 ? o.num_beats : 1
    const rawSeconds = this.sampleDurationSeconds(name, opts)
    if (rawSeconds === undefined) {
      // unknown → block runs at the current bpm; warn once (#519)
      this._warnHandler?.(name)
      buildFn(this)
      return this
    }
    return this.with_bpm(numBeats * (60.0 / rawSeconds), buildFn)
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

  /** Permanently set density factor — divides sleep times. */
  use_density(factor: number): this {
    this.densityFactor = factor
    return this
  }

  /** Run block with density factor — divides sleep times. */
  with_density(factor: number, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this.densityFactor
    this.densityFactor = prev * factor
    buildFn(this)
    this.densityFactor = prev
    return this
  }

  /**
   * with_swing — run the block through `time_warp(shift)` on every `pulse`-th
   * call, inline otherwise, producing a swing feel (#356). Desktop
   * `core.rb:382-404`: `use_shift = ((tick(key) + offset) % pulse) == 0`. The
   * tick uses a SEPARATE key (`:swing` by default) so it never clashes with the
   * loop's own `tick`; it persists across iterations (the loop's tick map), so
   * call N swings iff `(N + offset) % pulse == 0`. Args come as an opts object
   * from the transpiler: `{ shift, pulse, tick, offset }` (positional shift/pulse/
   * tick/offset folded into it). Defaults: shift 0.1, pulse 4, tick :swing,
   * offset 0.
   */
  with_swing(opts: Record<string, unknown>, buildFn: (b: ProgramBuilder) => void): this {
    const shift = typeof opts.shift === 'number' ? opts.shift : 0.1
    const pulse = typeof opts.pulse === 'number' ? opts.pulse : 4
    const key = opts.tick != null ? String(opts.tick) : 'swing'
    const offset = typeof opts.offset === 'number' ? opts.offset : 0
    const useShift = ((this.tick(key) + offset) % pulse) === 0
    if (useShift) {
      this.time_warp(shift, null, buildFn)
    } else {
      buildFn(this)
    }
    return this
  }

  /** Enable/disable debug output. In browser, this is a no-op flag. */
  use_debug(enabled: boolean): this {
    this._debug = enabled
    return this
  }

  /** Set schedule-ahead time to 0 for this thread — responsive MIDI input (#149). */
  use_real_time(): this {
    this.steps.push({ tag: 'useRealTime' })
    return this
  }

  /**
   * Control whether time params (release, attack, phase, etc.) are automatically
   * BPM-scaled. Default: true (matching Desktop Sonic Pi).
   * With false, time params are treated as seconds, not beats.
   */
  use_arg_bpm_scaling(enabled: boolean): this {
    this._argBpmScaling = enabled
    return this
  }

  /** Temporarily set arg_bpm_scaling for a block, then restore. */
  with_arg_bpm_scaling(enabled: boolean, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._argBpmScaling
    this._argBpmScaling = enabled
    buildFn(this)
    this._argBpmScaling = prev
    return this
  }

  /**
   * Toggle synth-arg validation. Default: true. We always validate today, so
   * this primarily exists to gate the validator without surprising users
   * coming from desktop. `current_arg_checks` reads the same flag.
   */
  use_arg_checks(enabled: boolean): this {
    this._argChecks = enabled
    return this
  }

  /** Block-form arg-checks toggle — restores previous flag after the block. */
  with_arg_checks(enabled: boolean, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._argChecks
    this._argChecks = enabled
    buildFn(this)
    this._argChecks = prev
    return this
  }

  /** Block-form debug toggle — restores previous flag after the block. */
  with_debug(enabled: boolean, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._debug
    this._debug = enabled
    buildFn(this)
    this._debug = prev
    return this
  }

  /**
   * Toggle strict-timing mode. Desktop SP drops synth dispatches that miss
   * their schedule window; in the browser our scheduler is already best-effort
   * with a generous lookahead, so the flag is recorded for parity but doesn't
   * change behavior today. `current_timing_guarantees` reads the same flag.
   */
  use_timing_guarantees(enabled: boolean): this {
    this._timingGuarantees = enabled
    return this
  }

  /** Block-form timing-guarantees toggle — restores previous flag after the block. */
  with_timing_guarantees(enabled: boolean, buildFn: (b: ProgramBuilder) => void): this {
    const prev = this._timingGuarantees
    this._timingGuarantees = enabled
    buildFn(this)
    this._timingGuarantees = prev
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
   * `stretch([1,2,3], 2)` → Ring([1,1,2,2,3,3]). Repeat each element n times.
   * Ruby invocation `[1,2,3].stretch(2)` is the Ring method; this is the bare form.
   */
  stretch<T>(arr: T[] | Ring<T>, n: number): Ring<T> {
    const items = arr instanceof Ring ? arr.toArray() : [...arr]
    const result: T[] = []
    for (const item of items) {
      for (let i = 0; i < n; i++) result.push(item)
    }
    return new Ring(result)
  }

  /**
   * `ramp(60, 64, 67)` → non-cycling ring: clamps to last value instead of wrapping.
   * Used for envelope-shape iteration that should hold the final value.
   */
  ramp<T>(...values: T[]): Ramp<T> {
    return new Ramp(values)
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
    // Desktop sound.rb:1281-1287 sleeps after EVERY note, including the last
    // (`notes.each_with_index { play(note); sleep(duration) }`). Omitting the
    // final sleep advances (n-1)·dt instead of n·dt — a single-note pattern
    // would advance zero beats, collapsing the timeline (#404).
    for (let i = 0; i < notes.length; i++) {
      this.play(notes[i], opts)
      this.sleep(timeArr[i % timeArr.length])
    }
    return this
  }

  /**
   * Duration of a sample in BEATS at the current bpm — Desktop SP's default
   * (bpm-scaling ON divides the raw seconds by the sleep multiplier,
   * `sound.rb:2276`). So `sleep sample_duration(:loop_amen)` advances exactly
   * one buffer's worth of time at any bpm.
   *
   * beats = raw_seconds / sleep_mul, sleep_mul = 60 / bpm  ⇒  raw_seconds * bpm / 60.
   * Falls back to 1 beat when the buffer duration isn't decoded yet (the old
   * stub value — never NaN/Infinity into a `sleep`). (#513/SV66)
   */
  sample_duration(name: string, opts?: Record<string, unknown>): number {
    const rawSeconds = this.sampleDurationSeconds(name, opts)
    if (rawSeconds === undefined) return 1
    return (rawSeconds * this._currentBpm) / 60
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
  note_info = noteInfo

  noteToFreq(n: string | number): number {
    return midiToFreq(noteToMidi(n))
  }

  // --- Wave 1 DSL additions ---

  hz_to_midi = hzToMidi
  midi_to_hz = midiToFreq
  chord_degree = chord_degree
  degree = degree
  chord_names = chord_names
  scale_names = scale_names

  /** Round val to nearest multiple of step. */
  quantise(val: number, step: number): number {
    return Math.round(val / step) * step
  }

  /** Alias for quantise (US spelling). */
  quantize(val: number, step: number): number {
    return this.quantise(val, step)
  }

  /** Generate a ring of notes spanning n octaves from root. */
  octs(note: number, numOctaves: number = 1): Ring<number> {
    return new Ring(Array.from({ length: numOctaves }, (_, i) => note + i * 12))
  }

  /** Build the final Program. */
  build(): Program {
    return [...this.steps]
  }
}

/**
 * SP95(d) #393: shape the cue args into `sync`'s Ruby-equivalent return value.
 * Desktop `cue :beat, val: X` → `e = sync :beat` makes `e` the kwargs map, so
 * `e[:val]` (transpiled `e["val"]`) reads X. Mirrors Sonic Pi's splat of cue
 * args back to the synced thread:
 *   - no args        → {}            (bare `cue :name`; bare `sync` ignores it)
 *   - one arg        → that arg      (kwargs hash → indexable; scalar → as-is)
 *   - many args      → the array     (positional `cue :n, 1, 2`)
 */
function syncArgsToMap(args: unknown[]): unknown {
  if (args.length === 0) return {}
  if (args.length === 1) return args[0]
  return args
}
