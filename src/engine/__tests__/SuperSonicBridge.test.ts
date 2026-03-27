import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SuperSonicBridge } from '../SuperSonicBridge'

// Mock SuperSonic constructor on globalThis
function createMockSuperSonic() {
  const sent: Array<{ address: string; args: (string | number)[] }> = []
  let nodeIdCounter = 1000

  const mockSonic = {
    init: vi.fn().mockResolvedValue(undefined),
    send: vi.fn((address: string, ...args: (string | number)[]) => {
      sent.push({ address, args })
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

  return { mockSonic, sent }
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
    // Should have created synth + FX groups
    expect(mockSonic.send).toHaveBeenCalledWith('/g_new', 100, 0, 0)
    expect(mockSonic.send).toHaveBeenCalledWith('/g_new', 101, 1, 0)
    expect(mockSonic.sync).toHaveBeenCalled()
    // Should have tapped AnalyserNode
    expect(mockSonic.node.connect).toHaveBeenCalled()
  })

  it('triggerSynth sends /s_new OSC', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    sent.length = 0 // clear init messages
    const nodeId = await bridge.triggerSynth('beep', 1.0, { note: 60, amp: 0.5 })

    expect(nodeId).toBe(1000)
    const sNewCall = sent.find(s => s.address === '/s_new')
    expect(sNewCall).toBeDefined()
    expect(sNewCall!.args[0]).toBe('sonic-pi-beep')
  })

  it('playSample loads sample and triggers player', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    sent.length = 0
    await bridge.playSample('bd_haus', 1.0)

    expect(mockSonic.loadSample).toHaveBeenCalledWith(0, 'bd_haus.flac')
    const sNewCall = sent.find(s => s.address === '/s_new')
    expect(sNewCall).toBeDefined()
    expect(sNewCall!.args[0]).toBe('sonic-pi-basic_stereo_player')
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

  it('dispose cleans up', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()
    bridge.dispose()

    expect(mockSonic.destroy).toHaveBeenCalled()
  })
})
