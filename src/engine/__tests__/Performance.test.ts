import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { ProgramBuilder } from '../ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'

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
    schedAheadTime: 200,
    nodeRefMap,
    reusableFx: new Map(),
  }
}

describe('Performance', () => {
  it('handles 100 concurrent live_loops with <5ms tick', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 100, // far enough ahead to resolve everything
      schedAheadTime: 200,
    })

    const eventStream = new SoundEventStream()
    let eventCount = 0
    eventStream.on(() => { eventCount++ })
    const nodeRefMap = new Map<number, number>()

    // Register 100 concurrent loops, each plays a note then sleeps
    const LOOP_COUNT = 100
    for (let i = 0; i < LOOP_COUNT; i++) {
      const taskId = `loop_${i}`
      const program = new ProgramBuilder(i)
        .play(60 + (i % 12))
        .sleep(0.25)
        .build()

      scheduler.registerLoop(taskId, async () => {
        await runProgram(program, makeAudioCtx(scheduler, taskId, eventStream, nodeRefMap))
      })
    }

    // First tick to let all loops start (they sleep(0) initially)
    scheduler.tick(0)
    // Give microtasks time to resolve
    await new Promise(r => setTimeout(r, 10))

    // Now tick to resolve the real sleeps -- measure time
    const start = performance.now()
    scheduler.tick(100)
    const elapsed = performance.now() - start

    // Should complete in <5ms
    expect(elapsed).toBeLessThan(5)

    // Wait for async loop bodies to run
    await new Promise(r => setTimeout(r, 50))

    // All 100 loops should have emitted events
    expect(eventCount).toBeGreaterThanOrEqual(LOOP_COUNT)

    scheduler.dispose()
  })

  it('MinHeap handles 10000 entries efficiently', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 1000,
    })

    // Push 10000 sleep entries
    const taskId = 'stress'
    scheduler.registerLoop(taskId, async () => {
      // Intentionally empty -- we manually push sleeps below
      await new Promise(() => {}) // park forever
    })

    // Tick to start the loop
    scheduler.tick(0)
    await new Promise(r => setTimeout(r, 5))

    // Manually push many entries via scheduleSleep
    for (let i = 0; i < 10000; i++) {
      // Override virtualTime each time to prevent accumulation
      const task = scheduler.getTask(taskId)!
      task.virtualTime = 0
      scheduler.scheduleSleep(taskId, i * 0.001)
    }

    const start = performance.now()
    scheduler.tick(1000)
    const elapsed = performance.now() - start

    // 10000 entries should resolve in <500ms (CI runners are slower than local)
    expect(elapsed).toBeLessThan(500)

    scheduler.dispose()
  })

  it('event emission throughput is adequate', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 100,
      schedAheadTime: 200,
    })

    const eventStream = new SoundEventStream()
    let eventCount = 0
    eventStream.on(() => { eventCount++ })
    const nodeRefMap = new Map<number, number>()

    // Single loop that emits many events per iteration
    const NOTES_PER_ITER = 50
    const builder = new ProgramBuilder(0)
    for (let i = 0; i < NOTES_PER_ITER; i++) {
      builder.play(60 + i)
    }
    builder.sleep(1)
    const program = builder.build()

    scheduler.registerLoop('burst', async () => {
      await runProgram(program, makeAudioCtx(scheduler, 'burst', eventStream, nodeRefMap))
    })

    // Start and run
    scheduler.tick(0)
    await new Promise(r => setTimeout(r, 10))
    scheduler.tick(100)
    await new Promise(r => setTimeout(r, 50))

    expect(eventCount).toBeGreaterThanOrEqual(NOTES_PER_ITER)

    scheduler.dispose()
  })
})
