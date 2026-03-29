import { describe, it, expect } from 'vitest'
import { queryProgram, queryLoopProgram, captureAll, type ProgramFactory } from '../interpreters/QueryInterpreter'
import { ProgramBuilder } from '../ProgramBuilder'
import { ring } from '../Ring'
import type { Program } from '../Program'
import { detectStratum, Stratum } from '../Stratum'

describe('queryProgram', () => {
  it('returns play events within time range', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1)
    b.play(64)
    b.sleep(1)
    const program = b.build()

    // At 60bpm, 1 beat = 1s. Events at t=0 (note 60), t=1 (note 64)
    const events = queryProgram(program, 0, 2, 60)
    const synths = events.filter(e => e.type === 'synth')
    expect(synths).toHaveLength(2)
    expect(synths[0].params.note).toBe(60)
    expect(synths[0].time).toBe(0)
    expect(synths[1].params.note).toBe(64)
    expect(synths[1].time).toBe(1)
  })

  it('excludes events outside time range', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1)
    b.play(64)
    b.sleep(1)
    b.play(67)
    const program = b.build()

    // Only query [0.5, 1.5) — should get note 64 at t=1
    const events = queryProgram(program, 0.5, 1.5, 60)
    expect(events).toHaveLength(1)
    expect(events[0].params.note).toBe(64)
  })

  it('handles sample steps', () => {
    const b = new ProgramBuilder()
    b.sample('bd_haus')
    b.sleep(0.5)
    b.sample('sn_dub')
    const program = b.build()

    const events = queryProgram(program, 0, 1, 60)
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('sample')
    expect(events[0].params.name).toBe('bd_haus')
    expect(events[1].type).toBe('sample')
    expect(events[1].params.name).toBe('sn_dub')
  })

  it('handles sleep steps and advances time correctly', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(0.5)
    b.play(64)
    b.sleep(0.5)
    b.play(67)
    const program = b.build()

    // At 60bpm: events at t=0, t=0.5, t=1.0
    const events = queryProgram(program, 0, 2, 60)
    expect(events).toHaveLength(3)
    expect(events[0].time).toBe(0)
    expect(events[1].time).toBe(0.5)
    expect(events[2].time).toBe(1.0)
  })

  it('respects use_synth', () => {
    const b = new ProgramBuilder()
    b.play(60) // default synth (beep)
    b.use_synth('prophet')
    b.sleep(0.5)
    b.play(64) // prophet
    const program = b.build()

    const events = queryProgram(program, 0, 1, 60)
    expect(events[0].params.synth).toBe('beep')
    expect(events[1].params.synth).toBe('prophet')
  })

  it('respects use_bpm', () => {
    const b = new ProgramBuilder()
    b.use_bpm(120) // 1 beat = 0.5s
    b.play(60)
    b.sleep(1) // 0.5s at 120bpm
    b.play(64)
    const program = b.build()

    const events = queryProgram(program, 0, 1, 60) // initial bpm ignored, useBpm overrides
    expect(events).toHaveLength(2)
    expect(events[0].time).toBe(0)
    expect(events[1].time).toBe(0.5) // 1 beat at 120bpm = 0.5s
  })

  it('stops at stop step', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.stop()
    b.play(64) // should not appear
    const program = b.build()

    const events = queryProgram(program, 0, 10, 60)
    expect(events).toHaveLength(1)
    expect(events[0].params.note).toBe(60)
  })

  it('returns empty for empty program', () => {
    const events = queryProgram([], 0, 10, 60)
    expect(events).toEqual([])
  })

  it('handles startTime offset', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1)
    b.play(64)
    const program = b.build()

    // Start at t=5, query [5, 7)
    const events = queryProgram(program, 5, 7, 60, 5)
    expect(events).toHaveLength(2)
    expect(events[0].time).toBe(5)
    expect(events[1].time).toBe(6)
  })
})

