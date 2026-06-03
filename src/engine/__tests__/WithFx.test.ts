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

  // #452 DIAGNOSIS — per-iteration inner with_fx reuse is governed by the
  // kill horizon (killAt = max(vt_exit, aliveUntil) + kill_delay), NOT by the
  // FX type. dark_neon's `with_fx :wobble { synth :blade, release: 4 }` inside a
  // `sleep 4` loop reuses ONE node (release 4 + kill_delay 1 = aliveUntil 5 >
  // next-iter vt 4), so /s_new fx_wobble fires once — while sibling reverb/
  // bitcrusher wrapping a SHORT sample recreate each pass. These two tests prove
  // the divergence is duration-driven (the reuse horizon overrunning the loop
  // period), which is the intended SV41/SV52 anti-stacking behaviour — NOT a
  // wobble-specific or top-level-persistence bug as #452 originally hypothesised.
  describe('#452 per-iteration FX reuse is duration-driven (diagnosis)', () => {
    // Drive N loop iterations of `with_fx(:wobble){ play release: R }; sleep 4`
    // through ONE shared reusableFx map and count how many times the FX node is
    // created (`fx:wobble` calls). The reuse-vs-recreate decision is governed by
    // the kill horizon — killAt = max(vt_exit, aliveUntil) + kill_delay — versus
    // the next iteration's start vt, NOT by the FX type.
    //
    // Faithful timing matters: the SV41 cancel-before-kill (a resumed iteration
    // cancels its kill within the same tick's microtasks) only holds under a
    // realistic schedAhead + fine CONTINUOUS ticking (the engine's rAF loop).
    // A coarse `tick(+4)` jump with a huge schedAhead does NOT reproduce it.
    async function countWobbleCreates(release: number, until = 18): Promise<number> {
      const schedAhead = 0.5
      let audio = 0
      const scheduler = new VirtualTimeScheduler({
        getAudioTime: () => audio,
        schedAheadTime: schedAhead,
      })
      const eventStream = new SoundEventStream()
      const nodeRefMap = new Map<number, number>()
      const bridge = createMockBridge()
      // ONE shared ctx → ONE reusableFx map across iterations (mirrors
      // SonicPiEngine passing this.reusableFx to every runProgram call).
      const ctx = makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap, bridge)

      const body = new ProgramBuilder(0)
        .with_fx('wobble', { phase: 1 }, (b) =>
          b.play(60, { attack: 0, decay: 0, sustain: 0, release })
        )
        .sleep(4) // bpm 60 → 4 beats = 4 seconds
        .build()

      scheduler.registerLoop('test', async () => {
        await runProgram(body, ctx)
      })

      // Advance virtual time 0 → `until` in fine steps, flushing microtasks each
      // step so a resumed iteration drains its reuse-check before the kill fires.
      for (let t = 0; t <= until; t += 0.1) {
        audio = t
        scheduler.tick(t + schedAhead)
        await flushMicrotasks(2)
      }
      return bridge.calls.filter((c) => c.startsWith('fx:wobble')).length
    }

    it('long inner release (4) over a sleep-4 loop → FX node REUSED once (count 1)', async () => {
      const n = await countWobbleCreates(4)
      // aliveUntil = 0+0+0+4 = 4; killAt = max(vt_exit,4)+1 = 5 > next iter (4)
      // → kill cancelled each pass → ONE create. This is the web behaviour #452
      // flags as a divergence (desktop creates one fresh node per pass = 5).
      expect(n).toBe(1)
    })

    it('short inner release (0.2) over a sleep-4 loop → FX node RECREATED each pass (≈5)', async () => {
      const n = await countWobbleCreates(0.2)
      // aliveUntil = 0.2; killAt = 1.2 < next iter (4) → kill fires → recreate.
      // Same FX (wobble), same loop, ONLY the inner duration changed — proving
      // the divergence is the reuse horizon, not the effect type. ~5 over 18s.
      expect(n).toBeGreaterThan(1)
      expect(n).toBe(5)
    })
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
})
