/**
 * Wrapper around SuperSonic (scsynth WASM).
 *
 * SuperSonic is loaded via CDN (GPL core), never bundled.
 * This bridge handles init, synth triggering, sample playback,
 * FX, AnalyserNode tap, and cleanup.
 */

// SuperSonic types — declared here since we load it at runtime via CDN
interface SuperSonic {
  init(): Promise<void>
  send(address: string, ...args: (string | number)[]): void
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

interface SuperSonicConstructor {
  new (options: {
    baseURL: string
    coreBaseURL?: string
    synthdefBaseURL: string
    sampleBaseURL?: string
  }): SuperSonic
}

export interface SuperSonicBridgeOptions {
  /** Pass the SuperSonic constructor (from ES module import) */
  SuperSonicClass?: SuperSonicConstructor
  baseURL?: string
  coreBaseURL?: string
  synthdefBaseURL?: string
  sampleBaseURL?: string
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

/**
 * Translate Sonic Pi sample opts to scsynth params.
 *
 * Sonic Pi → scsynth mappings:
 * - beat_stretch: N → rate = (1/N) * existing_rate * (bpm / (60 / duration))
 *     Exact formula from Sonic Pi sound.rb. Requires sample duration.
 *     Falls back to (existing_rate / N) when duration is unknown (first play only).
 * - pitch_stretch: N → same rate as beat_stretch + pitch compensation
 *     pitch_shift = 12 * log2(rate), then pitch -= pitch_shift to cancel it.
 *     Preserves pitch exactly via scsynth's :pitch parameter.
 * - rpitch: N → pitch shift in semitones (rate = 2^(N/12))
 * - start/finish → normalized start/end points [0..1]
 * - amp, pan, rate, pitch → pass through directly
 * - attack, sustain, decay, release → envelope params
 */
function translateSampleOpts(
  opts: Record<string, number> | undefined,
  bpm: number,
  sampleDuration: number | null  // seconds — null = unknown (first play), use fallback
): Record<string, number> {
  if (!opts) return {}

  const result: Record<string, number> = {}

  for (const [key, value] of Object.entries(opts)) {
    switch (key) {
      case 'beat_stretch': {
        // Sonic Pi sound.rb exact formula:
        //   rate = (1.0 / beat_stretch) * existing_rate * (bpm / (60.0 / duration))
        const existingRate = result['rate'] ?? 1
        if (sampleDuration !== null) {
          result['rate'] = (1.0 / value) * existingRate * (bpm / (60.0 / sampleDuration))
        } else {
          // Duration not yet cached (first play) — approximate until next iteration
          result['rate'] = existingRate / value
        }
        break
      }

      case 'pitch_stretch': {
        // Sonic Pi sound.rb exact formula:
        //   new_rate    = (1.0 / pitch_stretch) * (bpm / (60.0 / duration))
        //   pitch_shift = 12 * log2(new_rate)          — semitones the rate would cause
        //   rate        = new_rate * existing_rate
        //   pitch      -= pitch_shift                  — compensate exactly
        const existingRate = result['rate'] ?? 1
        const existingPitch = result['pitch'] ?? 0
        if (sampleDuration !== null) {
          const newRate = (1.0 / value) * (bpm / (60.0 / sampleDuration))
          const pitchShift = 12 * Math.log2(newRate)
          result['rate'] = newRate * existingRate
          result['pitch'] = existingPitch - pitchShift
        } else {
          // Duration not yet cached — rate only, pitch will drift this iteration
          result['rate'] = existingRate / value
        }
        break
      }

      case 'rpitch':
        // Pitch shift in semitones via rate change (matches Sonic Pi rpitch behaviour)
        result['rate'] = (result['rate'] ?? 1) * Math.pow(2, value / 12)
        break

      // Direct pass-through params (scsynth understands these)
      case 'rate':
      case 'amp':
      case 'pan':
      case 'pitch':
      case 'attack':
      case 'sustain':
      case 'decay':
      case 'release':
      case 'cutoff':
      case 'lpf':
      case 'hpf':
      case 'res':
      case 'start':
      case 'finish':
      case 'loop':
        result[key] = value
        break

      default:
        result[key] = value
        break
    }
  }

  return result
}

/** Max stereo track outputs (beyond master). Channels 0-1 = master, 2-3 = track 0, etc. */
const MAX_TRACK_OUTPUTS = 6
const NUM_OUTPUT_CHANNELS = 2 + MAX_TRACK_OUTPUTS * 2 // 14 channels total

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

    // Create scsynth group structure (same as Sonic Pi)
    this.sonic.send('/g_new', 100, 0, 0) // synths group at head
    this.sonic.send('/g_new', 101, 1, 0) // FX group at tail
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

    // Mix all channel pairs to stereo for speakers
    this.masterMerger = audioCtx.createChannelMerger(2)
    for (let ch = 0; ch < NUM_OUTPUT_CHANNELS; ch += 2) {
      this.splitter.connect(this.masterMerger, ch, 0)     // left
      this.splitter.connect(this.masterMerger, ch + 1, 1) // right
    }

    // Master gain control (default 0.8 to match UI slider)
    this.masterGainNode = audioCtx.createGain()
    this.masterGainNode.gain.value = 0.8

    // Master analyser taps the mixed stereo → gain → speakers
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

  /** Set master volume (0-1). Uses exponential ramp for smooth transitions. */
  setMasterVolume(volume: number): void {
    if (!this.masterGainNode) return
    const clamped = Math.max(0, Math.min(1, volume))
    this.masterGainNode.gain.setTargetAtTime(clamped, this.masterGainNode.context.currentTime, 0.02)
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

    this.sonic.send('/s_new', fullName, nodeId, 0, 100, ...paramList)
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
    const params = translateSampleOpts(opts, bpm ?? 60, duration)

    const paramList: (string | number)[] = ['buf', bufNum]
    for (const [key, value] of Object.entries(params)) {
      paramList.push(key, value)
    }

    this.sonic.send('/s_new', 'sonic-pi-basic_stereo_player', nodeId, 0, 100, ...paramList)
    return nodeId
  }

  async applyFx(
    fxName: string,
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

    this.sonic.send('/s_new', fullName, nodeId, 0, 101, ...paramList)
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

  /** Send raw OSC message to SuperSonic. */
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