describe('queryProgram — fx sub-programs', () => {
  it('queries events inside fx blocks', () => {
    const b = new ProgramBuilder()
    b.with_fx('reverb', { room: 0.8 }, (inner) => {
      inner.play(60)
      inner.sleep(0.5)
      inner.play(64)
      return inner
    })
    const program = b.build()

    const events = queryProgram(program, 0, 2, 60)
    expect(events).toHaveLength(2)
    expect(events[0].params.note).toBe(60)
    expect(events[1].params.note).toBe(64)
  })

  it('fx sub-program advances parent time', () => {
    const b = new ProgramBuilder()
    b.play(48) // t=0
    b.with_fx('reverb', (inner) => {
      inner.play(60)
      inner.sleep(1) // 1s at 60bpm
      inner.play(64)
      return inner
    })
    b.play(72) // should be at t=1 (after fx block)
    const program = b.build()

    const events = queryProgram(program, 0, 2, 60)
    const notes = events.map(e => e.params.note)
    expect(notes).toEqual([48, 60, 64, 72])
    // note 72 should be at t=1.0 (after the fx body's sleep)
    expect(events[3].time).toBe(1.0)
  })

  it('nested fx durations are counted recursively', () => {
    const b = new ProgramBuilder()
    b.play(48) // t=0
    b.with_fx('reverb', (outer) => {
      outer.with_fx('delay', (inner) => {
        inner.play(60)
        inner.sleep(0.5)
        return inner
      })
      outer.sleep(0.5) // total fx = 1.0s
      return outer
    })
    b.play(72) // should be at t=1.0
    const program = b.build()

    const events = queryProgram(program, 0, 2, 60)
    const note72 = events.find(e => e.params.note === 72)
    expect(note72).toBeDefined()
    expect(note72!.time).toBe(1.0)
  })

  it('bpm change inside fx affects duration calculation', () => {
    const b = new ProgramBuilder()
    b.play(48) // t=0
    b.with_fx('reverb', (inner) => {
      inner.use_bpm(120) // 1 beat = 0.5s
      inner.play(60)
      inner.sleep(1) // 0.5s at 120bpm
      return inner
    })
    b.play(72) // should be at t=0.5
    const program = b.build()

    const events = queryProgram(program, 0, 2, 60)
    const note72 = events.find(e => e.params.note === 72)
    expect(note72).toBeDefined()
    expect(note72!.time).toBe(0.5)
  })
})

describe('queryLoopProgram', () => {
  it('tiles program across time range', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1) // 1s at 60bpm
    const program = b.build()

    // Query [0, 3) — should get 3 iterations: t=0, t=1, t=2
    const events = queryLoopProgram(program, 0, 3, 60)
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events[0].time).toBe(0)
    expect(events[1].time).toBe(1)
    expect(events[2].time).toBe(2)
  })

  it('returns empty for program with no sleep', () => {
    const b = new ProgramBuilder()
    b.play(60)
    const program = b.build()

    // No sleep means iteration duration = 0, can't tile
    const events = queryLoopProgram(program, 0, 10, 60)
    expect(events).toEqual([])
  })

  it('handles partial iteration ranges', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(0.5)
    b.play(64)
    b.sleep(0.5)
    const program = b.build()

    // Iteration = 1s. Query [0.3, 0.7) — should get note 64 at t=0.5
    const events = queryLoopProgram(program, 0.3, 0.7, 60)
    expect(events).toHaveLength(1)
    expect(events[0].params.note).toBe(64)
  })

  it('events are sorted by time', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(0.25)
    const program = b.build()

    const events = queryLoopProgram(program, 0, 2, 60)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time)
    }
  })
})

