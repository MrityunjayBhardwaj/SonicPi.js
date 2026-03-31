/**
 * Wrapper around SuperSonic (scsynth WASM).
 *
 * SuperSonic is loaded via CDN (GPL core), never bundled.
 * This bridge handles init, synth triggering, sample playback,
 * FX, AnalyserNode tap, and cleanup.
 */

import { audioTimeToNTP, encodeSingleBundle as fallbackEncodeSingleBundle, encodeBundle as fallbackEncodeBundle } from './osc'
import { normalizeSampleParams, selectSamplePlayer, translateSampleOpts } from './SoundLayer'

// SuperSonic types — declared here since we load it at runtime via CDN
interface SuperSonic {
  init(): Promise<void>
  send(address: string, ...args: (string | number)[]): void
  sendOSC(data: Uint8Array, options?: Record<string, unknown>): void
  loadSynthDef(name: string): Promise<void>
  loadSynthDefs(names: string[]): Promise<void>
  loadSample(bufNum: number, path: string): Promise<void>
  sync(): Promise<void>
  nextNodeId(): number
  suspend(): void
  resume(): void
  recover(): void
  destroy(): void
  node: AudioWorkletNode
  audioContext: AudioContext
}

interface SuperSonicOSC {
  encodeSingleBundle(timetag: number, address: string, args: (string | number)[]): Uint8Array
  encodeBundle(timetag: number, messages: unknown[]): Uint8Array
  encodeMessage(address: string, args: (string | number)[]): Uint8Array
}

interface SuperSonicConstructor {
  new (options: {
    baseURL: string
    coreBaseURL?: string
    synthdefBaseURL: string
    sampleBaseURL?: string
  }): SuperSonic
  osc?: SuperSonicOSC
}

export interface SuperSonicBridgeOptions {
  /** Pass the SuperSonic constructor (from ES module import) */
  SuperSonicClass?: SuperSonicConstructor
  baseURL?: string
  coreBaseURL?: string
  synthdefBaseURL?: string
  sampleBaseURL?: string
}

/**
 * Format an OSC message as a human-readable trace string.
 * Matches desktop Sonic Pi's trace style:
 *   /s_new "sonic-pi-basic_stereo_player" 1003 0 100 {buf: 0, amp: 1.5, lpf: 130}
 */
