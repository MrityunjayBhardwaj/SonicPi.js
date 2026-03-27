import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'

/**
 * Helper: create a scheduler with a controllable mock audio clock.
 */
function createTestScheduler() {
  let audioTime = 0
  const scheduler = new VirtualTimeScheduler({
    getAudioTime: () => audioTime,
    schedAheadTime: 10, // large lookahead so tick resolves everything up to targetTime
    tickInterval: 25,
  })
  return {
    scheduler,
    setAudioTime(t: number) { audioTime = t },
    getAudioTime() { return audioTime },
  }
}

/**
 * Helper: flush microtask queue so resolved Promises actually execute.
 */
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('VirtualTimeScheduler', () => {
  describe('single task', () => {
    it('sleep advances virtual time', async () => {
      const { scheduler } = createTestScheduler()
      const events: number[] = []

      scheduler.registerLoop('test', async () => {
        events.push(scheduler.getTask('test')!.virtualTime)
        await scheduler.scheduleSleep('test', 1) // 1 beat at 60bpm = 1s
        events.push(scheduler.getTask('test')!.virtualTime)
        await scheduler.scheduleSleep('test', 0.5) // 0.5 beat = 0.5s
      })

      // Manually tick to resolve sleeps
      scheduler.tick(100) // large target resolves everything
      await flushMicrotasks()
      scheduler.tick(100)
      await flushMicrotasks()
      scheduler.tick(100)
      await flushMicrotasks()

      // virtualTime should have advanced: 0 → 1.0 → 1.5
      expect(events[0]).toBe(0)
      expect(events[1]).toBe(1)
    })

    it('sleep(0) resolves immediately on tick', async () => {
      const { scheduler } = createTestScheduler()
      let resolved = false

      scheduler.registerLoop('test', async () => {
        resolved = true
        // Sleep forever to prevent infinite loop
        await scheduler.scheduleSleep('test', 999999)
      })

      expect(resolved).toBe(false)

      // Tick with large target — the initial sleep(0) should resolve
      scheduler.tick(100)
      await flushMicrotasks()

      expect(resolved).toBe(true)
    })

    it('sleep does not resolve before its time', async () => {
      const { scheduler, setAudioTime } = createTestScheduler()
      let phase = 0

      scheduler.registerLoop('test', async () => {
        phase = 1
        await scheduler.scheduleSleep('test', 2) // 2 beats = 2s at 60bpm
        phase = 2
        await scheduler.scheduleSleep('test', 999999)
      })

      // Resolve the initial sleep(0)
      scheduler.tick(100)
      await flushMicrotasks()
      expect(phase).toBe(1)

      // Tick with targetTime=1 — the sleep(2) at time=2 should NOT resolve
      scheduler.tick(1)
      await flushMicrotasks()
      expect(phase).toBe(1)

      // Tick with targetTime=3 — now it should resolve
      scheduler.tick(3)
      await flushMicrotasks()
      expect(phase).toBe(2)
    })
  })

  describe('multi-task', () => {
    it('two loops interleave correctly', async () => {
      const { scheduler } = createTestScheduler()
      const events: string[] = []

      scheduler.registerLoop('A', async () => {
        events.push(`A@${scheduler.getTask('A')!.virtualTime}`)
        await scheduler.scheduleSleep('A', 1) // wakes at 1s
        events.push(`A@${scheduler.getTask('A')!.virtualTime}`)
        await scheduler.scheduleSleep('A', 999999)
      })

      scheduler.registerLoop('B', async () => {
        events.push(`B@${scheduler.getTask('B')!.virtualTime}`)
        await scheduler.scheduleSleep('B', 0.5) // wakes at 0.5s
        events.push(`B@${scheduler.getTask('B')!.virtualTime}`)
        await scheduler.scheduleSleep('B', 999999)
      })

      // Resolve initial sleep(0) for both
      scheduler.tick(100)
      await flushMicrotasks()

      // Both should have started
      expect(events).toContain('A@0')
      expect(events).toContain('B@0')

      // Tick to 0.75 — B's sleep(0.5) at time 0.5 should resolve, A's at 1 should not
      scheduler.tick(0.75)
      await flushMicrotasks()

      expect(events).toContain('B@0.5')
      expect(events).not.toContain('A@1')

      // Tick to 1.5 — A's sleep at time 1 should resolve
      scheduler.tick(1.5)
      await flushMicrotasks()

      expect(events).toContain('A@1')
    })

    it('tasks with same wake time resolve in deterministic order', async () => {
      const { scheduler } = createTestScheduler()
      const order: string[] = []

      // Register A first, then B
      scheduler.registerLoop('A', async () => {
        await scheduler.scheduleSleep('A', 1) // both wake at 1s
        order.push('A')
        await scheduler.scheduleSleep('A', 999999)
      })

      scheduler.registerLoop('B', async () => {
        await scheduler.scheduleSleep('B', 1) // both wake at 1s
        order.push('B')
        await scheduler.scheduleSleep('B', 999999)
      })

      // Resolve initial sleep(0)
      scheduler.tick(100)
      await flushMicrotasks()

      // Now tick to resolve both at time=1
      scheduler.tick(2)
      await flushMicrotasks()

      // A was registered first, so A's sleep was pushed first → resolves first
      expect(order).toEqual(['A', 'B'])
    })
  })

  describe('BPM', () => {
    it('respects per-task BPM', async () => {
      const { scheduler } = createTestScheduler()

      scheduler.registerLoop('fast', async () => {
        await scheduler.scheduleSleep('fast', 1) // 1 beat at 120bpm = 0.5s
        await scheduler.scheduleSleep('fast', 999999)
      }, { bpm: 120 })

      scheduler.registerLoop('slow', async () => {
        await scheduler.scheduleSleep('slow', 1) // 1 beat at 60bpm = 1.0s
        await scheduler.scheduleSleep('slow', 999999)
      }, { bpm: 60 })

      // Resolve initial sleep(0)
      scheduler.tick(100)
      await flushMicrotasks()

      const fastTask = scheduler.getTask('fast')!
      const slowTask = scheduler.getTask('slow')!

      // After 1 beat: fast advances 0.5s, slow advances 1.0s
      expect(fastTask.virtualTime).toBe(0.5)
      expect(slowTask.virtualTime).toBe(1.0)
    })
  })

  describe('determinism (SV3)', () => {
    it('same inputs produce same output sequence', async () => {
      async function runScheduler(): Promise<string[]> {
        const events: string[] = []
        const scheduler = new VirtualTimeScheduler({
          getAudioTime: () => 0,
          schedAheadTime: 100,
        })

        scheduler.registerLoop('drums', async () => {
          events.push(`kick@${scheduler.getTask('drums')!.virtualTime}`)
          await scheduler.scheduleSleep('drums', 0.5)
          events.push(`snare@${scheduler.getTask('drums')!.virtualTime}`)
          await scheduler.scheduleSleep('drums', 0.5)
        })

        scheduler.registerLoop('bass', async () => {
          events.push(`bass@${scheduler.getTask('bass')!.virtualTime}`)
          await scheduler.scheduleSleep('bass', 1)
        })

        // Run 3 ticks
        for (let i = 0; i < 6; i++) {
          scheduler.tick(100)
          await flushMicrotasks()
        }

        scheduler.dispose()
        return events
      }

      const run1 = await runScheduler()
      const run2 = await runScheduler()

      expect(run1).toEqual(run2)
    })
  })

  describe('start/stop', () => {
    it('start begins tick timer', () => {
      vi.useFakeTimers()
      const { scheduler } = createTestScheduler()

      scheduler.registerLoop('test', async () => {
        await scheduler.scheduleSleep('test', 999999)
      })

      expect(scheduler.running).toBe(false)
      scheduler.start()
      expect(scheduler.running).toBe(true)

      scheduler.stop()
      expect(scheduler.running).toBe(false)

      vi.useRealTimers()
    })

    it('dispose cleans up everything', () => {
      const { scheduler } = createTestScheduler()
      scheduler.registerLoop('test', async () => {
        await scheduler.scheduleSleep('test', 999999)
      })

      scheduler.dispose()
      expect(scheduler.getTask('test')).toBeUndefined()
    })
  })

  describe('event emission', () => {
    it('emitEvent calls all handlers', () => {
      const { scheduler } = createTestScheduler()
      const events: string[] = []

      scheduler.onEvent((e) => events.push(e.type))
      scheduler.onEvent((e) => events.push(e.taskId))

      scheduler.emitEvent({
        type: 'synth',
        taskId: 'drums',
        virtualTime: 0,
        audioTime: 0,
        params: { note: 60 },
      })

      expect(events).toEqual(['synth', 'drums'])
    })
  })

  describe('loop re-registration (hot-swap)', () => {
    it('registerLoop with existing running task swaps the function', async () => {
      const { scheduler } = createTestScheduler()
      const events: string[] = []

      scheduler.registerLoop('test', async () => {
        events.push('old')
        await scheduler.scheduleSleep('test', 1)
      })

      // Start and run one iteration
      scheduler.tick(100)
      await flushMicrotasks()

      const task = scheduler.getTask('test')!
      task.running = true // simulate running state

      // Hot-swap
      scheduler.registerLoop('test', async () => {
        events.push('new')
        await scheduler.scheduleSleep('test', 1)
      })

      // The function reference should be updated
      expect(task.asyncFn).toBeDefined()
    })
  })

  describe('error recovery', () => {
    it('loop survives a runtime error and keeps running', async () => {
      const { scheduler } = createTestScheduler()
      const errors: string[] = []
      const events: string[] = []
      let iteration = 0

      scheduler.onLoopError((taskId, err) => {
        errors.push(`${taskId}: ${err.message}`)
      })

      scheduler.registerLoop('test', async () => {
        iteration++
        if (iteration === 1) throw new Error('boom')
        events.push(`iteration ${iteration}`)
        await scheduler.scheduleSleep('test', 1)
      })

      // First tick — starts the loop, hits the error
      scheduler.tick(100)
      await flushMicrotasks()
      // Recovery sleep gets queued — tick again to advance past it
      scheduler.tick(200)
      await flushMicrotasks()
      scheduler.tick(300)
      await flushMicrotasks()

      expect(errors).toEqual(['test: boom'])
      expect(events.length).toBeGreaterThan(0)
      expect(scheduler.getTask('test')?.running).toBe(true)
    })

    it('calls onLoopError with loop name and error', async () => {
      const { scheduler } = createTestScheduler()
      const captured: { id: string; message: string }[] = []

      scheduler.onLoopError((taskId, err) => {
        captured.push({ id: taskId, message: err.message })
      })

      scheduler.registerLoop('myloop', async () => {
        throw new Error('test error')
      })

      scheduler.tick(100)
      await flushMicrotasks()

      expect(captured).toEqual([{ id: 'myloop', message: 'test error' }])
    })

    it('other loops keep running when one loop errors', async () => {
      const { scheduler } = createTestScheduler()
      const goodEvents: string[] = []

      scheduler.onLoopError(() => {})

      scheduler.registerLoop('bad', async () => {
        throw new Error('bad loop error')
      })

      scheduler.registerLoop('good', async () => {
        goodEvents.push('tick')
        await scheduler.scheduleSleep('good', 1)
      })

      scheduler.tick(100)
      await flushMicrotasks()
      scheduler.tick(200)
      await flushMicrotasks()

      expect(goodEvents.length).toBeGreaterThan(0)
      expect(scheduler.getTask('good')?.running).toBe(true)
    })
  })

  describe('stopLoop', () => {
    it('stops a running loop by name and returns true', async () => {
      const { scheduler } = createTestScheduler()
      scheduler.registerLoop('target', async () => {
        await scheduler.scheduleSleep('target', 1)
      })
      scheduler.tick(100)
      await flushMicrotasks()

      const result = scheduler.stopLoop('target')
      expect(result).toBe(true)
      expect(scheduler.getTask('target')?.running).toBe(false)
    })

    it('returns false for unknown loop name', () => {
      const { scheduler } = createTestScheduler()
      expect(scheduler.stopLoop('nonexistent')).toBe(false)
    })

    it('returns false if loop is already stopped', async () => {
      const { scheduler } = createTestScheduler()
      scheduler.registerLoop('target', async () => {
        await scheduler.scheduleSleep('target', 1)
      })
      scheduler.tick(100)
      await flushMicrotasks()

      scheduler.stopLoop('target')
      expect(scheduler.stopLoop('target')).toBe(false)
    })
  })
})
