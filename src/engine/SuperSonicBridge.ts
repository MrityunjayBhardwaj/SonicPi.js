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
 * - beat_stretch: N → rate adjusted so sample fits N beats at current BPM
 * - pitch_stretch: N → rate + pitch correction (not fully supported yet)
 * - rpitch: N → pitch shift in semitones (rate = 2^(N/12))
 * - start/finish → normalized start/end points [0..1]
 * - amp, pan, rate → pass through directly
 * - attack, sustain, decay, release → envelope params
 * - lpf, hpf, cutoff → filter params
 */
function translateSampleOpts(
  opts: Record<string, number> | undefined,
  bpm: number
): Record<string, number> {
  if (!opts) return {}

  const result: Record<string, number> = {}
  const beatDuration = 60 / bpm // seconds per beat

  for (const [key, value] of Object.entries(opts)) {
    switch (key) {
      case 'beat_stretch':
        // Approximate: assume typical sample is ~1 beat long at default rate
        // Real implementation would query sample duration from SuperSonic
        // rate = original_duration / (beat_stretch * beat_duration)
        // For a rough approximation, use rate = 1 / (value * bpm/60)
        // This works well for loop samples that are ~1 second at 60bpm
        result['rate'] = (result['rate'] ?? 1) / value
        break

      case 'pitch_stretch':
        // Like beat_stretch but should preserve pitch — needs granular synthesis
        // Approximate with rate change (pitch will change)
        result['rate'] = (result['rate'] ?? 1) / value
        break

      case 'rpitch':
        // Pitch shift in semitones via rate change
        result['rate'] = (result['rate'] ?? 1) * Math.pow(2, value / 12)
        break

      // Direct pass-through params (scsynth understands these)
      case 'rate':
      case 'amp':
      case 'pan':
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
        result[key] = value
        break

      default:
        // Pass unknown params through — scsynth may understand them
        result[key] = value
        break
    }
  }

  return result
}

export class SuperSonicBridge {
  private sonic: SuperSonic | null = null
  private loadedSynthDefs = new Set<string>()
  private loadedSamples = new Map<string, number>()
  private nextBufNum = 0
  private analyserNode: AnalyserNode | null = null
  private options: SuperSonicBridgeOptions
  /** Audio bus allocator — buses 0-15 are hardware, 16+ are private */
  private nextBusNum = 16
  private freeBuses: number[] = []

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

    this.sonic = new SuperSonicClass({
      baseURL: this.options.baseURL ?? 'https://unpkg.com/supersonic-scsynth@latest/dist/',
      coreBaseURL: this.options.coreBaseURL ?? 'https://unpkg.com/supersonic-scsynth-core@latest/',
      synthdefBaseURL: this.options.synthdefBaseURL ?? 'https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/',
      sampleBaseURL: this.options.sampleBaseURL ?? 'https://unpkg.com/supersonic-scsynth-samples@latest/samples/',
    })

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

    // Create AnalyserNode tap
    this.analyserNode = this.sonic.audioContext.createAnalyser()
    this.analyserNode.fftSize = 2048
    this.analyserNode.smoothingTimeConstant = 0.8
    this.sonic.node.connect(this.analyserNode)
  }

  get audioContext(): AudioContext | null {
    return this.sonic?.audioContext ?? null
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode
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
    // Samples are typically .flac in SuperSonic's sample pack
    await this.sonic.loadSample(bufNum, `${name}.flac`)
    this.loadedSamples.set(name, bufNum)
    return bufNum
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

    // Translate Sonic Pi sample opts to scsynth params
    const params = translateSampleOpts(opts, bpm ?? 60)

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

  /** Allocate a private audio bus for FX routing. */
  allocateBus(): number {
    if (this.freeBuses.length > 0) return this.freeBuses.pop()!
    return this.nextBusNum++
  }

  /** Release a private audio bus back to the pool. */
  freeBus(busNum: number): void {
    this.freeBuses.push(busNum)
  }

  /** Send raw OSC message to SuperSonic. */
  send(address: string, ...args: (string | number)[]): void {
    this.sonic?.send(address, ...args)
  }

  freeNode(nodeId: number): void {
    this.sonic?.send('/n_free', nodeId)
  }

  dispose(): void {
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