describe('queryLoopProgram — ProgramFactory (tick advancement)', () => {
  it('advances tick state across iterations via factory', () => {
    // ring(:e2, :g2, :a2).tick should cycle 40→43→45→40→43→45
    const factory: ProgramFactory = (ticks, iteration) => {
      const b = new ProgramBuilder(iteration ?? 0, ticks)
      const notes = ring(40, 43, 45)
      b.play(notes.at(b.tick()))
      b.sleep(1)
      return { program: b.build(), ticks: b.getTicks() }
    }

    // 6 beats at 60bpm → 6 iterations
    const events = queryLoopProgram(factory, 0, 6, 60)
    const notes = events.map(e => e.params.note)
    expect(notes).toEqual([40, 43, 45, 40, 43, 45, 40])
  })

  it('static Program still works (backward compat)', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1)
    const program = b.build()

    const events = queryLoopProgram(program, 0, 3, 60)
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every(e => e.params.note === 60)).toBe(true)
  })

  it('factory with single-element ring repeats same note', () => {
    const factory: ProgramFactory = (ticks, iteration) => {
      const b = new ProgramBuilder(iteration ?? 0, ticks)
      const notes = ring(60)
      b.play(notes.at(b.tick()))
      b.sleep(1)
      return { program: b.build(), ticks: b.getTicks() }
    }

    const events = queryLoopProgram(factory, 0, 4, 60)
    expect(events.every(e => e.params.note === 60)).toBe(true)
  })

  it('seeded random produces different values across iterations', () => {
    const factory: ProgramFactory = (ticks, iteration) => {
      const b = new ProgramBuilder(iteration ?? 0, ticks)
      b.play(b.rrand_i(60, 72))
      b.sleep(1)
      return { program: b.build(), ticks: b.getTicks() }
    }

    const events = queryLoopProgram(factory, 0, 4, 60)
    const notes = events.map(e => e.params.note)
    // With different seeds per iteration, not all notes should be identical
    const unique = new Set(notes)
    expect(unique.size).toBeGreaterThan(1)
  })
})

describe('captureAll', () => {
  it('captures all events up to duration', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(0.5)
    b.play(64)
    b.sleep(0.5)
    const program = b.build()

    // At 60bpm: iteration = 1s. 2s duration, events at t=0,0.5,1.0,1.5,2.0
    // queryLoopProgram tiles with ceil, so boundary iteration is included
    const events = captureAll(program, 2, 60)
    const synths = events.filter(e => e.type === 'synth')
    expect(synths.length).toBeGreaterThanOrEqual(4)
    expect(synths[0].params.note).toBe(60)
    expect(synths[1].params.note).toBe(64)
    expect(synths[2].params.note).toBe(60)
    expect(synths[3].params.note).toBe(64)
  })

  it('is deterministic — same input, same output', () => {
    const build = () => {
      const b = new ProgramBuilder(42)
      b.play(b.rrand_i(60, 72))
      b.sleep(0.5)
      return b.build()
    }

    const events1 = captureAll(build(), 2, 60)
    const events2 = captureAll(build(), 2, 60)

    expect(events1.map(e => `${e.type}:${e.time}:${JSON.stringify(e.params)}`))
      .toEqual(events2.map(e => `${e.type}:${e.time}:${JSON.stringify(e.params)}`))
  })

  it('captures sample events', () => {
    const b = new ProgramBuilder()
    b.sample('bd_haus')
    b.sleep(0.5)
    b.sample('sn_dub')
    b.sleep(0.5)
    const program = b.build()

    const events = captureAll(program, 1, 60)
    const samples = events.filter(e => e.type === 'sample')
    expect(samples.length).toBeGreaterThanOrEqual(2)
    expect(samples[0].params.name).toBe('bd_haus')
    expect(samples[1].params.name).toBe('sn_dub')
  })
})

describe('detectStratum', () => {
  it('S1: pure deterministic code', () => {
    const code = `
      live_loop("drums", async (ctx) => {
        await ctx.play(60)
        await ctx.sleep(0.5)
        await ctx.play(64)
        await ctx.sleep(0.5)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S1)
  })

  it('S2: seeded random', () => {
    const code = `
      live_loop("melody", async (ctx) => {
        ctx.use_random_seed(42)
        await ctx.play(ctx.choose([60, 64, 67]))
        await ctx.sleep(0.5)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S2)
  })

  it('S2: rrand usage', () => {
    const code = `
      live_loop("melody", async (ctx) => {
        await ctx.play(ctx.rrand(60, 72))
        await ctx.sleep(0.5)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S2)
  })

  it('S3: sync/cue', () => {
    const code = `
      live_loop("metro", async (ctx) => {
        ctx.cue("tick")
        await ctx.sleep(1)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S3)
  })

  it('S3: Math.random', () => {
    const code = `
      live_loop("noisy", async (ctx) => {
        await ctx.play(Math.random() * 12 + 60)
        await ctx.sleep(0.5)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S3)
  })

  it('S3: external state mutation', () => {
    const code = `
      let counter = 0
      live_loop("count", async (ctx) => {
        counter += 1
        await ctx.play(counter % 12 + 60)
        await ctx.sleep(0.25)
      })
    `
    expect(detectStratum(code)).toBe(Stratum.S3)
  })
})
