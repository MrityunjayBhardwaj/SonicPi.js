import { VirtualTimeScheduler, type SchedulerEvent } from './VirtualTimeScheduler'
import { createDSLContext } from './DSLContext'
import { SuperSonicBridge, type SuperSonicBridgeOptions } from './SuperSonicBridge'
import { transpile, createExecutor } from './Transpiler'
import { autoTranspile } from './RubyTranspiler'
import { friendlyError, formatFriendlyError, type FriendlyError } from './FriendlyErrors'
import { CaptureScheduler, detectStratum, Stratum } from './CaptureScheduler'
import { SoundEventStream } from './SoundEventStream'
import { noteToMidi, midiToFreq } from './NoteToFreq'

/** Sentinel thrown by the `stop` DSL command to halt the current thread. */
class StopSignal extends Error {
  constructor() { super('stop'); this.name = 'StopSignal' }
}

// ---------------------------------------------------------------------------
// Engine interfaces
// ---------------------------------------------------------------------------

export interface EngineComponents {
  /** Sound event stream for visualization and logging. */
  streaming: { eventStream: SoundEventStream }
  /** Audio context and analyser node for scope/recording. */
  audio: { analyser: AnalyserNode; audioCtx: AudioContext }
  /** Capture query for deterministic (S1/S2) code introspection. */
  capture: { queryRange(begin: number, end: number): Promise<unknown[]> }
}

// ---------------------------------------------------------------------------
// SonicPiEngine
// ---------------------------------------------------------------------------

export class SonicPiEngine {
  private scheduler: VirtualTimeScheduler | null = null
  private bridge: SuperSonicBridge | null = null
  private dsl: ReturnType<typeof createDSLContext> | null = null
  private eventStream = new SoundEventStream()
  private initialized = false
  private playing = false
  private runtimeErrorHandler: ((err: Error) => void) | null = null
  private printHandler: ((msg: string) => void) | null = null
  private currentCode = ''
  private currentStratum: Stratum = Stratum.S1
  private captureScheduler = new CaptureScheduler()
  private bridgeOptions: SuperSonicBridgeOptions
  private schedAheadTime: number
  /** Maps DSL nodeRef → SuperSonic nodeId for control messages */
  private nodeRefMap = new Map<number, number>()

  constructor(options?: {
    bridge?: SuperSonicBridgeOptions
    schedAheadTime?: number
  }) {
    this.bridgeOptions = options?.bridge ?? {}
    this.schedAheadTime = options?.schedAheadTime ?? 0.1
  }

  async init(): Promise<void> {
    if (this.initialized) return

    this.bridge = new SuperSonicBridge(this.bridgeOptions)

    try {
      await this.bridge.init()
    } catch (err) {
      // SuperSonic not available (e.g., tests without browser)
      // Engine still works for transpile/evaluate, just no audio
      console.warn('[SonicPi] SuperSonic init failed, running without audio:', err)
      this.bridge = null
    }

    this.initialized = true
  }

