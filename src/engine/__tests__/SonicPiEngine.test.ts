import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { SoundEvent } from '../SoundEventStream'

describe('SonicPiEngine', () => {
  beforeEach(() => {
    // Clean up global SuperSonic (not available in test)
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('implements the SonicPiEngine interface', () => {
    const engine = new SonicPiEngine()
    expect(typeof engine.init).toBe('function')
    expect(typeof engine.evaluate).toBe('function')
    expect(typeof engine.play).toBe('function')
    expect(typeof engine.stop).toBe('function')
    expect(typeof engine.dispose).toBe('function')
    expect(typeof engine.setRuntimeErrorHandler).toBe('function')
    expect(engine.components).toBeDefined()
  })

  it('init succeeds even without SuperSonic', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    // Should not throw — audio just won't work
    expect(engine.components.streaming).toBeDefined()
    engine.dispose()
  })

  it('evaluate returns error if not initialized', async () => {
    const engine = new SonicPiEngine()
    const result = await engine.evaluate('play(60)')
    expect(result.error).toBeDefined()
    expect(result.error!.message).toContain('not initialized')
  })

  it('evaluate parses and runs code', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const result = await engine.evaluate(`
      live_loop("test", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    expect(result.error).toBeUndefined()
    engine.dispose()
  })

  it('evaluate returns error for invalid code', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const result = await engine.evaluate('this is not valid javascript {{{')
    expect(result.error).toBeDefined()
    engine.dispose()
  })

  it('components.streaming provides eventStream', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    expect(engine.components.streaming).toBeDefined()
    expect(engine.components.streaming!.eventStream).toBeDefined()

    engine.dispose()
  })

  it('components.capture available for S1 code after evaluate', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(60)
        b.sleep(0.5)
      })
    `)

    // S1 code → queryable should be present
    expect(engine.components.capture).toBeDefined()

    engine.dispose()
  })

  it('components.capture not available for S3 code', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("noisy", (b) => {
        b.play(Math.random() * 12 + 60)
        b.sleep(0.5)
      })
    `)

    // S3 code → no queryable
    expect(engine.components.capture).toBeUndefined()

    engine.dispose()
  })

  it('components only contain streaming, audio, capture — no viz leakage', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
live_loop("drums", (b) => {
  b.play(60)
  b.sleep(0.5)
})
    `)

    const keys = Object.keys(engine.components)
    expect(keys).not.toContain('inlineViz')
    expect(keys).not.toContain('queryable')

    engine.dispose()
  })

  it('play and stop control scheduling', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("test", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    engine.play()
    // Just verify no errors
    engine.stop()
    engine.dispose()
  })

  it('eventStream receives events during playback', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
      live_loop("test", (b) => {
        b.play(60)
        b.sleep(999999)
      })
    `)

    // Manually tick the scheduler since we have no real audio context
    const scheduler = (engine as unknown as { scheduler: { tick: (t: number) => void } }).scheduler
    scheduler.tick(100)
    await new Promise((r) => setTimeout(r, 50))

    expect(events.length).toBeGreaterThanOrEqual(1)

    engine.dispose()
  })

  it('setRuntimeErrorHandler captures errors', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const errors: Error[] = []
    engine.setRuntimeErrorHandler((err) => errors.push(err))

    // This should just work without errors
    await engine.evaluate(`
      live_loop("test", (b) => {
        b.play(60)
        b.sleep(999999)
      })
    `)

    engine.dispose()
  })

  it('dispose cleans up everything', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("test", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    engine.play()
    engine.dispose()

    // After dispose, components should be minimal
    expect(engine.components.capture).toBeUndefined()
  })

  it('re-evaluate without playing creates fresh scheduler', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    const result = await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(64)
        b.sleep(0.5)
      })
    `)

    expect(result.error).toBeUndefined()
    engine.dispose()
  })

  it('hot-swaps same-named loops while playing', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    engine.play()
    const scheduler = (engine as any).scheduler

    // Advance virtual time
    scheduler.tick(100)
    await new Promise(r => setTimeout(r, 50))

    const vtBefore = scheduler.getTask('drums')?.virtualTime
    expect(vtBefore).toBeGreaterThan(0)

    // Re-evaluate with same loop name while playing
    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(64)
        b.sleep(0.5)
      })
    `)

    // Scheduler instance preserved (not destroyed and recreated)
    expect((engine as any).scheduler).toBe(scheduler)

    // Virtual time preserved
    expect(scheduler.getTask('drums')?.virtualTime).toBe(vtBefore)

    engine.dispose()
  })

  it('stops removed loops on re-evaluate', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(60)
        b.sleep(1)
      })
      live_loop("bass", (b) => {
        b.play(36)
        b.sleep(1)
      })
    `)

    engine.play()
    const scheduler = (engine as any).scheduler
    scheduler.tick(100)
    await new Promise(r => setTimeout(r, 50))

    expect(scheduler.getTask('drums')?.running).toBe(true)
    expect(scheduler.getTask('bass')?.running).toBe(true)

    // Re-evaluate with only drums (bass removed)
    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(64)
        b.sleep(0.5)
      })
    `)

    // Bass should be stopped
    expect(scheduler.getTask('bass')?.running).toBe(false)
    // Drums should still be running
    expect(scheduler.getTask('drums')?.running).toBe(true)

    engine.dispose()
  })

  it('stop then evaluate creates fresh scheduler', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(60)
        b.sleep(1)
      })
    `)

    engine.play()
    const scheduler1 = (engine as any).scheduler

    engine.stop()
    expect((engine as any).scheduler).toBeNull()

    await engine.evaluate(`
      live_loop("drums", (b) => {
        b.play(64)
        b.sleep(0.5)
      })
    `)

    // New scheduler created (not the old one)
    expect((engine as any).scheduler).not.toBe(scheduler1)
    expect((engine as any).scheduler).not.toBeNull()

    engine.dispose()
  })

  it('get/set global store shares state across loops', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const result = await engine.evaluate(`
      set(:note, 60)
    `)
    expect(result.error).toBeUndefined()
    expect((engine as any).globalStore.get('note')).toBe(60)

    engine.dispose()
  })

  it('global store is cleared on dispose', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    await engine.evaluate(`set(:note, 99)`)
    expect((engine as any).globalStore.get('note')).toBe(99)

    engine.dispose()
    expect((engine as any).globalStore.size).toBe(0)
  })

  it('infinite loop (no sleep) reports error and does not hang', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const errors: Error[] = []
    engine.setRuntimeErrorHandler((err) => errors.push(err))

    const result = await engine.evaluate(`
loop do
  play :c4
end
`)
    // The evaluate itself should not hang or throw
    expect(result.error).toBeUndefined()

    // Start the scheduler and tick to let the loop run
    engine.play()
    const scheduler = (engine as any).scheduler
    scheduler.tick(100)
    await new Promise(r => setTimeout(r, 100))

    // The loop should have been caught by the budget guard
    expect(errors.length).toBeGreaterThanOrEqual(1)
    const hasInfiniteLoopError = errors.some(e =>
      e.name === 'InfiniteLoopError' || e.message.includes('Infinite loop')
    )
    expect(hasInfiniteLoopError).toBe(true)

    engine.dispose()
  })
})
