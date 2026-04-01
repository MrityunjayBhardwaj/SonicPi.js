import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { ProgramBuilder } from '../ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

function makeAudioCtx(
  scheduler: VirtualTimeScheduler,
  taskId: string,
  eventStream: SoundEventStream,
  nodeRefMap: Map<number, number>,
): AudioCtx {
  return {
    bridge: null,
    scheduler,
    taskId,
    eventStream,
    schedAheadTime: 100,
    nodeRefMap,
    reusableFx: new Map(),
  }
}

describe('Hot-swap (SV6)', () => {
  it('hotSwap replaces loop function for next iteration', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const events: string[] = []

    scheduler.registerLoop('test', async () => {
      events.push('old')
      await scheduler.scheduleSleep('test', 1)
    })

    // Run first iteration
    scheduler.tick(100)
    await flushMicrotasks()
    expect(events).toContain('old')

    // Hot-swap
    scheduler.hotSwap('test', async () => {
      events.push('new')
      await scheduler.scheduleSleep('test', 1)
    })

    // Run second iteration — should use new function
    scheduler.tick(100)
    await flushMicrotasks()
    expect(events).toContain('new')
  })

  it('hotSwap preserves virtual time (SV6)', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })

    scheduler.registerLoop('test', async () => {
      await scheduler.scheduleSleep('test', 1) // VT goes to 1
    })

    scheduler.tick(100)
    await flushMicrotasks()

    const vtBefore = scheduler.getTask('test')!.virtualTime

    scheduler.hotSwap('test', async () => {
      await scheduler.scheduleSleep('test', 1)
    })

    // VT should not have changed
    expect(scheduler.getTask('test')!.virtualTime).toBe(vtBefore)
  })

  it('reEvaluate hot-swaps existing, starts new, stops removed', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const events: string[] = []

    // Initial evaluation: loop A and B
    const progA_old = new ProgramBuilder(0).sleep(1).build()
    const progB = new ProgramBuilder(0).sleep(1).build()

    scheduler.registerLoop('A', async () => {
      events.push('A-old')
      await runProgram(progA_old, makeAudioCtx(scheduler, 'A', eventStream, nodeRefMap))
    })
    scheduler.registerLoop('B', async () => {
      events.push('B')
      await runProgram(progB, makeAudioCtx(scheduler, 'B', eventStream, nodeRefMap))
    })

    scheduler.tick(100)
    await flushMicrotasks()
    expect(events).toContain('A-old')
    expect(events).toContain('B')

    // Re-evaluate: keep A (new code), add C, remove B
    const progA_new = new ProgramBuilder(0).sleep(1).build()
    const progC = new ProgramBuilder(0).sleep(1).build()

    const newLoops = new Map<string, () => Promise<void>>()
    newLoops.set('A', async () => {
      events.push('A-new')
      await runProgram(progA_new, makeAudioCtx(scheduler, 'A', eventStream, nodeRefMap))
    })
    newLoops.set('C', async () => {
      events.push('C')
      await runProgram(progC, makeAudioCtx(scheduler, 'C', eventStream, nodeRefMap))
    })

    scheduler.reEvaluate(newLoops)

    scheduler.tick(100)
    await flushMicrotasks()

    // A should use new code
    expect(events).toContain('A-new')
    // C should have started
    expect(events).toContain('C')
    // B should have stopped
    expect(scheduler.getTask('B')!.running).toBe(false)
  })

  it('hotSwap returns false for non-existent loop', () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })

    expect(scheduler.hotSwap('nonexistent', async () => {})).toBe(false)
  })

  it('random produces different values on different iterations', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()
    const randoms: number[] = []

    // Each iteration builds a new program with a different seed,
    // so random values should differ between iterations.
    let iteration = 0
    scheduler.registerLoop('test', async () => {
      const builder = new ProgramBuilder(iteration)
      const val = builder.rrand(0, 100)
      randoms.push(val)
      builder.sleep(1)
      const program = builder.build()
      iteration++
      await runProgram(program, makeAudioCtx(scheduler, 'test', eventStream, nodeRefMap))
    })

    // Run first iteration
    scheduler.tick(100)
    await flushMicrotasks()

    const r1 = randoms[0]

    // Run second iteration
    scheduler.tick(100)
    await flushMicrotasks()

    const r2 = randoms[1]

    // Both should be valid random values
    expect(typeof r1).toBe('number')
    expect(r1).toBeGreaterThanOrEqual(0)
    expect(r1).toBeLessThanOrEqual(100)
    expect(typeof r2).toBe('number')
    expect(r2).toBeGreaterThanOrEqual(0)
    expect(r2).toBeLessThanOrEqual(100)

    // Different seeds produce different values
    expect(r1).not.toBe(r2)
  })
})
