import { VirtualTimeScheduler, DEFAULT_SCHED_AHEAD_TIME } from './VirtualTimeScheduler'
import { ProgramBuilder } from './ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from './interpreters/AudioInterpreter'
import { queryLoopProgram, type QueryEvent } from './interpreters/QueryInterpreter'
import { SuperSonicBridge, type SuperSonicBridgeOptions } from './SuperSonicBridge'
import { normalizeFxParams } from './SoundLayer'
import { transpile } from './Transpiler'
import { createIsolatedExecutor, validateCode, type ScopeHandle } from './Sandbox'
import { autoTranspileDetailed } from './RubyTranspiler'
import { initTreeSitter, isTreeSitterReady, treeSitterTranspile } from './TreeSitterTranspiler'
import { friendlyError, formatFriendlyError, type FriendlyError } from './FriendlyErrors'
import { detectStratum, Stratum } from './Stratum'
import { SoundEventStream } from './SoundEventStream'
import { ring, knit, range, line } from './Ring'
import { MidiBridge } from './MidiBridge'
import { spread } from './EuclideanRhythm'
import { noteToMidi, midiToFreq, noteToFreq, hzToMidi } from './NoteToFreq'
import { chord, scale, chord_invert, note, note_range, chord_degree, degree, chord_names, scale_names } from './ChordScale'
import { getSampleNames, getCategories } from './SampleCatalog'
import type { Program } from './Program'

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** 4-character base-36 suffix — enough entropy for unique in-session loop names. */
const randomSuffix = (): string => randomSuffix()

// ---------------------------------------------------------------------------
// Engine interfaces
// ---------------------------------------------------------------------------

export interface EngineComponents {
  /** Sound event stream for visualization and logging. */
  streaming: { eventStream: SoundEventStream }
  /** Audio context and analyser node for scope/recording. */
  audio: { analyser: AnalyserNode; audioCtx: AudioContext; trackAnalysers?: Map<string, AnalyserNode> }
  /** Capture query for deterministic (S1/S2) code introspection. */
  capture: { queryRange(begin: number, end: number): Promise<QueryEvent[]> }
}

// ---------------------------------------------------------------------------
// SonicPiEngine
// ---------------------------------------------------------------------------

export class SonicPiEngine {
  private scheduler: VirtualTimeScheduler | null = null
  private bridge: SuperSonicBridge | null = null
  private eventStream = new SoundEventStream()
  private initialized = false
  private playing = false
  private runtimeErrorHandler: ((err: Error) => void) | null = null
  private printHandler: ((msg: string) => void) | null = null
  private currentCode = ''
  private currentStratum: Stratum = Stratum.S1
  private bridgeOptions: SuperSonicBridgeOptions
  private schedAheadTime: number
  /** Maps DSL nodeRef → SuperSonic nodeId for control messages */
  private nodeRefMap = new Map<number, number>()
  /** Reusable inner FX nodes — persists across loop iterations. See issue #70. */
  private reusableFx = new Map<string, { bus: number; groupId: number; nodeId: number; outBus: number }>()
  /** Pending volume to apply when bridge initializes */
  private pendingVolume: number | null = null
  /** Stored builder functions for capture/query path */
  private loopBuilders = new Map<string, (b: ProgramBuilder) => void>()
  /** Per-loop seed counters for deterministic random */
  private loopSeeds = new Map<string, number>()
  /** Per-loop tick counters — persisted across iterations so ring.tick() advances correctly */
  private loopTicks = new Map<string, Map<string, number>>()
  /** Tracks which loops have completed their initial sync — persists across hot-swaps. */
  private loopSynced = new Set<string>()
  /** Persistent top-level FX state — keyed by scope ID, shared across loops in same with_fx. */
  private persistentFx = new Map<string, { buses: number[]; groups: number[]; outBus: number }>()
  /** Maps loop name → FX scope ID (loops under same with_fx share a scope). */
  private loopFxScope = new Map<string, string>()
  /** Maps FX scope ID → FX chain definition. */
  private fxScopeChains = new Map<string, Array<{ name: string; opts: Record<string, number> }>>()
  /**
   * MIDI I/O bridge — exposed for shell-level device management (listing devices,
   * opening ports, registering event handlers). Not intended for direct note
   * triggering from application code; use the DSL functions (`midi_note_on`,
   * `midi_cc`, etc.) inside `live_loop` blocks instead, so events are
   * scheduler-aware and time-stamped correctly.
   */
  readonly midiBridge = new MidiBridge()
  /** Global key-value store — shared across all loops via get/set */
  private globalStore = new Map<string | symbol, unknown>()

