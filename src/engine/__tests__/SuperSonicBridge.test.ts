import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SuperSonicBridge } from '../SuperSonicBridge'

/** Extract the OSC address string from a raw OSC bundle (starts after 16-byte header + 4-byte size). */
function extractBundleAddress(bundle: Uint8Array): string {
  // Bundle layout: "#bundle\0" (8) + timetag (8) + element size (4) + message...
  const msgStart = 20
  let end = msgStart
  while (end < bundle.length && bundle[end] !== 0) end++
  return new TextDecoder().decode(bundle.slice(msgStart, end))
}

/** Extract a string arg from an OSC bundle starting at a given byte offset. */
function extractStringAt(bundle: Uint8Array, offset: number): string {
  let end = offset
  while (end < bundle.length && bundle[end] !== 0) end++
  return new TextDecoder().decode(bundle.slice(offset, end))
}

// Mock SuperSonic constructor on globalThis
function createMockSuperSonic() {
  const sent: Array<{ address: string; args: (string | number)[] }> = []
  const bundles: Uint8Array[] = []
  let nodeIdCounter = 1000

  const mockSonic = {
    init: vi.fn().mockResolvedValue(undefined),
    send: vi.fn((address: string, ...args: (string | number)[]) => {
      sent.push({ address, args })
    }),
    sendOSC: vi.fn((data: Uint8Array) => {
      bundles.push(new Uint8Array(data))
    }),
    loadSynthDef: vi.fn().mockResolvedValue(undefined),
    loadSynthDefs: vi.fn().mockResolvedValue(undefined),
    loadSample: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    nextNodeId: vi.fn(() => nodeIdCounter++),
    destroy: vi.fn(),
    node: { connect: vi.fn() },
    audioContext: {
      currentTime: 0,
      destination: { connect: vi.fn() },
      createAnalyser: vi.fn(() => ({
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createChannelSplitter: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createChannelMerger: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createGain: vi.fn(() => ({
        gain: { value: 1, setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
    },
  }

  return { mockSonic, sent, bundles }
}

describe('SuperSonicBridge', () => {
  beforeEach(() => {
    // Clean up global
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('throws if SuperSonic not loaded', async () => {
    const bridge = new SuperSonicBridge()
    await expect(bridge.init()).rejects.toThrow('SuperSonic not found')
  })

  it('initializes with mock SuperSonic', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    expect(mockSonic.init).toHaveBeenCalled()
    expect(mockSonic.loadSynthDefs).toHaveBeenCalled()
    // Should have created synth + FX groups (immediate, no bundle)
    expect(mockSonic.send).toHaveBeenCalledWith('/g_new', 100, 0, 0)
    expect(mockSonic.send).toHaveBeenCalledWith('/g_new', 101, 1, 0)
    expect(mockSonic.sync).toHaveBeenCalled()
    // Should have tapped AnalyserNode
    expect(mockSonic.node.connect).toHaveBeenCalled()
  })

  it('triggerSynth sends /s_new via OSC bundle', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    const nodeId = await bridge.triggerSynth('beep', 1.0, { note: 60, amp: 0.5 })

    expect(nodeId).toBe(1000)
    expect(mockSonic.sendOSC).toHaveBeenCalledTimes(1)
    // Verify the bundle contains /s_new address and sonic-pi-beep synthdef
    const bundle = bundles[0]
    expect(extractBundleAddress(bundle)).toBe('/s_new')
    // Type tag string follows address — then first string arg is the synthdef name
    // Find 'sonic-pi-beep' in the bundle bytes
    const bundleStr = new TextDecoder().decode(bundle)
    expect(bundleStr).toContain('sonic-pi-beep')
  })

  it('playSample loads sample and sends via OSC bundle', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.playSample('bd_haus', 1.0)

    expect(mockSonic.loadSample).toHaveBeenCalledWith(0, 'bd_haus.flac')
    expect(mockSonic.sendOSC).toHaveBeenCalled()
    const bundle = bundles[0]
    expect(extractBundleAddress(bundle)).toBe('/s_new')
    const bundleStr = new TextDecoder().decode(bundle)
    expect(bundleStr).toContain('sonic-pi-basic_stereo_player')
  })

  it('caches loaded SynthDefs', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // beep was pre-loaded, so loadSynthDef should not be called again
    mockSonic.loadSynthDef.mockClear()
    await bridge.triggerSynth('beep', 0, { note: 60 })
    expect(mockSonic.loadSynthDef).not.toHaveBeenCalled()
  })

  it('OSC bundle contains NTP timetag', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.triggerSynth('beep', 2.5, { note: 72 })

    const bundle = bundles[0]
    // First 8 bytes: "#bundle\0"
    const header = new TextDecoder().decode(bundle.slice(0, 7))
    expect(header).toBe('#bundle')
    expect(bundle[7]).toBe(0)
    // Next 8 bytes: NTP timetag (should be non-zero for timed events)
    const dv = new DataView(bundle.buffer, bundle.byteOffset)
    const ntpSecs = dv.getUint32(8, false)
    // NTP seconds should be > 2208988800 (NTP epoch offset) for any time after 1970
    expect(ntpSecs).toBeGreaterThan(2208988800)
  })

  it('applyFx sends via OSC bundle', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    const nodeId = await bridge.applyFx('reverb', 1.0, { room: 0.8 }, 16, 0)

    expect(nodeId).toBe(1000)
    expect(mockSonic.sendOSC).toHaveBeenCalled()
    const bundle = bundles[0]
    expect(extractBundleAddress(bundle)).toBe('/s_new')
    const bundleStr = new TextDecoder().decode(bundle)
    expect(bundleStr).toContain('sonic-pi-fx_reverb')
  })

  it('tb303 mirrors release to cutoff_release', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.triggerSynth('tb303', 1.0, { note: 40, release: 0.3, cutoff: 60 })

    const bundle = bundles[0]
    const bundleStr = new TextDecoder().decode(bundle)
    // Should contain both release and cutoff_release
    expect(bundleStr).toContain('release')
    expect(bundleStr).toContain('cutoff_release')
    expect(bundleStr).toContain('cutoff_min')
  })

  it('tb303 does not override explicit cutoff_release', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // User explicitly sets cutoff_release — should NOT be overridden
    await bridge.triggerSynth('tb303', 1.0, { note: 40, release: 0.3, cutoff_release: 1.5 })

    const bundle = bundles[0]
    const bundleStr = new TextDecoder().decode(bundle)
    expect(bundleStr).toContain('cutoff_release')
    // Verify the value is 1.5 (user's explicit value), not 0.3 (mirrored)
    const dv = new DataView(bundle.buffer, bundle.byteOffset)
    // Find cutoff_release float value in the bundle
    const crIdx = bundleStr.indexOf('cutoff_release')
    // The float follows the string (padded to 4-byte boundary)
    // cutoff_release = 15 chars + null + pad = 16 bytes, then float
    const floatOffset = crIdx + 16
    const val = dv.getFloat32(floatOffset, false)
    expect(val).toBeCloseTo(1.5, 1)
  })

  it('beep synth is not affected by tb303 normalization', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.triggerSynth('beep', 1.0, { note: 60, release: 0.3 })

    const bundle = bundles[0]
    const bundleStr = new TextDecoder().decode(bundle)
    // beep should NOT get cutoff_release mirroring
    expect(bundleStr).not.toContain('cutoff_release')
    expect(bundleStr).not.toContain('cutoff_min')
  })

  it('dispose cleans up', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()
    bridge.dispose()

    expect(mockSonic.destroy).toHaveBeenCalled()
  })
})
