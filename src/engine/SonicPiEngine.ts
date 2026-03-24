import { VirtualTimeScheduler, type SchedulerEvent } from './VirtualTimeScheduler'
import { createDSLContext } from './DSLContext'
import { SuperSonicBridge, type SuperSonicBridgeOptions } from './SuperSonicBridge'
import { transpile, createExecutor } from './Transpiler'
import { autoTranspile } from './RubyTranspiler'
import { CaptureScheduler, detectStratum, Stratum } from './CaptureScheduler'
import { HapStream } from './HapStream'
import { noteToMidi, midiToFreq } from './NoteToFreq'

// ---------------------------------------------------------------------------
// Types matching Motif's LiveCodingEngine interface
// ---------------------------------------------------------------------------

export interface StreamingComponent {
  hapStream: HapStream
}

export interface QueryableComponent {
  scheduler: PatternScheduler | null
  trackSchedulers: Map<string, PatternScheduler>
}

export interface AudioComponent {
  analyser: AnalyserNode
  audioCtx: AudioContext
}

export interface InlineVizComponent {
  vizRequests: Map<string, { vizId: string; afterLine: number }>
}

export interface EngineComponents {
  streaming: StreamingComponent
  queryable: QueryableComponent
  audio: AudioComponent
  inlineViz: InlineVizComponent
}

export interface PatternScheduler {
  queryArc(begin: number, end: number): Promise<unknown[]>
}

export interface LiveCodingEngine {
  init(): Promise<void>
  evaluate(code: string): Promise<{ error?: Error }>
  play(): void
  stop(): void
  dispose(): void
  readonly components: Partial<EngineComponents>
  setRuntimeErrorHandler(handler: (err: Error) => void): void
}

// ---------------------------------------------------------------------------
// SonicPiEngine
// ---------------------------------------------------------------------------

export class SonicPiEngine implements LiveCodingEngine {
  private scheduler: VirtualTimeScheduler | null = null
  private bridge: SuperSonicBridge | null = null
  private dsl: ReturnType<typeof createDSLContext> | null = null
  private hapStream = new HapStream()
  private initialized = false
  private playing = false
  private runtimeErrorHandler: ((err: Error) => void) | null = null
  private currentCode = ''
  private currentStratum: Stratum = Stratum.S1
  private currentVizRequests = new Map<string, { vizId: string; afterLine: number }>()
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
      this.parseVizRequests(code)

      // Create fresh scheduler
      const wasPlaying = this.playing
      if (this.playing) this.stop()

      const audioCtx = this.bridge?.audioContext
      this.scheduler = new VirtualTimeScheduler({
        getAudioTime: () => audioCtx?.currentTime ?? 0,
        schedAheadTime: this.schedAheadTime,
      })

      // Wire event handler for audio and viz
      this.scheduler.onEvent((event) => this.handleEvent(event))

      // Create DSL context
      this.dsl = createDSLContext({ scheduler: this.scheduler })

      // Transpile: Ruby DSL → JS → add missing awaits
      const jsCode = autoTranspile(code)
      const { code: transpiledCode } = transpile(jsCode)

      // Top-level DSL functions (outside live_loop)
      let defaultBpm = 60
      let defaultSynth = 'beep'
      const scheduler = this.scheduler

      const topLevelUseBpm = (bpm: number) => { defaultBpm = bpm }
      const topLevelUseSynth = (name: string) => { defaultSynth = name }

      // Wrap live_loop to pass default bpm/synth
      const wrappedLiveLoop = (name: string, asyncFn: (ctx: unknown) => Promise<void>) => {
        this.dsl!.live_loop(name, asyncFn)
        // Apply defaults to the newly created task
        const task = scheduler.getTask(name)
        if (task) {
          task.bpm = defaultBpm
          task.currentSynth = defaultSynth
        }
      }