  get schedAhead(): number { return this.schedAheadTime }

  constructor(options?: {
    bridge?: SuperSonicBridgeOptions
    schedAheadTime?: number
  }) {
    this.bridgeOptions = options?.bridge ?? {}
    this.schedAheadTime = options?.schedAheadTime ?? DEFAULT_SCHED_AHEAD_TIME
  }

  /**
   * Initialize the engine. Must be called once before `evaluate()`.
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * Audio initializes via SuperSonic (WebAssembly). If that fails (e.g. in
   * test environments or when WebAssembly is blocked), the engine continues
   * without audio — the scheduler still runs and `capture` queries still work.
   * Check `hasAudio` after `init()` to know whether audio is available.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    this.bridge = new SuperSonicBridge(this.bridgeOptions)

    // Initialize SuperSonic and tree-sitter in parallel
    const bridgeInit = this.bridge.init()
      .then(() => {
        if (this.pendingVolume !== null) {
          this.bridge!.setMasterVolume(this.pendingVolume)
        }
        // Wire OSC trace logging — shows exactly what params are sent to scsynth,
        // matching desktop Sonic Pi's trace format for easy comparison.
        this.bridge!.setOscTraceHandler((msg) => {
          if (this.printHandler) this.printHandler(msg)
        })
      })
      .catch((err) => {
        console.warn('[SonicPi] SuperSonic init failed, running without audio:', err)
        this.bridge = null
      })

    // Only init tree-sitter in browser environments where WASM is served via HTTP.
    // In Node (tests), tree-sitter must be initialized explicitly with file paths.
    const isBrowser = typeof window !== 'undefined'
    const treeSitterInit = isBrowser
      ? initTreeSitter().catch(() => { /* Non-fatal — regex fallback */ })
      : Promise.resolve()

    await Promise.all([bridgeInit, treeSitterInit])

    // Wire MIDI input events → scheduler cues so `sync '/midi/note_on'` works.
    // The handler reads this.scheduler at fire-time (always the current scheduler).
    this.midiBridge.onMidiEvent((event) => {
      const sched = this.scheduler
      if (!sched) return
      const cueName = `/midi/${event.type}`
      sched.fireCue(cueName, '__midi__', [event])
    })

    this.initialized = true
  }

  /** Whether audio output is available. False when SuperSonic failed to initialize. */
  get hasAudio(): boolean {
    return this.bridge !== null
  }

  /**
   * Evaluate and schedule a Sonic Pi program.
   *
   * Accepts Ruby DSL syntax (auto-transpiled) or raw JS builder code.
   * On the first call, `play()` must be called afterward to start the scheduler.
   * On subsequent calls while playing, loops are hot-swapped in place.
   *
   * Returns `{ error }` on syntax or runtime errors during evaluation.
   * Does NOT throw — check the return value. Runtime errors inside `live_loop`
   * bodies after the scheduler has started are delivered via `setRuntimeErrorHandler`.
   */
  async evaluate(code: string): Promise<{ error?: Error }> {
    if (!this.initialized) {
      return { error: new Error('SonicPiEngine not initialized — call init() first') }
    }

    try {
      this.currentCode = code
      this.currentStratum = detectStratum(code)

      const isReEvaluate = this.scheduler !== null && this.playing

      // First run or after stop: create fresh scheduler
      if (!isReEvaluate) {
        if (this.scheduler) {
          this.scheduler.dispose()
        }

        const audioCtx = this.bridge?.audioContext
        this.scheduler = new VirtualTimeScheduler({
          getAudioTime: () => audioCtx?.currentTime ?? 0,
          schedAheadTime: this.schedAheadTime,
        })

        this.scheduler.onLoopError((loopName, err) => {
          const msg = `Error in loop '${loopName}': ${err.message}`
          if (this.runtimeErrorHandler) this.runtimeErrorHandler(err)
          if (this.printHandler) this.printHandler(msg)
          else console.error('[SonicPi]', msg)
        })

        this.loopBuilders.clear()
        this.loopSeeds.clear()
      }

      // Transpile: Ruby DSL → JS builder chain
      // Primary: tree-sitter catamorphism. Fallback: regex transpiler.
      let transpiledCode: string
      if (isTreeSitterReady()) {
        const tsResult = treeSitterTranspile(code)
        if (tsResult.ok) {
          transpiledCode = tsResult.code
        } else {
          // Tree-sitter failed — fall back to regex
          const warnMsg = `[Warning] Tree-sitter transpile failed (${tsResult.errors[0] ?? 'unknown'}), using regex fallback`
          if (this.printHandler) this.printHandler(warnMsg)
          else console.warn('[SonicPi]', warnMsg)
          const regexResult = autoTranspileDetailed(code)
          transpiledCode = transpile(regexResult.code).code
        }
      } else {
        // Tree-sitter not available — use regex transpiler
        const regexResult = autoTranspileDetailed(code)
        if (regexResult.usedFallback) {
          const warnMsg = `[Warning] Parser fell back to regex transpiler: ${regexResult.fallbackReason}`
          if (this.printHandler) this.printHandler(warnMsg)
          else console.warn('[SonicPi]', warnMsg)
        }
        transpiledCode = transpile(regexResult.code).code
      }

      // Top-level DSL state
      let defaultBpm = 60
      let defaultSynth = 'beep'
      const scheduler = this.scheduler!

      const topLevelUseBpm = (bpm: number) => { defaultBpm = bpm }
      const topLevelUseSynth = (name: string) => { defaultSynth = name }

      // Collection map for re-evaluate hot-swap path
      const pendingLoops = new Map<string, () => Promise<void>>()
      const pendingDefaults = new Map<string, { bpm: number; synth: string }>()

      // Top-level print handler
      const topLevelPuts = (...args: unknown[]) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        if (this.printHandler) this.printHandler(msg)
        else console.log('[SonicPi]', msg)
      }

      // Top-level stop sentinel
      const topLevelStop = () => {
        // At top level, stop just halts evaluation
      }

      // stop_loop :name — stop a named loop from any context
      const stop_loop = (name: string): void => {
        scheduler.stopLoop(name)
      }

      // Scope handle — set when executor is created, used to isolate loop scopes
      let scopeHandle: ScopeHandle | null = null

      const wrappedLiveLoop = (name: string, builderFnOrOpts: ((b: ProgramBuilder) => void) | Record<string, unknown>, maybeFn?: (b: ProgramBuilder) => void) => {
        // Support both: live_loop("name", fn) and live_loop("name", {sync: "x"}, fn)
        let builderFn: (b: ProgramBuilder) => void
        let syncTarget: string | null = null
        if (typeof builderFnOrOpts === 'function') {
          builderFn = builderFnOrOpts
        } else {
          syncTarget = (builderFnOrOpts.sync as string) ?? null
          builderFn = maybeFn!
        }
        // Allocate track bus for per-loop AnalyserNode (visualization only).
        // Synths write to bus 0 so the scsynth mixer (Limiter.ar, gain staging) processes them.
        // Track buses are NOT used as outBus — that would bypass the mixer entirely.
        this.bridge?.allocateTrackBus(name)

        // Store builder function for capture path
        this.loopBuilders.set(name, builderFn)
        if (!this.loopSeeds.has(name)) {
          // Seed derived from loop name — each loop gets a unique PRNG sequence
          // (matches desktop Sonic Pi's per-loop deterministic seeding)
          let hash = 0
          for (let i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
          }
          this.loopSeeds.set(name, Math.abs(hash))
        }

        // Create the async function that builds a Program each iteration
        // and runs it via AudioInterpreter
        const asyncFn = async () => {
          // sync: option — wait for the cue ONCE before the first iteration only.
          // Uses engine-level loopSynced set so the flag persists across hot-swaps.
          // Sonic Pi: sync: is passed to in_thread, called ONCE before loop starts.
          // Thread keeps running on Update — define() replaces the fn, send() picks it up.
          if (syncTarget && !this.loopSynced.has(name)) {
            this.loopSynced.add(name)
            await scheduler.waitForSync(syncTarget, name)
          }

          const task = scheduler.getTask(name)
          if (!task) return

          // Persistent top-level FX: create FX nodes on first iteration only.
          // Loops under the same with_fx scope share one FX chain (keyed by scope ID).
          // First loop to iterate creates the nodes; others reuse the same bus.
          const scopeId = this.loopFxScope.get(name)
          if (scopeId && !this.persistentFx.has(scopeId) && this.bridge) {
            const fxChain = this.fxScopeChains.get(scopeId)
            if (fxChain && fxChain.length > 0) {
              const audioTime = task.virtualTime + this.schedAheadTime
              let currentOutBus = task.outBus
              const buses: number[] = []
              const groups: number[] = []

              // Create FX chain: outermost first
              // Signal flow: synth → innermost FX bus → ... → outermost FX → output
              for (const fx of fxChain) {
                const bus = this.bridge.allocateBus()
                const groupId = this.bridge.createFxGroup()
                const fxOpts = normalizeFxParams(fx.name, fx.opts, task.bpm)
                await this.bridge.applyFx(fx.name, audioTime, fxOpts, bus, currentOutBus)
                this.bridge.flushMessages()
                buses.push(bus)
                groups.push(groupId)
                currentOutBus = bus
              }

              this.persistentFx.set(scopeId, { buses, groups, outBus: currentOutBus })
            }
          }

          // Apply persistent FX bus — synths write to shared FX input bus
          if (scopeId) {
            const fxState = this.persistentFx.get(scopeId)
            if (fxState) {
              task.outBus = fxState.outBus
            }
          }

          const seed = this.loopSeeds.get(name) ?? 0
          this.loopSeeds.set(name, seed + 1)

          const builder = new ProgramBuilder(seed, this.loopTicks.get(name))
          // Apply the loop's synth default (set by top-level use_synth)
          if (task.currentSynth && task.currentSynth !== 'beep') {
            builder.use_synth(task.currentSynth)
          }
          // Enter per-loop scope so variable writes are isolated
          scopeHandle?.enterScope(name)
          try {
            builderFn(builder)
          } finally {
            scopeHandle?.exitScope()
          }
          // Persist tick state so ring.tick() / tick() advance across iterations
          this.loopTicks.set(name, builder.getTicks())
          const program = builder.build()

          await runProgram(program, {
            bridge: this.bridge,
            scheduler,
            taskId: name,
            eventStream: this.eventStream,
            schedAheadTime: this.schedAheadTime,
            printHandler: this.printHandler ?? undefined,
            nodeRefMap: this.nodeRefMap,
            reusableFx: this.reusableFx,
            globalStore: this.globalStore,
          })

          // Auto-cue the loop name after each iteration.
          // In Sonic Pi, `live_loop :foo` auto-cues `:foo` on each iteration
          // so that `live_loop :bar, sync: :foo` can synchronize to it.
          scheduler.fireCue(name, name)
        }

        if (isReEvaluate) {
          pendingLoops.set(name, asyncFn)
          pendingDefaults.set(name, { bpm: defaultBpm, synth: defaultSynth })
        } else {
          scheduler.registerLoop(name, asyncFn)
          const task = scheduler.getTask(name)
          if (task) {
            task.bpm = defaultBpm
            task.currentSynth = defaultSynth
            task.outBus = 0
          }
        }
      }

      // Top-level with_fx: wraps live_loops inside it with FX context.
      // The callback receives a dummy builder — live_loops define their own.
      // FX is applied by wrapping each live_loop's builder function.
      // Stack of top-level FX — nested with_fx accumulates, innermost is last.
      // When a live_loop is registered, ALL stacked FX wrap its builder.
      const topFxStack: Array<{ name: string; opts: Record<string, number> }> = []
      /** Current FX scope ID — set when entering a with_fx block, used by live_loops inside. */
      let currentFxScopeId: string | null = null
      let fxScopeCounter = 0

      const topLevelWithFx = (
        fxName: string,
        optsOrFn: Record<string, number> | ((b: unknown) => void),
        maybeFn?: (b: unknown) => void
      ) => {
        let opts: Record<string, number>
        let fn: (b: unknown) => void
        if (typeof optsOrFn === 'function') {
          opts = {}
          fn = optsOrFn
        } else {
          opts = optsOrFn
          fn = maybeFn!
        }
        topFxStack.push({ name: fxName, opts })
        // Generate scope ID for the outermost with_fx (nested ones reuse it)
        const isOutermost = currentFxScopeId === null
        if (isOutermost) {
          currentFxScopeId = `__fxscope_${fxScopeCounter++}`
        }
        try {
          fn(null) // execute callback to register live_loops
        } finally {
          topFxStack.pop()
          if (isOutermost) {
            currentFxScopeId = null
          }
        }
      }

      // Patch wrappedLiveLoop to handle top-level FX.
      // Instead of wrapping the builder with b.with_fx() (which creates FX per iteration),
      // capture the FX chain and create persistent FX nodes on first iteration only.
      // Matches desktop Sonic Pi: top-level with_fx creates FX once, GC blocked by subthread.join.
      const originalWrappedLiveLoop = wrappedLiveLoop
      const fxAwareWrappedLiveLoop = (name: string, builderFnOrOpts: ((b: ProgramBuilder) => void) | Record<string, unknown>, maybeFn?: (b: ProgramBuilder) => void) => {
        let builderFn: (b: ProgramBuilder) => void
        let opts: Record<string, unknown> | null = null
        if (typeof builderFnOrOpts === 'function') {
          builderFn = builderFnOrOpts
        } else {
          opts = builderFnOrOpts
          builderFn = maybeFn!
        }
        if (topFxStack.length > 0 && currentFxScopeId) {
          // Generate scope ID from FX stack contents — loops with identical FX chains share one scope.
          // Different inner with_fx (e.g., reverb(0.5) vs reverb(0.8)) get separate scopes,
          // but loops inside the SAME with_fx block share FX nodes.
          const stackFingerprint = topFxStack.map(f =>
            `${f.name}:${JSON.stringify(f.opts)}`
          ).join('|')
          const scopeId = `${currentFxScopeId}:${stackFingerprint}`
          this.loopFxScope.set(name, scopeId)
          if (!this.fxScopeChains.has(scopeId)) {
            this.fxScopeChains.set(scopeId, [...topFxStack])
          }
          // Register with ORIGINAL builder (no FX wrapping)
          if (opts) {
            originalWrappedLiveLoop(name, opts, builderFn)
          } else {
            originalWrappedLiveLoop(name, builderFn)
          }
        } else {
          if (opts) {
            originalWrappedLiveLoop(name, opts, builderFn)
          } else {
            originalWrappedLiveLoop(name, builderFn)
          }
        }
      }

      // Top-level use_random_seed: store for deterministic live_loop seeding
      let storedRandomSeed: number | null = null
      const topLevelUseRandomSeed = (seed: number) => { storedRandomSeed = seed }

      // Top-level in_thread: wrap callback in a one-shot live_loop
      const topLevelInThread = (fn: (b: ProgramBuilder) => void) => {
        const name = `__thread_${Date.now()}_${randomSuffix()}`
        fxAwareWrappedLiveLoop(name, (b: ProgramBuilder) => {
          fn(b)
          b.stop()
        })
      }

      // Top-level at: create one-shot loops with time offsets
      const topLevelAt = (
        times: number[],
        values: unknown[] | null,
        fn: (b: ProgramBuilder, ...args: unknown[]) => void
      ) => {
        for (let i = 0; i < times.length; i++) {
          const t = times[i]
          const v = values ? values[i] : undefined
          const name = `__at_${Date.now()}_${i}_${randomSuffix()}`
          fxAwareWrappedLiveLoop(name, (b: ProgramBuilder) => {
            if (t > 0) b.sleep(t)
            if (v !== undefined) {
              fn(b, v)
            } else {
              fn(b)
            }
            b.stop()
          })
        }
      }

      // Top-level density: just call the callback (density only affects b.sleep)
      const topLevelDensity = (_factor: number, fn: (b: unknown) => void) => {
        // Check if fn is the callback (density N do ... end → density(N, (b) => { ... }))
        if (typeof _factor === 'function') {
          ;(_factor as unknown as (b: unknown) => void)(null)
        } else if (typeof fn === 'function') {
          fn(null)
        }
      }

      // ----- Global store (get/set) -----
      // get[:key] returns the stored value (or nil). get is a Proxy so get[:key] works.
      // set(:key, value) stores it. Shared across all loops.
      const set = (key: string | symbol, value: unknown): void => {
        this.globalStore.set(key, value)
      }
      const get = new Proxy({} as Record<string | symbol, unknown>, {
        get: (_target, key) => this.globalStore.get(key) ?? null,
      })

      // ----- MIDI input readers -----
      const get_cc = (controller: number, channel: number = 1): number =>
        this.midiBridge.getCCValue(controller, channel)
      const get_pitch_bend = (channel: number = 1): number =>
        this.midiBridge.getPitchBend(channel)

      // ----- Sample catalog -----
      const sample_names = (): string[] => getSampleNames()
      const sample_groups = (): string[] => getCategories()
      const sample_loaded = (name: string): boolean => {
        if (!this.bridge) return false
        return this.bridge.isSampleLoaded(name)
      }
      const sample_duration = (name: string): number => {
        if (!this.bridge) return 0
        return this.bridge.getSampleDuration(name) ?? 0
      }

      // ----- MIDI output (opts object carries keyword args from transpiler) -----
      type MidiOpts = { channel?: number }
      const midi_note_on = (note: number | string, velocity: number = 100, opts: MidiOpts = {}) => {
        const n = typeof note === 'string' ? noteToMidi(note) : note
        this.midiBridge.noteOn(n, velocity, opts.channel ?? 1)
      }
      const midi_note_off = (note: number | string, opts: MidiOpts = {}) => {
        const n = typeof note === 'string' ? noteToMidi(note) : note
        this.midiBridge.noteOff(n, opts.channel ?? 1)
      }
      const midi_cc = (controller: number, value: number, opts: MidiOpts = {}) =>
        this.midiBridge.cc(controller, value, opts.channel ?? 1)
      const midi_pitch_bend = (val: number, opts: MidiOpts = {}) =>
        this.midiBridge.pitchBend(val, opts.channel ?? 1)
      const midi_channel_pressure = (val: number, opts: MidiOpts = {}) =>
        this.midiBridge.channelPressure(val, opts.channel ?? 1)
      const midi_poly_pressure = (note: number, val: number, opts: MidiOpts = {}) =>
        this.midiBridge.polyPressure(note, val, opts.channel ?? 1)
      const midi_prog_change = (program: number, opts: MidiOpts = {}) =>
        this.midiBridge.programChange(program, opts.channel ?? 1)
      const midi_clock_tick = () => this.midiBridge.clockTick()
      const midi_start = () => this.midiBridge.midiStart()
      const midi_stop = () => this.midiBridge.midiStop()
      const midi_continue = () => this.midiBridge.midiContinue()
      const midi_all_notes_off = (opts: MidiOpts = {}) =>
        this.midiBridge.allNotesOff(opts.channel ?? 1)
      const midi_notes_off = (opts: MidiOpts = {}) =>
        this.midiBridge.allNotesOff(opts.channel ?? 1)
      const midi_devices = () => this.midiBridge.getDevices()
      const get_note_on = (channel: number = 1) => this.midiBridge.getLastNoteOn(channel)
      const get_note_off = (channel: number = 1) => this.midiBridge.getLastNoteOff(channel)

      // Top-level print alias (same as puts)
      const topLevelPrint = topLevelPuts

      // Top-level current_bpm — returns the current default BPM
      const current_bpm = (): number => defaultBpm

      // Pure math helpers (no engine state needed)
      const quantise = (val: number, step: number): number => Math.round(val / step) * step
      const quantize = quantise
      const octs = (n: number, numOctaves: number = 1): number[] =>
        Array.from({ length: numOctaves }, (_, i) => n + i * 12)

      // Build DSL parameter names and values for the executor
      const dslNames = [
        'live_loop', 'with_fx', 'use_bpm', 'use_synth', 'use_random_seed',
        'in_thread', 'at', 'density',
        'ring', 'knit', 'range', 'line', 'spread',
        'chord', 'scale', 'chord_invert', 'note', 'note_range',
        'chord_degree', 'degree', 'chord_names', 'scale_names',
        'noteToMidi', 'midiToFreq', 'noteToFreq',
        'hz_to_midi', 'midi_to_hz',
        'quantise', 'quantize', 'octs',
        'current_bpm',
        'puts', 'print', 'stop', 'stop_loop',
        // Global store
        'get', 'set',
        // Sample catalog
        'sample_names', 'sample_groups', 'sample_loaded', 'sample_duration',
        // MIDI input
        'get_cc', 'get_pitch_bend', 'get_note_on', 'get_note_off',
        // MIDI output
        'midi_note_on', 'midi_note_off', 'midi_cc',
        'midi_pitch_bend', 'midi_channel_pressure', 'midi_poly_pressure',
        'midi_prog_change', 'midi_clock_tick',
        'midi_start', 'midi_stop', 'midi_continue',
        'midi_all_notes_off', 'midi_notes_off', 'midi_devices',
      ]
      const dslValues = [
        fxAwareWrappedLiveLoop, topLevelWithFx, topLevelUseBpm, topLevelUseSynth, topLevelUseRandomSeed,
        topLevelInThread, topLevelAt, topLevelDensity,
        ring, knit, range, line, spread,
        chord, scale, chord_invert, note, note_range,
        chord_degree, degree, chord_names, scale_names,
        noteToMidi, midiToFreq, noteToFreq,
        hzToMidi, midiToFreq,
        quantise, quantize, octs,
        current_bpm,
        topLevelPuts, topLevelPrint, topLevelStop, stop_loop,
        // Global store
        get, set,
        // Sample catalog
        sample_names, sample_groups, sample_loaded, sample_duration,
        // MIDI input
        get_cc, get_pitch_bend, get_note_on, get_note_off,
        // MIDI output
        midi_note_on, midi_note_off, midi_cc,
        midi_pitch_bend, midi_channel_pressure, midi_poly_pressure,
        midi_prog_change, midi_clock_tick,
        midi_start, midi_stop, midi_continue,
        midi_all_notes_off, midi_notes_off, midi_devices,
      ]

      const codeWarnings = validateCode(transpiledCode)
      for (const warning of codeWarnings) {
        if (this.printHandler) this.printHandler(`[Warning] ${warning}`)
        else console.warn('[SonicPi]', warning)
      }

      const sandbox = createIsolatedExecutor(transpiledCode, dslNames)
      scopeHandle = sandbox.scopeHandle
      await sandbox.execute(...dslValues)

      if (isReEvaluate) {
        const oldLoops = scheduler.getRunningLoopNames()
        const removedLoops = oldLoops.filter(name => !pendingLoops.has(name))
        const hasNewLoops = [...pendingLoops.keys()].some(name => !oldLoops.includes(name))

        // Pause ticking so no old events fire during transition
        scheduler.pauseTick()

        // Free old audio — clean cut on every re-evaluate
        if (this.bridge) {
          this.bridge.freeAllNodes()
          this.nodeRefMap.clear()
          // Clear persistent FX — freeAllNodes killed the FX nodes in group 101.
          // They will be recreated on the next iteration of each loop.
          // loopFxScope/fxScopeChains are repopulated by the DSL re-execution above.
          this.persistentFx.clear()
          this.reusableFx.clear()
          this.loopFxScope.clear()
          this.fxScopeChains.clear()
        }

        // Commit: hot-swap same-named, stop removed, start new
        scheduler.reEvaluate(pendingLoops, { bpm: defaultBpm, synth: defaultSynth })

        // Apply per-loop defaults (synths write to bus 0 for mixer processing)
        for (const [name, defaults] of pendingDefaults) {
          const task = scheduler.getTask(name)
          if (task) {
            task.bpm = defaults.bpm
            task.currentSynth = defaults.synth
            task.outBus = 0
          }
        }

        // Resume ticking — new loops start clean
        scheduler.resumeTick()
      }

      return {}
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      return { error }
    }
  }

  /** Start the scheduler. Call after the first `evaluate()`. */
  play(): void {
    if (!this.scheduler) return
    if (this.playing) return

    this.playing = true
    this.scheduler.start()
  }

  /** Stop all loops and free audio resources. The next `evaluate()` starts fresh. */
  stop(): void {
    if (!this.playing) return

    this.playing = false
    this.scheduler?.stop()

    // Free all scsynth nodes for clean silence
    if (this.bridge) {
      this.bridge.freeAllNodes()
    }
    this.nodeRefMap.clear()

    // Dispose scheduler so next evaluate() starts fresh
    this.scheduler?.dispose()
    this.scheduler = null
    this.loopBuilders.clear()
    this.loopSeeds.clear()
    this.loopTicks.clear()
    this.loopSynced.clear()
    this.globalStore.clear()
    this.persistentFx.clear()
    this.reusableFx.clear()
    this.loopFxScope.clear()
    this.fxScopeChains.clear()
  }

  dispose(): void {
    if (this.playing) this.stop()
    this.scheduler?.dispose()
    this.scheduler = null
    this.eventStream.dispose()
    this.bridge?.dispose()
    this.bridge = null
    this.initialized = false
    this.currentStratum = Stratum.S3  // Reset to S3 so capture is unavailable
    this.loopBuilders.clear()
    this.loopSeeds.clear()
    this.globalStore.clear()
  }

  /** Register a handler for runtime errors inside `live_loop` bodies. */
  setRuntimeErrorHandler(handler: (err: Error) => void): void {
    this.runtimeErrorHandler = handler
  }

  /** Register a handler for `puts` / `print` output from user code. */
  setPrintHandler(handler: (msg: string) => void): void {
    this.printHandler = handler
  }

  /**
   * Set master volume. Range: 0 (silent) to 1 (full).
   * Safe to call before `init()` — applied when the audio bridge is ready.
   */
  setVolume(volume: number): void {
    this.pendingVolume = volume
    this.bridge?.setMasterVolume(volume)
  }

  /** Get a friendly version of the last error (for display in a log pane). */
  static formatError(err: Error): FriendlyError {
    return friendlyError(err)
  }

  /** Format a friendly error as a display string. */
  static formatErrorString(err: Error): string {
    return formatFriendlyError(friendlyError(err))
  }

  /** Get SuperSonic scsynth metrics for diagnostics. */
  getMetrics(): Record<string, unknown> | null {
    return this.bridge?.getMetrics() ?? null
  }

  get components(): Partial<EngineComponents> {
    const result: Partial<EngineComponents> = {
      streaming: { eventStream: this.eventStream },
    }

    // Audio (from SuperSonic) — master + per-track analysers
    const audioCtx = this.bridge?.audioContext
    const analyser = this.bridge?.analyser
    if (audioCtx && analyser) {
      const trackAnalysers = this.bridge?.getAllTrackAnalysers()
      result.audio = { analyser, audioCtx, trackAnalysers }
    }

    // Capture query (only for deterministic S1/S2 code)
    if (this.currentStratum <= Stratum.S2) {
      const loopBuilders = this.loopBuilders
      const scheduler = this.scheduler

      result.capture = {
        async queryRange(begin: number, end: number): Promise<QueryEvent[]> {
          const events: QueryEvent[] = []
          for (const [name, builderFn] of loopBuilders) {
            const task = scheduler?.getTask(name)
            const bpm = task?.bpm ?? 60
            const factory = (ticks?: Map<string, number>, iteration?: number) => {
              const builder = new ProgramBuilder(iteration ?? 0, ticks)
              builderFn(builder)
              return { program: builder.build(), ticks: builder.getTicks() }
            }
            events.push(...queryLoopProgram(factory, begin, end, bpm))
          }
          return events.sort((a, b) => a.time - b.time)
        },
      }
    }

    return result
  }
}
