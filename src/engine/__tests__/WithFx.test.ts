import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler, type SchedulerEvent } from '../VirtualTimeScheduler'
import { ProgramBuilder } from '../ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'
import type { SuperSonicBridge } from '../SuperSonicBridge'

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

/**
 * Mock bridge that implements the subset of SuperSonicBridge used by AudioInterpreter.
 * Tracks calls for assertion.
 */
function createMockBridge(): SuperSonicBridge & { calls: string[] } {
  let nextBus = 16
  let nextNode = 5000
  const calls: string[] = []
  return {
    calls,
    allocateBus() { const b = nextBus++; calls.push(`alloc:${b}`); return b },
    freeBus(n: number) { calls.push(`free:${n}`) },
    async applyFx(name: string, _audioTime: number, params: Record<string, number>, inBus: number, outBus: number) {
      const id = nextNode++
      calls.push(`fx:${name}:in${inBus}:out${outBus}`)
      return id
    },
    // #424: the inline with_fx CREATE branch now accumulates FX via
    // applyFxOrdered (one ordered immediate bundle) instead of applyFx +
    // flushMessages(0). Record identically so the bus-wiring assertions hold.
    async applyFxOrdered(name: string, params: Record<string, number>, inBus: number, outBus: number) {
      const id = nextNode++
      calls.push(`fx:${name}:in${inBus}:out${outBus}`)
      return id
    },
    flushImmediateFx() { calls.push('flushFx') },
    freeNode(id: number) { calls.push(`freeNode:${id}`) },
    createFxGroup() { const g = nextNode++; calls.push(`createGroup:${g}`); return g },
    freeGroup(id: number) { calls.push(`freeGroup:${id}`) },
    flushMessages() { calls.push('flush') },
    async triggerSynth(_name: string, _time: number, params: Record<string, number>) {
      return nextNode++
    },
    async playSample(_name: string, _time: number, _opts?: Record<string, number>, _bpm?: number) {
      return nextNode++
    },
    // SP135/#506: the bridge reports a sample's real BUFFER PLAYOUT length so the
    // with_fx aliveUntil bump outlives it (a sample's audible end is its buffer,
    // not its amp release). The fixture sample below plays out for 6s.
    async ensureSamplePlaybackDuration(_name: string, _opts?: Record<string, number>, _bpm?: number) {
      calls.push(`sampleDur:${_name}`)
      return 6
    },
    get audioContext() { return null as unknown as AudioContext },
    send(_addr: string, ..._args: (string | number)[]) {},
    sendTimedControl(_time: number, _nodeId: number, _params: (string | number)[]) {},
  } as unknown as SuperSonicBridge & { calls: string[] }
}

function makeAudioCtx(
  scheduler: VirtualTimeScheduler,
  taskId: string,
  eventStream: SoundEventStream,
  nodeRefMap: Map<number, number>,
  bridge: SuperSonicBridge | null = null
): AudioCtx {
  return {
    bridge,
    scheduler,
    taskId,
    eventStream,
    schedAheadTime: 100,
    nodeRefMap,
    reusableFx: new Map(),
  }
}

