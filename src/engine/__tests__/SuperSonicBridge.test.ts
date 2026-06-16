import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SuperSonicBridge } from '../SuperSonicBridge'
import { MIXER } from '../config'

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
    purge: vi.fn().mockResolvedValue(undefined),
    nextNodeId: vi.fn(() => nodeIdCounter++),
    destroy: vi.fn(),
    node: { connect: vi.fn() },
    audioContext: {
      currentTime: 0,
      sampleRate: 44100,
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

  // #579 — set_volume! over-attenuated web ~50×. Two compounding bugs:
  // (1) the engine divided the 0-5 value by 5 (unity 1.0 → 0.2); (2) this
  // method scaled BOTH scsynth pre_amp AND the Web Audio masterGainNode by the
  // value, multiplying them (≈v²). The fix: 1.0 = unity, drive ONE stage
  // (scsynth pre_amp), leave masterGainNode at unity.
  it('setMasterVolume drives ONLY scsynth pre_amp, 1.0 = unity, no masterGain double-apply (#579)', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // masterGainNode is the single GainNode created during init.
    const gainNode = mockSonic.audioContext.createGain.mock.results[0].value

    const lastPreAmp = (): number => {
      const calls = sent.filter((c) => c.address === '/n_set' && c.args.includes('pre_amp'))
      const args = calls[calls.length - 1].args
      return args[args.indexOf('pre_amp') + 1] as number
    }

    // 1.0 = unity → pre_amp stays at the baseline (no-op).
    bridge.setMasterVolume(1.0)
    expect(lastPreAmp()).toBeCloseTo(MIXER.PRE_AMP, 6)

    // 0.5 = half → pre_amp halved (NOT squared / collapsed).
    bridge.setMasterVolume(0.5)
    expect(lastPreAmp()).toBeCloseTo(MIXER.PRE_AMP * 0.5, 6)

    // Boost (>1) is allowed up to 5 — a boost, not the old ÷5 attenuation.
    bridge.setMasterVolume(2)
    expect(lastPreAmp()).toBeCloseTo(MIXER.PRE_AMP * 2, 6)
    bridge.setMasterVolume(10)
    expect(lastPreAmp()).toBeCloseTo(MIXER.PRE_AMP * 5, 6) // clamped to 5

    // The Web Audio masterGainNode must stay at unity — never driven by volume
    // (it is UI-feedback-only). Driving it too caused the ≈v² collapse.
    expect(gainNode.gain.setTargetAtTime).not.toHaveBeenCalled()
    expect(gainNode.gain.value).toBe(1)
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

  it('slow-path triggerSynth (unloaded synthdef) auto-flushes its /s_new — first node not dropped (#570)', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // `dsaw` is NOT in COMMON_SYNTHDEFS → slow path (ensureSynthDefLoaded.then).
    // The interpreter dispatches `play` fire-and-forget, so its synchronous
    // end-of-iteration flush runs BEFORE this async load resolves. Without the
    // in-`then` flush (#570), this /s_new would sit unsent until the NEXT flush
    // (a one-shot run never flushes again → silence). It must auto-flush, so
    // sendOSC fires with NO explicit flushMessages() call.
    await bridge.triggerSynth('dsaw', 1.0, { note: 52, amp: 0.5 })
    expect(mockSonic.sendOSC).toHaveBeenCalledTimes(1)
    expect(new TextDecoder().decode(bundles[0])).toContain('sonic-pi-dsaw')
  })

  it('fast-path triggerSynth (preloaded synthdef) does NOT auto-flush — waits for the iteration flush (#570 scope guard)', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // `beep` IS preloaded → fast path → queues synchronously, sent only on the
    // interpreter's own flush. The #570 fix must NOT change this (else every
    // event flushes as its own bundle, breaking same-instant co-bundling that
    // SP83/#567 rely on).
    await bridge.triggerSynth('beep', 1.0, { note: 60, amp: 0.5 })
    expect(mockSonic.sendOSC).not.toHaveBeenCalled()
  })

  it('drops non-finite numeric params before /s_new (#509 — NaN must not reach scsynth)', async () => {
    const { mockSonic, bundles } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()
    const warnings: string[] = []
    bridge.warnHandler = (m) => warnings.push(m)

    // cutoff NaN (e.g. from rand(50..85) before #508), vibrato_rate Inf; amp finite.
    await bridge.triggerSynth('blade', 1.0, { note: 60, amp: 0.55, cutoff: NaN, vibrato_rate: Infinity })
    bridge.flushMessages()

    const bundleStr = new TextDecoder().decode(bundles[0])
    expect(bundleStr).toContain('sonic-pi-blade')
    // Finite params survive; the non-finite ones are dropped (scsynth uses defaults).
    expect(bundleStr).toContain('amp')
    expect(bundleStr).not.toContain('cutoff')
    expect(bundleStr).not.toContain('vibrato_rate')
    // Loud, not silent (SV50).
    expect(warnings.some((w) => /non-finite/.test(w) && /cutoff/.test(w) && /vibrato_rate/.test(w))).toBe(true)
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

  it('SV43: a rejected sample load does not poison subsequent retries (SP90 / #304)', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // First load rejects — CORS/404 for a typo'd name, or `sample :user_x`
    // used before registerCustomSample. Every subsequent load resolves
    // (user fixed the typo, or the sample is now registered).
    mockSonic.loadSample.mockReset()
    mockSonic.loadSample
      .mockRejectedValueOnce(new Error('CORS/404'))
      .mockResolvedValue(undefined)

    // The failed load must SURFACE as an error, not resolve silently.
    await expect(bridge.preloadSample('user_typo')).rejects.toThrow()

    // Pre-fix (delete only in .then()): pendingSampleLoads still holds the
    // rejected promise, so this returns the cached rejection and loadSample
    // is never called again — silent forever. Post-fix (.finally clears the
    // entry): the retry re-attempts the load and succeeds.
    const buf = await bridge.preloadSample('user_typo')
    expect(typeof buf).toBe('number')
    expect(mockSonic.loadSample).toHaveBeenCalledTimes(2)
  })

  it('SV43 twin: a rejected synthdef load does not poison subsequent retries (#318.4)', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()

    // First synthdef load rejects — SP89-class: an inventory name the CDN
    // package never shipped, or a transient fetch failure. Subsequent loads
    // resolve (transient recovered, or a retry path).
    mockSonic.loadSynthDef.mockReset()
    mockSonic.loadSynthDef
      .mockRejectedValueOnce(new Error('CORS/404'))
      .mockResolvedValue(undefined)

    // The failed load must SURFACE as an error, not resolve silently.
    await expect(bridge.triggerSynth('hollow', 0, { note: 60 })).rejects.toThrow()

    // Pre-fix (delete only in .then()): pendingSynthDefLoads still holds the
    // rejected promise, so this returns the cached rejection and loadSynthDef
    // is never called again — that synth silent forever. Post-fix (.finally
    // clears the entry): the retry re-attempts the load and succeeds.
    await bridge.triggerSynth('hollow', 0, { note: 60 })
    expect(mockSonic.loadSynthDef).toHaveBeenCalledTimes(2)
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

  // Tier C PR #3 — mixer + introspection (#255).

  it('setMixerControl /n_sets allowlisted params, ignores unknowns with a warning', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()
    sent.length = 0  // discard init messages

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ })
    const applied = bridge.setMixerControl({ lpf: 30, hpf: 200, nonsense: 1 })
    warnSpy.mockRestore()

    expect(applied).toEqual(['lpf', 'hpf'])
    // Each allowed param fires its own /n_set call.
    const sets = sent.filter(m => m.address === '/n_set')
    expect(sets.length).toBe(2)
    expect(sets[0].args[1]).toBe('lpf')
    expect(sets[1].args[1]).toBe('hpf')
  })

  it('setMixerControl skips non-finite values silently', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()
    sent.length = 0

    const applied = bridge.setMixerControl({ lpf: NaN, hpf: 200 })
    expect(applied).toEqual(['hpf'])
  })

  it('resetMixer /n_sets all MIXER defaults, bypass clears, and slide clears (#582)', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()
    sent.length = 0

    bridge.resetMixer()

    const sets = sent.filter(m => m.address === '/n_set')
    expect(sets.length).toBe(1)
    // All params packed into one /n_set call: 5 values + 3 bypass clears +
    // 4 slide clears (#582 — slides reset to 0 so the reset snaps).
    const args = sets[0].args as Array<string | number>
    const paramNames = args.filter((_, i) => i > 0 && i % 2 === 1)
    expect(paramNames).toEqual([
      'amp', 'pre_amp', 'hpf', 'lpf', 'limiter_bypass',
      'hpf_bypass', 'lpf_bypass', 'leak_dc_bypass',
      'pre_amp_slide', 'amp_slide', 'hpf_slide', 'lpf_slide',
    ])
  })

  // #581 — set_mixer_control! must accept *_slide glide times, else a sweep
  // (`set_mixer_control! lpf: 30, lpf_slide: 16`) snaps instead of gliding.
  it('setMixerControl accepts *_slide params (#581)', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()
    sent.length = 0

    const applied = bridge.setMixerControl({ lpf: 30, lpf_slide: 16, pre_amp_slide: 0.5 })
    expect(applied).toEqual(['lpf', 'lpf_slide', 'pre_amp_slide'])
    const sets = sent.filter(m => m.address === '/n_set')
    expect(sets.map(s => s.args[1])).toEqual(['lpf', 'lpf_slide', 'pre_amp_slide'])
  })

  // #582 — resetMixer must reset the CACHED gain state, not just the wire.
  // Otherwise a UI pre-amp slider drag (setMixerPreAmp) after set_volume! +
  // reset_mixer! re-multiplies by the stale currentMasterVolume.
  it('resetMixer clears stale master volume so a later setMixerPreAmp is not re-attenuated (#582)', async () => {
    const { mockSonic, sent } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()

    const lastPreAmp = (): number => {
      const calls = sent.filter((c) => c.address === '/n_set' && c.args.includes('pre_amp'))
      const args = calls[calls.length - 1].args
      return args[args.indexOf('pre_amp') + 1] as number
    }

    bridge.setMasterVolume(0.5)          // currentMasterVolume = 0.5
    bridge.resetMixer()                  // must reset currentMasterVolume → 1
    expect(lastPreAmp()).toBeCloseTo(MIXER.PRE_AMP, 6) // composed 1 × baseline, not 0.5×

    // The UI pre-amp slider now lands at its raw value, not 0.5× of it.
    bridge.setMixerPreAmp(0.5)
    expect(lastPreAmp()).toBeCloseTo(0.5, 6) // 1 × 0.5, NOT stale 0.5 × 0.5 = 0.25
  })

  it('getScsynthInfo returns a config dict with sample-rate-derived fields', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()

    const info = bridge.getScsynthInfo()
    expect(info.sample_rate).toBe(44100)
    expect(info.sample_dur).toBeCloseTo(1 / 44100)
    expect(info.control_rate).toBeCloseTo(44100 / 64)
    expect(info.num_buffers).toBe(4096)
  })

  it('getStatus reports loaded synthdef count', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
    const bridge = new SuperSonicBridge()
    await bridge.init()

    const status = bridge.getStatus()
    // After init, the mixer synthdef ('sonic-pi-mixer') is registered.
    expect(status.sdefs).toBeGreaterThanOrEqual(1)
    expect(status.nom_samp_rate).toBe(44100)
    expect(status.act_samp_rate).toBe(44100)
  })

  it('dispose cleans up', async () => {
    const { mockSonic } = createMockSuperSonic()
    ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)

    const bridge = new SuperSonicBridge()
    await bridge.init()
    bridge.dispose()

    expect(mockSonic.destroy).toHaveBeenCalled()
  })

  // GAP E (#493): Stop declick — fade the mixer amp, defer /g_freeAll until the
  // fade completes, and let a Run within the fade window flush it first.
  describe('fadeOutAndFreeAllNodes — Stop declick (GAP E, #493)', () => {
    it('fades the mixer amp to 0 and DEFERS the /g_freeAll until after the fade', async () => {
      vi.useFakeTimers()
      try {
        const { mockSonic, sent } = createMockSuperSonic()
        ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
        const bridge = new SuperSonicBridge()
        await bridge.init()
        sent.length = 0

        bridge.fadeOutAndFreeAllNodes()

        // Mixer amp ramped to 0 immediately (amp_slide set, then amp 0).
        const sets = sent.filter(m => m.address === '/n_set')
        expect(sets.some(m => m.args[1] === 'amp_slide')).toBe(true)
        const ampSet = sets.find(m => m.args[1] === 'amp')
        expect(ampSet?.args[2]).toBe(0)
        // The hard node-free is NOT sent yet — it's deferred behind the fade.
        expect(sent.some(m => m.address === '/g_freeAll')).toBe(false)

        // After the fade window, /g_freeAll fires and the amp is restored.
        vi.runAllTimers()
        const frees = sent.filter(m => m.address === '/g_freeAll').map(m => m.args[0])
        expect(frees).toEqual([100, 101, 102])
        const restore = sent.filter(m => m.address === '/n_set' && m.args[1] === 'amp').pop()
        expect(restore?.args[2]).not.toBe(0)  // restored to the pre-fade baseline
      } finally {
        vi.useRealTimers()
      }
    })

    it('flushPendingStopFade completes the deferred free immediately (Run during fade)', async () => {
      vi.useFakeTimers()
      try {
        const { mockSonic, sent } = createMockSuperSonic()
        ;(globalThis as Record<string, unknown>).SuperSonic = vi.fn(() => mockSonic)
        const bridge = new SuperSonicBridge()
        await bridge.init()
        sent.length = 0

        bridge.fadeOutAndFreeAllNodes()
        expect(sent.some(m => m.address === '/g_freeAll')).toBe(false)  // still deferred

        bridge.flushPendingStopFade()  // simulate a Run inside the fade window
        expect(sent.filter(m => m.address === '/g_freeAll').map(m => m.args[0])).toEqual([100, 101, 102])

        // The deferred timer must not double-fire after the flush.
        sent.length = 0
        vi.runAllTimers()
        expect(sent.some(m => m.address === '/g_freeAll')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