  async evaluate(code: string): Promise<{ error?: Error }> {
    if (!this.initialized) {
      return { error: new Error('SonicPiEngine not initialized — call init() first') }
    }

    try {
      this.currentCode = code
      this.currentStratum = detectStratum(code)

      const isReEvaluate = this.scheduler !== null && this.playing

      // First run or after stop: create fresh scheduler + DSL
      if (!isReEvaluate) {
        if (this.scheduler) {
          this.scheduler.dispose()
        }

        const audioCtx = this.bridge?.audioContext
        this.scheduler = new VirtualTimeScheduler({
          getAudioTime: () => audioCtx?.currentTime ?? 0,
          schedAheadTime: this.schedAheadTime,
        })
        this.scheduler.onEvent((event) => this.handleEvent(event))

        this.dsl = createDSLContext({
          scheduler: this.scheduler,
          fxBridge: this.bridge,
        })
      }

      // Transpile: Ruby DSL → JS → add missing awaits
      const jsCode = autoTranspile(code)
      const { code: transpiledCode } = transpile(jsCode)

      // Top-level DSL functions
      let defaultBpm = 60
      let defaultSynth = 'beep'
      const scheduler = this.scheduler!
      const dsl = this.dsl!

      const topLevelUseBpm = (bpm: number) => { defaultBpm = bpm }
      const topLevelUseSynth = (name: string) => { defaultSynth = name }

      // Collection map for re-evaluate hot-swap path
      const pendingLoops = new Map<string, () => Promise<void>>()
      const pendingDefaults = new Map<string, { bpm: number; synth: string }>()

      const wrappedLiveLoop = (name: string, asyncFn: (ctx: unknown) => Promise<void>) => {
        if (isReEvaluate) {
          // Collect: build the wrapped function but don't register yet
          const wrappedFn = dsl._buildLoopFn(name, asyncFn as (ctx: unknown) => Promise<void>)
          pendingLoops.set(name, wrappedFn)
          pendingDefaults.set(name, { bpm: defaultBpm, synth: defaultSynth })
        } else {
          // Direct: first run, register immediately
          dsl.live_loop(name, asyncFn as (ctx: unknown) => Promise<void>)
          const task = scheduler.getTask(name)
          if (task) {
            task.bpm = defaultBpm
            task.currentSynth = defaultSynth
          }
        }
      }

      // Print handler — routes puts/print to the app console
      const __print = (...args: unknown[]) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        if (this.printHandler) this.printHandler(msg)
        else console.log('[SonicPi]', msg)
      }

      // Stop sentinel — thrown by stop command, caught by runLoop
      const __stop = () => { throw new StopSignal() }

      // Build DSL parameter names and values for the executor
      const dslNames = [
        'live_loop', 'use_bpm', 'use_synth',
        'ring', 'knit', 'range', 'line', 'spread', 'chord', 'scale', 'chord_invert', 'note', 'note_range',
        'noteToMidi', 'midiToFreq', 'noteToFreq',
        'console', 'stop',
      ]
      const topDSL = dsl._makeTaskDSL('__top__')
      const dslValues = [
        wrappedLiveLoop, topLevelUseBpm, topLevelUseSynth,
        dsl.ring, topDSL.knit,
        topDSL.range, topDSL.line,
        dsl.spread,
        topDSL.chord, topDSL.scale, topDSL.chord_invert,
        topDSL.note, topDSL.note_range,
        dsl.noteToMidi, dsl.midiToFreq, dsl.noteToFreq,
        { log: __print }, __stop,
      ]

      const executor = createExecutor(transpiledCode, dslNames)
      await executor(...dslValues)

      if (isReEvaluate) {
        const oldLoops = scheduler.getRunningLoopNames()
        const removedLoops = oldLoops.filter(name => !pendingLoops.has(name))
        const hasNewLoops = [...pendingLoops.keys()].some(name => !oldLoops.includes(name))
        const loopsChanged = removedLoops.length > 0 || hasNewLoops

        // Pause ticking so no old events fire during transition
        scheduler.pauseTick()

        // Free old audio — clean cut on every re-evaluate.
        // Even hot-swapped loops need this: the old body may have triggered
        // synths that are still sustaining, and the new body may not trigger
        // any (e.g., all play/sample calls commented out).
        if (this.bridge) {
          this.bridge.freeAllNodes()
          this.nodeRefMap.clear()
        }

        // Commit: hot-swap same-named, stop removed, start new
        scheduler.reEvaluate(pendingLoops, { bpm: defaultBpm, synth: defaultSynth })

        // Apply per-loop defaults
        for (const [name, defaults] of pendingDefaults) {
          const task = scheduler.getTask(name)
          if (task) {
            task.bpm = defaults.bpm
            task.currentSynth = defaults.synth
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

  play(): void {
    if (!this.scheduler) return
    if (this.playing) return

    this.playing = true
    this.scheduler.start()
  }

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
    this.dsl = null
  }

  dispose(): void {
    if (this.playing) this.stop()
    this.scheduler?.dispose()
    this.scheduler = null
    this.dsl = null
    this.eventStream.dispose()
    this.bridge?.dispose()
    this.bridge = null
    this.initialized = false
  }

  setRuntimeErrorHandler(handler: (err: Error) => void): void {
    this.runtimeErrorHandler = handler
  }

  /** Set handler for puts/print output from user code. */
  setPrintHandler(handler: (msg: string) => void): void {
    this.printHandler = handler
  }

  /** Get a friendly version of the last error (for display in a log pane). */
  static formatError(err: Error): FriendlyError {
    return friendlyError(err)
  }

  /** Format a friendly error as a display string. */
  static formatErrorString(err: Error): string {
    return formatFriendlyError(friendlyError(err))
  }

  get components(): Partial<EngineComponents> {
    const result: Partial<EngineComponents> = {
      streaming: { eventStream: this.eventStream },
    }

    // Audio (from SuperSonic)
    const audioCtx = this.bridge?.audioContext
    const analyser = this.bridge?.analyser
    if (audioCtx && analyser) {
      result.audio = { analyser, audioCtx }
    }

    // Capture query (only for deterministic S1/S2 code)
    if (this.currentStratum <= Stratum.S2 && this.scheduler) {
      const captureScheduler = this.captureScheduler
      const currentCode = this.currentCode

      result.capture = {
        async queryRange(begin: number, end: number): Promise<unknown[]> {
          const events = await captureScheduler.runUntilCapture((dsl) => {
            const { code: tc } = transpile(currentCode)
            const names = ['live_loop', 'ring', 'spread', 'noteToMidi', 'midiToFreq', 'noteToFreq']
            const vals = [dsl.live_loop, dsl.ring, dsl.spread, dsl.noteToMidi, dsl.midiToFreq, dsl.noteToFreq]
            const fn = createExecutor(tc, names)
            fn(...vals)
          }, end)

          return events.filter(e => e.time >= begin && e.time < end)
        },
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleEvent(event: SchedulerEvent): void {
    try {
      const audioTime = event.virtualTime + this.schedAheadTime

      // Trigger audio via SuperSonic
      if (this.bridge) {
        if (event.type === 'synth') {
          const params: Record<string, number> = {}
          for (const [k, v] of Object.entries(event.params)) {
            if (typeof v === 'number') params[k] = v
          }
          const nodeRef = event.params._nodeRef as number | undefined
          this.bridge.triggerSynth(
            event.params.synth as string ?? 'beep',
            audioTime,
            params
          ).then(realNodeId => {
            if (nodeRef) this.nodeRefMap.set(nodeRef, realNodeId)
          }).catch(err => {
            this.runtimeErrorHandler?.(
              err instanceof Error ? err : new Error(String(err))
            )
          })
        } else if (event.type === 'sample') {
          const sampleOpts: Record<string, number> = {}
          for (const [k, v] of Object.entries(event.params)) {
            if (k !== 'name' && typeof v === 'number') sampleOpts[k] = v
          }
          const taskBpm = this.scheduler?.getTask(event.taskId)?.bpm ?? 60
          this.bridge.playSample(
            event.params.name as string,
            audioTime,
            Object.keys(sampleOpts).length > 0 ? sampleOpts : undefined,
            taskBpm
          ).catch(err => {
            // Sample load failure — report but don't crash the scheduler
            this.runtimeErrorHandler?.(
              err instanceof Error ? err : new Error(String(err))
            )
          })
        } else if (event.type === 'control') {
          const nodeRef = event.params._nodeRef as number | undefined
          if (nodeRef) {
            const realNodeId = this.nodeRefMap.get(nodeRef)
            if (realNodeId) {
              const controlParams: Record<string, number> = {}
              for (const [k, v] of Object.entries(event.params)) {
                if (k !== '_nodeRef' && typeof v === 'number') controlParams[k] = v
              }
              // Convert note names to MIDI if present
              if (controlParams['note']) {
                controlParams['freq'] = midiToFreq(controlParams['note'])
              }
              const paramList: (string | number)[] = []
              for (const [k, v] of Object.entries(controlParams)) {
                paramList.push(k, v)
              }
              this.bridge.send?.('/n_set', realNodeId, ...paramList)
            }
          }
        }
      }

      // Emit sound event for visualization and logging
      const audioCtxTime = this.bridge?.audioContext?.currentTime ?? 0
      this.eventStream.emitEvent({
        audioTime,
        audioDuration: 0.25,
        scheduledAheadMs: (audioTime - audioCtxTime) * 1000,
        midiNote: (event.params.note as number) ?? null,
        s: (event.params.synth as string) ?? (event.params.name as string) ?? null,
        srcLine: (event.params._srcLine as number) ?? null,
        trackId: event.taskId,
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.runtimeErrorHandler?.(error)
    }
  }

}