describe('with_fx', () => {
  it('allocates bus, creates FX, routes synths, restores bus', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const bridge = createMockBridge()

    // Build program: with_fx(:reverb, room: 0.8) { play 60; sleep 0.5 }; play 72; sleep 999999
    const program = new ProgramBuilder(0)
      .with_fx('reverb', { room: 0.8 }, (b) => b.play(60).sleep(0.5))
      .play(72)
      .sleep(999999)
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge))
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // FX bridge should have been called
    expect(bridge.calls).toContain('alloc:16')
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    expect(bridge.calls).toContain('createGroup:5000')
    // Group freeing is delayed by kill_delay (default 1s of VIRTUAL time, SV41)
    // — advance the scheduler past the kill horizon. cbHorizon = target -
    // schedAhead, so target=200 with schedAhead=100 → cbHorizon=100 ≥ 1.5.
    scheduler.tick(200)
    await flushMicrotasks()
    expect(bridge.calls).toContain('freeGroup:5000')
    expect(bridge.calls).toContain('free:16')
  })

  it('with_fx kill_delay waits for inner play release (mod_303_phade — vt-aware aliveUntil)', async () => {
    // Regression test for the `with_fx { play release: N>1 }` truncation class
    // (mod_303_phade, official roster). The FX kill was hardcoded at
    // `vt + killDelay` (default 1.0s) AFTER the block exits — ignoring inner
    // play's envelope. Desktop SP waits for `tracker.block_until_finished` THEN
    // sleeps kill_delay (sound.rb:1817-1822). Fix: track `aliveUntil` per FX
    // scope, extended by each inner play to `vt + attack + decay + sustain +
    // release`. killAt = max(vt_at_block_exit, aliveUntil) + killDelay.
    //
    // Program: with_fx :reverb { play 60, attack:0 decay:0 sustain:0 release:5 }
    // Expected: aliveUntil = 0 + 0+0+0+5 = 5. killAt = max(0,5) + 1 = 6.
    // Pre-fix: killAt = 0 + 1 = 1. Assertions at cbHorizon=3 distinguish the two.
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const bridge = createMockBridge()

    const program = new ProgramBuilder(0)
      .with_fx('reverb', (b) =>
        b.play(60, { attack: 0, decay: 0, sustain: 0, release: 5 })
      )
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge))
    })

    scheduler.tick(100); await flushMicrotasks()
    scheduler.tick(100); await flushMicrotasks()
    expect(bridge.calls).toContain('fx:reverb:in16:out0')

    // cbHorizon=3 — past the BUGGY 1s kill horizon, before the CORRECT 6s one.
    // Pre-fix this fires the kill (calls.contains 'free:16'); post-fix it does NOT.
    scheduler.tick(103); await flushMicrotasks()
    expect(bridge.calls.find(c => c.startsWith('freeNode:'))).toBeUndefined()
    expect(bridge.calls.find(c => c.startsWith('freeGroup:'))).toBeUndefined()
    expect(bridge.calls.find(c => c === 'free:16')).toBeUndefined()

    // cbHorizon=100 — well past the 6s correct horizon. FX should be freed now.
    scheduler.tick(200); await flushMicrotasks()
    expect(bridge.calls).toContain('freeGroup:5000')
    expect(bridge.calls).toContain('free:16')
  })

  it('with_fx kill_delay waits for a SAMPLE\'s buffer playout, not its amp release (SP135/#506)', async () => {
    // Regression test for the SAMPLE sibling of the SP104 truncation class.
    // A sample's audible end is its BUFFER PLAYOUT (bufferFrames/sampleRate,
    // rate/start/finish-scaled), NOT its amp `release`. The old aliveUntil bump
    // summed `attack+decay+sustain+release` (release fallback 1.0), so a
    // short-release sample whose buffer plays for seconds (e.g. dark_neon's
    // `bass_trance_c, rate:0.5, release:0.2`) had aliveUntil≈vt+0.2 → the FX bus
    // was freed at killAt≈1.2 while the buffer was still playing → silence.
    // Fix: bump aliveUntil by the bridge's real playback duration
    // (ensureSamplePlaybackDuration). The mock reports 6s of buffer playout.
    //
    // Program: with_fx :reverb { sample :loop, release: 0.2 }
    // Pre-fix: aliveUntil = 0 + 0+0+0+0.2 = 0.2, killAt = max(0,0.2)+1 = 1.2.
    // Post-fix: aliveUntil = 0 + 6 = 6, killAt = max(0,6)+1 = 7.
    // cbHorizon=3 distinguishes the two (past buggy 1.2, before correct 7).
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const bridge = createMockBridge()

    const program = new ProgramBuilder(0)
      .with_fx('reverb', (b) => b.sample('loop', { release: 0.2 }))
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge))
    })

    scheduler.tick(100); await flushMicrotasks()
    scheduler.tick(100); await flushMicrotasks()
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    // The aliveUntil bump must have consulted the bridge for the real duration.
    expect(bridge.calls).toContain('sampleDur:loop')

    // cbHorizon=3 — past the BUGGY 1.2s kill horizon, before the CORRECT 7s one.
    // Pre-fix this frees the FX bus mid-buffer; post-fix it does NOT.
    scheduler.tick(103); await flushMicrotasks()
    expect(bridge.calls.find(c => c.startsWith('freeNode:'))).toBeUndefined()
    expect(bridge.calls.find(c => c.startsWith('freeGroup:'))).toBeUndefined()
    expect(bridge.calls.find(c => c === 'free:16')).toBeUndefined()

    // cbHorizon=100 — well past the 7s correct horizon. FX should be freed now.
    scheduler.tick(200); await flushMicrotasks()
    expect(bridge.calls).toContain('freeGroup:5000')
    expect(bridge.calls).toContain('free:16')
  })

  it('inner with_fx creates a FRESH node every iteration — no cross-iteration reuse (#452)', async () => {
    // Pre-#452 an inner with_fx node was REUSED across loop iterations when its
    // kill timer hadn't fired yet (issue #70 anti-stacking). For a long-release
    // inner synth (release ≥ loop period) the kill never fired, so the node was
    // created ONCE and the remaining iterations skipped creation — diverging
    // from desktop SP (which instantiates a fresh FX synth every pass) and
    // dropping the per-iteration LFO reset for wobble/slicer. dark_neon: web
    // fx_wobble 1× vs desktop 5×; long-release reverb diverged identically, so
    // it is lifetime- not FX-name-specific.
    //
    // Post-#452: every iteration creates a new node (unique nodeId-suffixed key),
    // overlapping nodes freed by their own kill timers (desktop parity). Asserted
    // by counting createFxGroup calls across two iterations of the SAME with_fx
    // at a loop period (1 beat) SHORTER than the inner release (4 beats) — the
    // exact condition that made the old code reuse.
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const bridge = createMockBridge()
    // ONE shared ctx so reusableFx persists across iterations (as in the engine).
    const ctx = makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge)

    const program = new ProgramBuilder(0)
      .with_fx('wobble', (b) => b.play(60, { release: 4 }))
      .sleep(1)
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, ctx)
    })

    // Drive ≥2 iterations (loop period 1 beat). The old code would reuse on
    // iteration 2 (kill timer at vt+5 not yet fired) → exactly one createGroup.
    scheduler.tick(100); await flushMicrotasks()
    scheduler.tick(100); await flushMicrotasks()
    scheduler.tick(100); await flushMicrotasks()

    const creates = bridge.calls.filter(c => c.startsWith('createGroup:'))
    expect(creates.length).toBeGreaterThanOrEqual(2)
    // Each instance is a DISTINCT node (no shared reuse) — group ids differ.
    expect(new Set(creates).size).toBe(creates.length)
  })

  it('nested FX chains buses correctly', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const bridge = createMockBridge()

    // Build: with_fx(:reverb) { with_fx(:echo) { play 60; sleep 999999 } }
    const program = new ProgramBuilder(0)
      .with_fx('reverb', (b) =>
        b.with_fx('echo', (b2) => b2.play(60).sleep(999999))
      )
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge))
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // Outer FX: bus 16 -> bus 0
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    // Inner FX: bus 17 -> bus 16
    expect(bridge.calls).toContain('fx:echo:in17:out16')
  })

  it('works without FX bridge (graceful fallback)', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const soundEvents: import('../SoundEventStream').SoundEvent[] = []
    eventStream.on((e) => soundEvents.push(e))
    const nodeRefMap = new Map<number, number>()

    // No bridge — FX block should still execute inner steps
    const program = new ProgramBuilder(0)
      .with_fx('reverb', (b) => b.play(60).sleep(999999))
      .build()

    scheduler.registerLoop('test', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, null))
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // Play still works, just no FX routing
    const play = soundEvents.find(e => e.midiNote === 60)
    expect(play).toBeDefined()
  })

  it('transpiled Ruby with_fx produces correct program', () => {
    // In the new model, the transpiler outputs ProgramBuilder chains.
    // Verify the builder produces the expected step structure for an FX block.
    const program = new ProgramBuilder(0)
      .with_fx('reverb', { room: 0.9 }, (b) =>
        b.play(60).sleep(0.5)
      )
      .sleep(999999)
      .build()

    // First step should be fx
    expect(program[0]).toMatchObject({
      tag: 'fx',
      name: 'reverb',
      opts: { room: 0.9 },
    })

    // FX body should contain play + sleep
    const fxStep = program[0] as { tag: 'fx'; body: import('../Program').Step[] }
    expect(fxStep.body).toHaveLength(2)
    expect(fxStep.body[0]).toMatchObject({ tag: 'play', note: 60 })
    expect(fxStep.body[1]).toMatchObject({ tag: 'sleep', beats: 0.5 })

    // Outer sleep after fx block
    expect(program[1]).toMatchObject({ tag: 'sleep', beats: 999999 })
  })

  // #537 — `with_fx reps: N` re-runs the BLOCK N times, re-executing the body
  // each pass (fresh random draws). The body is unrolled at BUILD time so the
  // draws advance per rep; replaying a pre-built body froze the first rep's draw
  // and desynced PRNG pieces (lorezzed). `reps` is stripped from the step opts so
  // the interpreter runs the (already N-long) body exactly once.
  describe('#537: with_fx reps unrolls the body with fresh draws per rep', () => {
    it('reps: 4 produces 4 play steps with 4 DISTINCT rrand amps', () => {
      const program = new ProgramBuilder(0)
        .with_fx('krush', { reps: 4, amp: 3 }, (b) => b.play(60, { amp: b.rrand(0, 1) }))
        .build()
      const fxStep = program[0] as { tag: 'fx'; body: import('../Program').Step[]; opts: Record<string, unknown> }
      const amps = fxStep.body
        .filter((s) => s.tag === 'play')
        .map((s) => (s as { opts: Record<string, number> }).opts.amp)
      expect(amps).toHaveLength(4)
      expect(new Set(amps).size).toBe(4) // every rep drew a fresh value
      // reps is consumed at build time — must NOT linger in the step opts (else
      // the interpreter would loop the already-unrolled body N×N).
      expect(fxStep.opts.reps).toBeUndefined()
    })

    it('reps draws advance the SHARED stream — a draw after the block continues it', () => {
      // Two builders: one with reps:3, one with three plain plays. The post-block
      // draw must read the same stream position in both (reps consumes 3 draws).
      const withReps = new ProgramBuilder(0)
        .with_fx('krush', { reps: 3 }, (b) => b.play(60, { amp: b.rrand(0, 1) }))
      const afterReps = withReps.rrand(0, 1)
      const plain = new ProgramBuilder(0)
      for (let i = 0; i < 3; i++) plain.rrand(0, 1)
      const afterPlain = plain.rrand(0, 1)
      expect(afterReps).toBe(afterPlain)
    })

    it('no reps (or reps: 1) keeps a single body pass (regression)', () => {
      const program = new ProgramBuilder(0)
        .with_fx('reverb', { room: 0.5 }, (b) => b.play(60, { amp: b.rrand(0, 1) }))
        .build()
      const fxStep = program[0] as { tag: 'fx'; body: import('../Program').Step[] }
      expect(fxStep.body.filter((s) => s.tag === 'play')).toHaveLength(1)
    })
  })
})