      // Build DSL parameter names and values for the executor
      const dslNames = [
        'live_loop', 'use_bpm', 'use_synth',
        'ring', 'knit', 'range', 'line', 'spread', 'chord', 'scale', 'chord_invert', 'note', 'note_range',
        'noteToMidi', 'midiToFreq', 'noteToFreq',
      ]
      const dslValues = [
        wrappedLiveLoop, topLevelUseBpm, topLevelUseSynth,
        this.dsl.ring, this.dsl._makeTaskDSL('__top__').knit,
        this.dsl._makeTaskDSL('__top__').range, this.dsl._makeTaskDSL('__top__').line,
        this.dsl.spread,
        this.dsl._makeTaskDSL('__top__').chord,
        this.dsl._makeTaskDSL('__top__').scale,
        this.dsl._makeTaskDSL('__top__').chord_invert,
        this.dsl._makeTaskDSL('__top__').note,
        this.dsl._makeTaskDSL('__top__').note_range,
        this.dsl.noteToMidi, this.dsl.midiToFreq, this.dsl.noteToFreq,
      ]

      const executor = createExecutor(transpiledCode, dslNames)
      await executor(...dslValues)

      // Auto-resume if was playing
      if (wasPlaying) this.play()

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
  }

  dispose(): void {
    if (this.playing) this.stop()
    this.scheduler?.dispose()
    this.scheduler = null
    this.dsl = null
    this.hapStream.dispose()
    this.bridge?.dispose()
    this.bridge = null
    this.initialized = false
    this.currentVizRequests.clear()
  }

  setRuntimeErrorHandler(handler: (err: Error) => void): void {
    this.runtimeErrorHandler = handler
  }

  get components(): Partial<EngineComponents> {
    const bag: Partial<EngineComponents> = {
      streaming: { hapStream: this.hapStream },
    }

    // Audio components (from SuperSonic)
    const audioCtx = this.bridge?.audioContext
    const analyser = this.bridge?.analyser
    if (audioCtx && analyser) {
      bag.audio = { analyser, audioCtx }
    }

    // Queryable components (only for Stratum 1-2)
    if (this.currentStratum <= Stratum.S2 && this.scheduler) {
      const captureScheduler = this.captureScheduler
      const currentCode = this.currentCode

      bag.queryable = {
        scheduler: {
          async queryArc(begin: number, end: number): Promise<unknown[]> {
            // Re-parse and run in capture mode
            const events = await captureScheduler.runUntilCapture((dsl) => {
              const { code: tc } = transpile(currentCode)
              const names = ['live_loop', 'ring', 'spread', 'noteToMidi', 'midiToFreq', 'noteToFreq']
              const vals = [dsl.live_loop, dsl.ring, dsl.spread, dsl.noteToMidi, dsl.midiToFreq, dsl.noteToFreq]
              const fn = createExecutor(tc, names)
              fn(...vals)
            }, end)

            return events.filter(e => e.time >= begin && e.time < end)
          },
        },
        trackSchedulers: new Map(),
      }
    }

    // Inline viz requests
    if (this.currentVizRequests.size > 0) {
      bag.inlineViz = { vizRequests: this.currentVizRequests }
    }

    return bag
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

      // Emit to HapStream for visualization
      const note = event.params.note as number | undefined
      const hap = {
        value: {
          note: note ?? null,
          s: event.params.synth ?? event.params.name ?? 'unknown',
        },
        whole: {
          begin: event.virtualTime,
          end: event.virtualTime + 0.25,
        },
        part: {
          begin: event.virtualTime,
          end: event.virtualTime + 0.25,
        },
        context: { locations: [] },
      }

      const audioCtxTime = this.bridge?.audioContext?.currentTime ?? 0
      this.hapStream.emit(hap, audioTime, 2, audioTime + 0.25, audioCtxTime)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.runtimeErrorHandler?.(error)
    }
  }

  private parseVizRequests(code: string): void {
    this.currentVizRequests.clear()
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const vizMatch = lines[i].match(/\/\/\s*@viz\s+(\w+)/)
      if (vizMatch) {
        // Find the preceding live_loop to get the track name
        let trackName = `track_${i}`
        for (let j = i - 1; j >= 0; j--) {
          const loopMatch = lines[j].match(/live_loop\s*\(\s*["'](\w+)["']/)
          if (loopMatch) {
            trackName = loopMatch[1]
            break
          }
        }

        this.currentVizRequests.set(trackName, {
          vizId: vizMatch[1],
          afterLine: i + 1,
        })
      }
    }
  }
}
