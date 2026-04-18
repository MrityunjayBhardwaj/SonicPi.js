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
    // Mixer group at head of root, monitors before mixer, FX before monitors, synths before FX
    const sendCalls = mockSonic.send.mock.calls
    const gNewCalls = sendCalls.filter((c: unknown[]) => c[0] === '/g_new')
    expect(gNewCalls.length).toBe(4) // mixer group, monitors group (102), FX group (101), synths group (100)
    // Mixer synthdef loaded and triggered
    expect(mockSonic.loadSynthDef).toHaveBeenCalledWith('sonic-pi-mixer')
    expect(mockSonic.sync).toHaveBeenCalled()
    expect(mockSonic.node.connect).toHaveBeenCalled()
  })

  it('triggerSynth queues message, flushMessages sends bundle', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    const nodeId = await bridge.triggerSynth('beep', 1.0, { note: 60, amp: 0.5 })
    // Not sent yet — queued
    expect(mockSonic.sendOSC).not.toHaveBeenCalled()

    // Flush — now it sends
    bridge.flushMessages()
    expect(typeof nodeId).toBe('number')
    expect(mockSonic.sendOSC).toHaveBeenCalledTimes(1)
    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('sonic-pi-beep')
  })

  it('multiple events between flushes share one bundle', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.triggerSynth('beep', 1.0, { note: 60 })
    await bridge.triggerSynth('saw', 1.0, { note: 62 })
    await bridge.playSample('bd_haus', 1.0)

    bridge.flushMessages()
    // All 3 events in ONE sendOSC call
    expect(mockSonic.sendOSC).toHaveBeenCalledTimes(1)
    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('sonic-pi-beep')
    expect(bundleStr).toContain('sonic-pi-saw')
    expect(bundleStr).toContain('sonic-pi-basic_stereo_player')
  })

  it('playSample loads sample and queues message', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.playSample('bd_haus', 1.0)
    bridge.flushMessages()

    expect(mockSonic.loadSample).toHaveBeenCalledWith(0, 'bd_haus.flac')
    expect(mockSonic.sendOSC).toHaveBeenCalled()
    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('sonic-pi-basic_stereo_player')
  })

  it('caches loaded SynthDefs', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

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
    bridge.flushMessages()

    const bundle = bundles[0]
    const header = new TextDecoder().decode(bundle.slice(0, 7))
    expect(header).toBe('#bundle')
    expect(bundle[7]).toBe(0)
    const dv = new DataView(bundle.buffer, bundle.byteOffset)
    const ntpSecs = dv.getUint32(8, false)
    expect(ntpSecs).toBeGreaterThan(2208988800)
  })

  it('applyFx queues message', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    const nodeId = await bridge.applyFx('reverb', 1.0, { room: 0.8 }, 16, 0)
    bridge.flushMessages()

    expect(typeof nodeId).toBe('number')
    expect(mockSonic.sendOSC).toHaveBeenCalled()
    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('sonic-pi-fx_reverb')
  })

  it('tb303 passes pre-normalized params through', async () => {
    // tb303 munging is now in SoundLayer (normalizePlayParams), not bridge.
    // Bridge receives already-normalized params from AudioInterpreter.
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // Simulate what AudioInterpreter sends after SoundLayer normalization
    await bridge.triggerSynth('tb303', 1.0, {
      note: 40, release: 0.3, cutoff: 60,
      cutoff_release: 0.3, cutoff_min: 30, env_curve: 2,
    })
    bridge.flushMessages()

    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('release')
    expect(bundleStr).toContain('cutoff_release')
    expect(bundleStr).toContain('cutoff_min')
  })

  it('beep synth not affected by tb303 normalization', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    await bridge.triggerSynth('beep', 1.0, { note: 60, release: 0.3 })
    bridge.flushMessages()

    const bundleStr = new TextDecoder().decode(bundles[0])
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