function formatOscTrace(address: string, args: (string | number)[], audioTime: number): string {
  if (address === '/s_new' && args.length >= 4) {
    const synthName = args[0]
    const nodeId = args[1]
    const addAction = args[2]
    const targetGroup = args[3]
    // Remaining args are key-value pairs
    const params: Record<string, string | number> = {}
    for (let i = 4; i < args.length; i += 2) {
      const key = args[i]
      const val = args[i + 1]
      if (key !== undefined && val !== undefined) {
        params[String(key)] = val
      }
    }
    const paramsStr = Object.entries(params)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(', ')
    return `[t:${audioTime.toFixed(4)}] ${address} "${synthName}" ${nodeId} ${addAction} ${targetGroup} {${paramsStr}}`
  }
  if (address === '/n_set' && args.length >= 1) {
    const nodeId = args[0]
    const params: Record<string, string | number> = {}
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]
      const val = args[i + 1]
      if (key !== undefined && val !== undefined) {
        params[String(key)] = val
      }
    }
    const paramsStr = Object.entries(params)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? Number(v.toFixed(4)) : v}`)
      .join(', ')
    return `[t:${audioTime.toFixed(4)}] ${address} ${nodeId} {${paramsStr}}`
  }
  return `[t:${audioTime.toFixed(4)}] ${address} ${args.join(' ')}`
}

const COMMON_SYNTHDEFS = [
  'sonic-pi-beep',
  'sonic-pi-saw',
  'sonic-pi-prophet',
  'sonic-pi-tb303',
  'sonic-pi-supersaw',
  'sonic-pi-pluck',
  'sonic-pi-pretty_bell',
  'sonic-pi-piano',
  'sonic-pi-basic_stereo_player',
]



/** Max stereo track outputs (beyond master). Channels 0-1 = master, 2-3 = track 0, etc. */
const MAX_TRACK_OUTPUTS = 6
const NUM_OUTPUT_CHANNELS = 2 + MAX_TRACK_OUTPUTS * 2 // 14 channels total

// ---------------------------------------------------------------------------
// Mixer gain staging — matching desktop Sonic Pi's output level
// ---------------------------------------------------------------------------

/**
 * Desktop Sonic Pi's mixer: pre_amp × amp = 0.2 × 6 = 1.2 effective gain.
 *
 * SuperSonic's scsynth WASM produces raw synth output at ~2.3x the level
 * of desktop scsynth (same synthdefs, same samples, same params). The cause
 * is that WASM outputs float32 directly to the AudioWorklet with no
 * driver-level normalization, while desktop scsynth goes through CoreAudio/
 * ALSA/JACK which may attenuate. Emscripten's own docs warn about this:
 * "scale down audio volume by factor of 0.2, raw noise can be really loud."
 *
 * Full investigation: artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md
 * A/B data: tools/audio_comparison/latest_test/
 *
 * To compensate, we reduce pre_amp so the effective gain matches desktop:
 *   Desktop effective = 0.2 × 6 = 1.2
 *   Our raw signal is WASM_OUTPUT_LEVEL_FACTOR hotter
 *   → compensated pre_amp = SONIC_PI_DEFAULT_PRE_AMP / WASM_OUTPUT_LEVEL_FACTOR
 *   → effective gain = compensated_pre_amp × SONIC_PI_MIXER_AMP ≈ desktop effective
 */

/**
 * Measured ratio: SuperSonic WASM raw output RMS / desktop scsynth raw output RMS.
 *
 * WHY THIS EXISTS:
 * Desktop scsynth outputs through native audio drivers (CoreAudio/ALSA/JACK)
 * which include driver-level output processing before reaching hardware.
 * SuperSonic's WASM build bypasses all native drivers — scsynth writes float32
 * samples directly to WASM memory, the AudioWorklet copies them verbatim to
 * Web Audio output (verified: zero scaling in scsynth_audio_worklet.js).
 *
 * The result: identical synths, samples, and params produce ~2.3x louder
 * raw output in WASM vs desktop. This was measured with proper A/B recordings
 * (Rec button on both platforms) using the same DJ Dave kick+clap code at
 * 130 BPM. Desktop RMS: 0.19, WASM RMS: 0.42, ratio: 2.21x.
 *
 * Without compensation: mixer's Limiter.ar(0.99) triggers on every beat,
 * amp×6 overshoots clip2(1), output clips at 3.4% — squashing dynamics
 * and introducing harmonic distortion.
 *
 * With compensation: RMS matches desktop within ±11%, clipping drops to 0.25%.
 *
 * EVIDENCE: artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md
 * A/B WAVs: tools/audio_comparison/latest_test/
 */
const WASM_OUTPUT_LEVEL_FACTOR = 2.3

/** Desktop Sonic Pi: set_volume!(1) → pre_amp = vol * 0.2 */
const SONIC_PI_DEFAULT_PRE_AMP = 0.2

/** Desktop Sonic Pi: amp=6 set at mixer trigger time. */
const SONIC_PI_MIXER_AMP = 6

/**
 * Compensated pre_amp that produces desktop-equivalent output from WASM scsynth.
 * = SONIC_PI_DEFAULT_PRE_AMP / WASM_OUTPUT_LEVEL_FACTOR = 0.2 / 2.3 ≈ 0.087
 *
 * Effective gain: 0.087 × 6 = 0.52. With 2.3x hotter raw signal: 0.52 × 2.3 ≈ 1.2
 * — matching desktop's pre_amp(0.2) × amp(6) = 1.2 effective gain.
 */
const WASM_COMPENSATED_PRE_AMP = SONIC_PI_DEFAULT_PRE_AMP / WASM_OUTPUT_LEVEL_FACTOR

export class SuperSonicBridge {
  private sonic: SuperSonic | null = null
  private loadedSynthDefs = new Set<string>()
  private loadedSamples = new Map<string, number>()
  /** Sample duration cache — populated asynchronously on first load via Web Audio decode. */
  private sampleDurations = new Map<string, number>()
  private resolvedSampleBaseURL = 'https://unpkg.com/supersonic-scsynth-samples@latest/samples/'
  private nextBufNum = 0
  private analyserNode: AnalyserNode | null = null
  private options: SuperSonicBridgeOptions
  /** Audio bus allocator — buses 0-15 are hardware, 16+ are private */
  private nextBusNum = NUM_OUTPUT_CHANNELS
  private freeBuses: number[] = []
  /** Live audio (mic/line-in) streams keyed by name */
  private liveAudioStreams = new Map<string, { stream: MediaStream, source: MediaStreamAudioSourceNode }>()
  /** Per-track AnalyserNodes keyed by track name */
  private trackAnalysers = new Map<string, AnalyserNode>()
  /** Track name → scsynth bus pair (stereo, starting at bus 2) */
  private trackBuses = new Map<string, number>()
  /** Next available track bus pair */
  private nextTrackBus = 2
  private splitter: ChannelSplitterNode | null = null
  private masterMerger: ChannelMergerNode | null = null
  private masterGainNode: GainNode | null = null
  /** scsynth mixer node ID — for controlling master volume via /n_set */
  private mixerNodeId = 0
  /** Optional callback for OSC trace logging — receives formatted trace strings like desktop Sonic Pi. */
  private oscTraceHandler: ((msg: string) => void) | null = null
  /** SuperSonic.osc encoder (preferred) or fallback */
  private oscEncoder: {
    encodeSingleBundle(timetag: number, address: string, args: (string | number)[]): Uint8Array
  } | null = null
  /** SuperSonic constructor ref — needed for static osc access */
  private SuperSonicClass: SuperSonicConstructor | null = null
  /**
   * Delayed message queue — matches Sonic Pi's __delayed_messages.
   * Messages are queued during computation and flushed as a single
   * OSC bundle on sleep, so all events between sleeps share one NTP timetag.
   */
  private messageQueue: Array<{ address: string; args: (string | number)[] }> = []
  private messageQueueAudioTime: number = 0

  constructor(options: SuperSonicBridgeOptions = {}) {
    this.options = options
  }

  async init(): Promise<void> {
    // Try constructor passed via options, then global scope
    const SuperSonicClass = this.options.SuperSonicClass
      ?? (globalThis as Record<string, unknown>).SuperSonic as SuperSonicConstructor | undefined
    if (!SuperSonicClass) {
      throw new Error(
        'SuperSonic not found. Pass it via options.SuperSonicClass or load via CDN.'
      )
    }
    this.SuperSonicClass = SuperSonicClass
    // Prefer SuperSonic's built-in OSC encoder; fall back to our minimal implementation
    this.oscEncoder = SuperSonicClass.osc ?? { encodeSingleBundle: fallbackEncodeSingleBundle }

    // SuperSonic constructor options — URLs for workers, WASM, synthdefs, samples.
    // Workers and JS live in the main package; WASM in the core package.
    const pkgBase = 'https://unpkg.com/supersonic-scsynth@latest/dist/'
    const coreBase = 'https://unpkg.com/supersonic-scsynth-core@latest/'
    this.resolvedSampleBaseURL = this.options.sampleBaseURL ?? 'https://unpkg.com/supersonic-scsynth-samples@latest/samples/'
    this.sonic = new SuperSonicClass({
      baseURL: this.options.baseURL ?? pkgBase,
      workerBaseURL: this.options.baseURL ?? `${pkgBase}workers/`,
      wasmBaseURL: this.options.coreBaseURL ?? `${coreBase}wasm/`,
      coreBaseURL: this.options.coreBaseURL ?? coreBase,
      synthdefBaseURL: this.options.synthdefBaseURL ?? 'https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/',
      sampleBaseURL: this.resolvedSampleBaseURL,
      autoConnect: false,
      scsynthOptions: { numOutputBusChannels: NUM_OUTPUT_CHANNELS },
    } as never)

    await this.sonic.init()

    // Pre-load common SynthDefs
    await this.sonic.loadSynthDefs(COMMON_SYNTHDEFS)
    for (const name of COMMON_SYNTHDEFS) {
      this.loadedSynthDefs.add(name)
    }

    // Create scsynth group structure matching Sonic Pi's studio.rb:
    //   STUDIO-MIXER (head of root) → STUDIO-FX (before mixer) → STUDIO-SYNTHS (before FX)
    // Execution order: synths → FX → mixer (head-to-tail, depth-first)
    const mixerGroupId = this.sonic.nextNodeId()
    this.sonic.send('/g_new', mixerGroupId, 0, 0)  // mixer group at head of root
    this.sonic.send('/g_new', 101, 2, mixerGroupId) // FX group before mixer
    this.sonic.send('/g_new', 100, 2, 101)          // synths group before FX

    // Load and create the master mixer synth — same synthdef as desktop Sonic Pi.
    // Signal chain: in_bus+out_bus → pre_amp → HPF → LPF → Limiter.ar(0.99) → LeakDC → amp → ReplaceOut
    // IMPORTANT: in_bus must be a SEPARATE private bus, not bus 0.
    // The synthdef sums in(out_bus) + in(in_bus). If both are 0, signal is doubled.
    // Sonic Pi allocates @mixer_bus = new_bus(:audio) for in_bus.
    await this.sonic.loadSynthDef('sonic-pi-mixer')
    const mixerBus = this.allocateBus() // private bus — nothing writes to it, reads as silence
    this.mixerNodeId = this.sonic.nextNodeId()
    this.sonic.send('/s_new', 'sonic-pi-mixer', this.mixerNodeId, 0, mixerGroupId,
      'out_bus', 0,
      'in_bus', mixerBus,
      'amp', SONIC_PI_MIXER_AMP,
      'pre_amp', WASM_COMPENSATED_PRE_AMP,  // compensate for WASM's ~2.3x hotter output
    )
    await this.sonic.sync()

    // Multi-channel audio routing:
    // Worklet outputs NUM_OUTPUT_CHANNELS channels (autoConnect=false, we route manually).
    // Channels 0-1 = master bus, 2-3 = track 0, 4-5 = track 1, etc.
    // All channels mix to stereo for speakers; each pair also gets its own AnalyserNode.
    const audioCtx = this.sonic.audioContext
    const workletNode = (this.sonic.node as unknown as Record<string, AudioNode>).input ?? this.sonic.node

    // Split worklet output into individual channels
    this.splitter = audioCtx.createChannelSplitter(NUM_OUTPUT_CHANNELS)
    workletNode.connect(this.splitter)

    // Mix channel pair 0-1 (mixer output) to stereo for speakers.
    // All synths write to bus 0, mixer processes bus 0, outputs to bus 0.
    // Only bus 0 channels carry audio — other channels are for per-track AnalyserNode taps.
    this.masterMerger = audioCtx.createChannelMerger(2)
    this.splitter.connect(this.masterMerger, 0, 0)     // bus 0 left
    this.splitter.connect(this.masterMerger, 1, 1)     // bus 0 right

    // Master gain control — volume is now handled by the scsynth mixer synthdef
    // (pre_amp * amp = 0.2 * 6 = 1.2 effective gain + Limiter.ar at 0.99).
    // Web Audio gain is just for the UI volume slider (default 1.0, no additional scaling).
    this.masterGainNode = audioCtx.createGain()
    this.masterGainNode.gain.value = 1.0

    // Master analyser taps the mixed stereo → gain → speakers
    // No DynamicsCompressor needed — Limiter.ar inside scsynth handles clipping prevention.
    this.analyserNode = audioCtx.createAnalyser()
    this.analyserNode.fftSize = 2048
    this.analyserNode.smoothingTimeConstant = 0.8
    this.masterMerger.connect(this.analyserNode)
    this.analyserNode.connect(this.masterGainNode)
    this.masterGainNode.connect(audioCtx.destination)
  }

  get audioContext(): AudioContext | null {
    return this.sonic?.audioContext ?? null
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  /** Set master volume (0-1). Controls both scsynth mixer pre_amp and Web Audio gain. */
  setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume))
    // Desktop Sonic Pi: set_volume!(vol) → pre_amp = vol * 0.2
    // We apply WASM compensation: pre_amp = vol * 0.2 / WASM_OUTPUT_LEVEL_FACTOR
    const compensatedPreAmp = clamped * SONIC_PI_DEFAULT_PRE_AMP / WASM_OUTPUT_LEVEL_FACTOR
    this.sonic?.send('/n_set', this.mixerNodeId, 'pre_amp', compensatedPreAmp)
    // Web Audio gain for UI slider feedback (not the primary volume control)
    if (this.masterGainNode) {
      this.masterGainNode.gain.setTargetAtTime(clamped, this.masterGainNode.context.currentTime, 0.02)
    }
  }

  /**
   * Enable OSC trace logging — callback receives formatted trace strings
   * matching desktop Sonic Pi's output style.
   *
   * Example output:
   *   /s_new "sonic-pi-basic_stereo_player" 1003 0 100 {buf: 0, amp: 1.5, lpf: 130, out_bus: 0}
   */
  setOscTraceHandler(handler: ((msg: string) => void) | null): void {
    this.oscTraceHandler = handler
  }

  /**
   * Queue an OSC message for batched dispatch.
   * Sonic Pi's model: all play/sample calls between sleeps are collected,
   * then dispatched as ONE OSC bundle on sleep — sharing a single NTP timetag.
   */
  private queueMessage(
    audioTime: number,
    address: string,
    args: (string | number)[],
  ): void {
    this.messageQueueAudioTime = audioTime
    this.messageQueue.push({ address, args })

    // Trace logging — formatted like desktop Sonic Pi's trace output
    if (this.oscTraceHandler) {
      this.oscTraceHandler(formatOscTrace(address, args, audioTime))
    }
  }

  /**
   * Flush all queued messages as a single OSC bundle.
   * Called by the interpreter on sleep/sync/end-of-iteration.
   * Matches Sonic Pi's __schedule_delayed_blocks_and_messages!
   */
  flushMessages(audioTime?: number): void {
    if (!this.sonic || this.messageQueue.length === 0) return
    const t = audioTime ?? this.messageQueueAudioTime
    const ntpTime = audioTimeToNTP(t, this.sonic.audioContext.currentTime)

    if (this.messageQueue.length === 1) {
      // Single message — use the lighter encodeSingleBundle
      const msg = this.messageQueue[0]
      const bundle = this.oscEncoder!.encodeSingleBundle(ntpTime, msg.address, msg.args)
      this.sonic.sendOSC(bundle)
    } else {
      // Multiple messages — batch into one bundle
      const bundle = fallbackEncodeBundle(ntpTime, this.messageQueue)
      this.sonic.sendOSC(bundle)
    }
    this.messageQueue.length = 0
  }

  private async ensureSynthDefLoaded(name: string): Promise<void> {
    const fullName = name.startsWith('sonic-pi-') ? name : `sonic-pi-${name}`
    if (this.loadedSynthDefs.has(fullName)) return
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    await this.sonic.loadSynthDef(fullName)
    this.loadedSynthDefs.add(fullName)
  }

  private async ensureSampleLoaded(name: string): Promise<number> {
    const existing = this.loadedSamples.get(name)
    if (existing !== undefined) return existing
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const bufNum = this.nextBufNum++
    await this.sonic.loadSample(bufNum, `${name}.flac`)
    this.loadedSamples.set(name, bufNum)
    // Cache duration asynchronously — ready for the next loop iteration.
    this.fetchSampleDuration(name).catch(() => {})
    return bufNum
  }

  /**
   * Decode the sample via Web Audio to get its exact duration in seconds.
   * Fires once per sample name and caches the result.
   * Used by beat_stretch / pitch_stretch to apply Sonic Pi's exact formula.
   */
  private async fetchSampleDuration(name: string): Promise<void> {
    if (this.sampleDurations.has(name)) return
    if (!this.sonic) return
    const url = `${this.resolvedSampleBaseURL}${name}.flac`
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await this.sonic.audioContext.decodeAudioData(arrayBuffer)
    this.sampleDurations.set(name, audioBuffer.duration)
  }

  async triggerSynth(
    synthName: string,
    audioTime: number,
    params: Record<string, number>
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const fullName = synthName.startsWith('sonic-pi-') ? synthName : `sonic-pi-${synthName}`
    await this.ensureSynthDefLoaded(fullName)

    const nodeId = this.sonic.nextNodeId()
    const paramList: (string | number)[] = []
    for (const [key, value] of Object.entries(params)) {
      paramList.push(key, value)
    }

    this.queueMessage(audioTime, '/s_new', [fullName, nodeId, 0, 100, ...paramList])
    return nodeId
  }

  async playSample(
    sampleName: string,
    audioTime: number,
    opts?: Record<string, number>,
    bpm?: number
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const bufNum = await this.ensureSampleLoaded(sampleName)
    const nodeId = this.sonic.nextNodeId()

    // Duration is null on first play (async fetch in flight); exact from second play on.
    const duration = this.sampleDurations.get(sampleName) ?? null
    const translated = translateSampleOpts(opts, bpm ?? 60, duration)
    // SoundLayer: BPM-scale time params, inject env_curve for envelope samples, strip non-scsynth
    const params = normalizeSampleParams(translated, bpm ?? 60)

    const paramList: (string | number)[] = ['buf', bufNum]
    for (const [key, value] of Object.entries(params)) {
      paramList.push(key, value)
    }

    // Select synthdef via SoundLayer (basic_stereo_player or stereo_player)
    const playerName = selectSamplePlayer(opts)
    if (playerName !== 'sonic-pi-basic_stereo_player') {
      await this.ensureSynthDefLoaded(playerName)
    }

    this.queueMessage(audioTime, '/s_new', [playerName, nodeId, 0, 100, ...paramList])
    return nodeId
  }

  async applyFx(
    fxName: string,
    audioTime: number,
    params: Record<string, number>,
    inBus: number,
    outBus: number = 0
  ): Promise<number> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    const fullName = `sonic-pi-fx_${fxName}`
    await this.ensureSynthDefLoaded(fullName)

    const nodeId = this.sonic.nextNodeId()
    const paramList: (string | number)[] = ['in_bus', inBus, 'out_bus', outBus]
    for (const [key, value] of Object.entries(params)) {
      paramList.push(key, value)
    }

    this.queueMessage(audioTime, '/s_new', [fullName, nodeId, 0, 101, ...paramList])
    return nodeId
  }

  /**
   * Start capturing live audio from the system input (microphone/line-in).
   * The stream is connected to the master analyser → gain → speakers chain.
   * Disables browser audio processing for clean pass-through.
   */
  async startLiveAudio(name: string, opts?: { stereo?: boolean }): Promise<void> {
    if (!this.sonic) throw new Error('SuperSonic not initialized')

    // If already running under this name, stop it first
    this.stopLiveAudio(name)

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: opts?.stereo ? 2 : 1,
      } as MediaTrackConstraints,
    })

    const audioCtx = this.sonic.audioContext
    const source = audioCtx.createMediaStreamSource(stream)
    // Connect to the analyser node (which feeds into master gain → destination)
    source.connect(this.analyserNode ?? audioCtx.destination)

    this.liveAudioStreams.set(name, { stream, source })
  }

  /** Stop a named live audio stream and release its resources. */
  stopLiveAudio(name: string): void {
    const entry = this.liveAudioStreams.get(name)
    if (entry) {
      entry.source.disconnect()
      entry.stream.getTracks().forEach(t => t.stop())
      this.liveAudioStreams.delete(name)
    }
  }

  /**
   * Allocate a stereo output bus for a track with its own AnalyserNode.
   * Returns the bus number to use as out_bus in synth params.
   * The bus audio is automatically routed to speakers via the worklet's
   * multi-channel output + Web Audio ChannelSplitter.
   */
  allocateTrackBus(trackId: string): number {
    const existing = this.trackBuses.get(trackId)
    if (existing !== undefined) return existing

    if (this.nextTrackBus >= NUM_OUTPUT_CHANNELS) {
      // Out of track buses — fall back to master bus 0
      return 0
    }

    const busNum = this.nextTrackBus
    this.nextTrackBus += 2 // stereo pair

    this.trackBuses.set(trackId, busNum)

    // Create per-track AnalyserNode using the shared splitter
    if (this.sonic && this.splitter) {
      const audioCtx = this.sonic.audioContext
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8

      const merger = audioCtx.createChannelMerger(2)
      this.splitter.connect(merger, busNum, 0)
      this.splitter.connect(merger, busNum + 1, 1)
      merger.connect(analyser)

      this.trackAnalysers.set(trackId, analyser)
    }

    return busNum
  }

  /** Get the per-track AnalyserNode for a specific track. */
  getTrackAnalyser(trackId: string): AnalyserNode | null {
    return this.trackAnalysers.get(trackId) ?? null
  }

  /** Get all per-track AnalyserNodes. */
  getAllTrackAnalysers(): Map<string, AnalyserNode> {
    return this.trackAnalysers
  }

  /** Allocate a private audio bus for FX routing. */
  allocateBus(): number {
    if (this.freeBuses.length > 0) return this.freeBuses.pop()!
    return this.nextBusNum++
  }

  /** Release a private audio bus back to the pool. */
  freeBus(busNum: number): void {
    this.freeBuses.push(busNum)
  }

  /** Check if a sample has been loaded (duration cached). */
  isSampleLoaded(name: string): boolean {
    return this.loadedSamples.has(name)
  }

  /** Get cached sample duration in seconds, or undefined if not yet loaded. */
  getSampleDuration(name: string): number | undefined {
    return this.sampleDurations.get(name)
  }

  /** Free all synth and FX nodes (clean slate for re-evaluate). */
  freeAllNodes(): void {
    if (!this.sonic) return
    this.sonic.send('/g_freeAll', 100)  // synths group
    this.sonic.send('/g_freeAll', 101)  // FX group
  }

  /** Create a new group inside the FX group (101). Returns group ID. */
  createFxGroup(): number {
    if (!this.sonic) throw new Error('SuperSonic not initialized')
    const groupId = this.sonic.nextNodeId()
    // Add to tail of FX group 101
    this.sonic.send('/g_new', groupId, 1, 101)
    return groupId
  }

  /** Kill an entire group and all its contents. */
  freeGroup(groupId: number): void {
    this.sonic?.send('/n_free', groupId)
  }

  /** Queue a timestamped /n_set control message for batched dispatch. */
  sendTimedControl(audioTime: number, nodeId: number, params: (string | number)[]): void {
    this.queueMessage(audioTime, '/n_set', [nodeId, ...params])
  }

  /** Send raw OSC message to SuperSonic (immediate, no timestamp). */
  send(address: string, ...args: (string | number)[]): void {
    this.sonic?.send(address, ...args)
  }

  freeNode(nodeId: number): void {
    this.sonic?.send('/n_free', nodeId)
  }

  dispose(): void {
    // Stop all live audio streams
    for (const name of this.liveAudioStreams.keys()) {
      this.stopLiveAudio(name)
    }
    if (this.masterGainNode) {
      this.masterGainNode.disconnect()
      this.masterGainNode = null
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect()
      this.analyserNode = null
    }
    if (this.sonic) {
      this.sonic.destroy()
      this.sonic = null
    }
    this.loadedSynthDefs.clear()
    this.loadedSamples.clear()
  }
}
