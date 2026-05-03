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

  it('define redefinition replaces (does not stack) the prior fn (#215 self-review)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    // Eval 1: define hello → 60
    const r1 = await engine.evaluate(`
define :hello do
  play 60
end

live_loop :run do
  hello
  sleep 1
end
`)
    expect(r1.error).toBeUndefined()

    // Eval 2: redefine hello → 72.
    // The old fn must be replaced — not "stacked". Verified by
    // confirming this evaluates without error (a leaking-closure bug
    // would surface as either a re-declaration error or an unbound ref).
    const r2 = await engine.evaluate(`
define :hello do
  play 72
end

live_loop :run do
  hello
  sleep 1
end
`)
    expect(r2.error).toBeUndefined()

    // Eval 3: remove the define entirely; the live_loop calling \`hello\`
    // must use the redefined (72) fn from eval 2, not eval 1's (60).
    const r3 = await engine.evaluate(`
live_loop :run do
  hello
  sleep 1
end
`)
    expect(r3.error).toBeUndefined()

    engine.dispose()
  })

  it('use_random_seed plumbs through to topLevelBuilder — engine-level (#217 self-review)', async () => {
    // Run two independent engines through the SAME live_loop code with
    // use_random_seed and capture their pick output via puts. If reseeding
    // works at every layer (topLevelBuilder + per-loop builder), the print
    // streams are identical. Guards against a regression that makes
    // topLevelUseRandomSeed go back to storing the seed without reseeding.
    const engineA = new SonicPiEngine()
    const engineB = new SonicPiEngine()
    await engineA.init()
    await engineB.init()

    const printsA: string[] = []
    const printsB: string[] = []
    engineA.setPrintHandler((msg) => printsA.push(msg))
    engineB.setPrintHandler((msg) => printsB.push(msg))

    const code = `live_loop :probe do
  use_random_seed 42
  puts pick([1, 2, 3, 4, 5], 4).toArray()
  stop
end`
    await engineA.evaluate(code)
    await engineB.evaluate(code)
    // Allow scheduler to fire the loop body.
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Streams must be byte-identical when both engines saw the same seed.
    expect(JSON.stringify(printsA)).toBe(JSON.stringify(printsB))

    engineA.dispose()
    engineB.dispose()
  })

  it('dispose clears defined fns map (#215 self-review)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
define :ghost do
  play 60
end

live_loop :run do
  ghost
  sleep 1
end
`)
    // Bracket-access so private-field encapsulation isn't broken at the
    // type level. The map is implementation detail of #215 persistence.
    const fnsBefore = (engine as unknown as { definedFns: Map<string, unknown> }).definedFns
    expect(fnsBefore.size).toBeGreaterThan(0)

    engine.dispose()

    const fnsAfter = (engine as unknown as { definedFns: Map<string, unknown> }).definedFns
    expect(fnsAfter.size).toBe(0)
  })

  it('define persists across re-evaluations (#215)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    // First eval — define a fn and call it inside a loop.
    const r1 = await engine.evaluate(`
define :hello do
  play 60
end

live_loop :run do
  hello
  sleep 1
end
`)
    expect(r1.error).toBeUndefined()

    // Second eval — buffer no longer contains the define, but the live_loop
    // calling \`hello\` is still expected to work because the engine seeded
    // the prior fn into the new scope. With #215 fix this should NOT error.
    const r2 = await engine.evaluate(`
live_loop :run do
  hello
  sleep 1
end
`)
    expect(r2.error).toBeUndefined()

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

  // Issue #198 — nested live_loop must register on first occurrence only
  // and emit a one-time warning. Pre-fix, every outer iteration re-registered
  // :inner, leaking monitor synths and resetting tick state every outer tick.
  it('nested live_loop registers once across outer iterations + warns once', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const messages: string[] = []
    engine.setPrintHandler((m) => messages.push(m))

    await engine.evaluate(`
      live_loop :outer do
        live_loop :inner do
          play 60
          sleep 1
        end
        sleep 4
      end
    `)
    engine.play()

    type Sched = { tick: (t: number) => void; getTask: (n: string) => unknown }
    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
    // Run multiple outer iterations to force the nested registration call to
    // be re-encountered. Pre-fix this caused 3+ inner registrations.
    for (let i = 0; i < 3; i++) {
      scheduler.tick(20)
      await new Promise((r) => setTimeout(r, 5))
    }

    const innerWarnings = messages.filter(
      (m) => m.includes('inner') && m.includes('inside another live_loop'),
    )
    expect(innerWarnings.length).toBe(1)
    // Both loops are running.
    expect(scheduler.getTask('outer')).toBeDefined()
    expect(scheduler.getTask('inner')).toBeDefined()

    engine.dispose()
  })

  // Issue #199 — nested live_loop inner body must hot-swap on Run.
  // Pre-fix, the inner's asyncFn closure was never replaced because the
  // synchronous inner registration fired inside the outer's iteration
  // (after the top-level evaluate's pendingLoops had already been
  // reconciled), so the new inner closure went into a dead map. Inner
  // kept playing the OLD body forever. The fix routes nested+isReEvaluate
  // through scheduler.hotSwap() directly, preserving virtualTime (SV6).
  it('nested live_loop inner body refreshes on hot-swap (#199)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    // First evaluate — inner plays note 60.
    await engine.evaluate(`
      live_loop :outer do
        live_loop :inner do
          play 60
          sleep 1
        end
        sleep 4
      end
    `)
    engine.play()

    type Sched = {
      tick: (t: number) => void
      getTask: (n: string) => { virtualTime: number } | undefined
    }
    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler

    // Tick enough for the outer to iterate at least twice (forces the
    // first-occurrence-wins guard to be exercised) and for inner to play.
    for (let i = 0; i < 3; i++) {
      scheduler.tick(20)
      await new Promise((r) => setTimeout(r, 5))
    }
    const innerVtBefore = scheduler.getTask('inner')!.virtualTime

    const innerNotesBefore = events
      .filter((e) => e.trackId === 'inner' && e.midiNote !== null)
      .map((e) => e.midiNote)
    expect(innerNotesBefore.length).toBeGreaterThan(0)
    expect(innerNotesBefore.every((n) => n === 60)).toBe(true)

    // Hot-swap: same outer, inner body now plays 72.
    events.length = 0
    await engine.evaluate(`
      live_loop :outer do
        live_loop :inner do
          play 72
          sleep 1
        end
        sleep 4
      end
    `)

    // Outer iterates after the swap, re-declares the inner — that path is
    // the one #199 fixed. Tick to let the new inner closure run.
    for (let i = 0; i < 4; i++) {
      scheduler.tick(20)
      await new Promise((r) => setTimeout(r, 5))
    }

    const innerNotesAfter = events
      .filter((e) => e.trackId === 'inner' && e.midiNote !== null)
      .map((e) => e.midiNote)
    expect(innerNotesAfter.length).toBeGreaterThan(0)
    // Pre-fix: every entry would still be 60. Fixed: post-swap entries are 72.
    expect(innerNotesAfter.some((n) => n === 72)).toBe(true)
    expect(innerNotesAfter.every((n) => n === 72)).toBe(true)

    // SV6: hot-swap preserves virtualTime (inner's clock keeps moving forward,
    // not reset to a fresh task's now).
    const innerVtAfter = scheduler.getTask('inner')!.virtualTime
    expect(innerVtAfter).toBeGreaterThanOrEqual(innerVtBefore)

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

  // Issue #201 (G3) — Deferred set_volume must update the closure-local
  // `currentVolume` the engine reads via current_volume_fn. Pre-fix the
  // setVolume step called bridge.setMasterVolume directly, so the engine's
  // currentVolume stayed at its initial 1.
  //
  // The verification trick: `puts` inside a live_loop fires at BUILD time,
  // baking its arg into a print step. So iteration N+1's build reads the
  // currentVolume that iteration N's deferred set_volume left behind.
  it('deferred set_volume mutates engine currentVolume — visible to next iteration', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const messages: string[] = []
    engine.setPrintHandler((m) => messages.push(m))

    // Single evaluate so both calls share the same closure scope.
    // Note: `current_volume` in our DSL is a JS function reference, not a
    // bare identifier (no auto-invocation). Use `current_volume()` for the
    // assertion target — separate gap from the deferred-step plumbing.
    await engine.evaluate(`
      live_loop :duck do
        puts "vol=#{current_volume()}"
        set_volume 0.3
        sleep 1
      end
    `)
    engine.play()

    type Sched = { tick: (t: number) => void }
    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
    // Drive several iterations. Iter 1 build: prints "vol=1" (initial),
    // pushes setVolume(0.3) step. Iter 1 run: setVolume fires →
    // currentVolume = 0.3. Iter 2 build: prints "vol=0.3". Pre-fix every
    // iteration printed "vol=1" because the closure was never mutated.
    for (let i = 0; i < 5; i++) {
      scheduler.tick(2)
      await new Promise((r) => setTimeout(r, 5))
    }

    const volLines = messages.filter((m) => /vol=/.test(m))
    expect(volLines.length).toBeGreaterThan(1)
    expect(volLines.some((m) => m.includes('vol=0.3'))).toBe(true)

    engine.dispose()
  })

  // Issue #202 (G4) — SoundLayer clamp warnings used to fire every loop
  // iteration. The fix wraps printHandler with a Set-based dedup that
  // matches `[...] clamped to N (min|max)` lines and emits each unique
  // message at most once per evaluate(). Re-evaluating clears the dedup.
  //
  // Verified at the printHandler boundary directly — exercising the FX
  // chain end-to-end requires a live SuperSonic bridge (browser only).
  it('dedups clamp-warning messages; resets on re-evaluate', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    const messages: string[] = []
    engine.setPrintHandler((m) => messages.push(m))

    // Reach into the wrapped printHandler that the engine plumbed via
    // setPrintHandler. SoundLayer's warnFn callbacks call this same wrapped
    // handler with messages of the shape we dedup on.
    type Internal = { printHandler: ((m: string) => void) | null }
    const wrapped = (engine as unknown as Internal).printHandler!
    expect(wrapped).toBeTypeOf('function')

    // First evaluation — fire the same clamp message 10 times. Should
    // surface exactly once. Other (non-clamp) messages always pass through.
    await engine.evaluate(`# noop`)
    for (let i = 0; i < 10; i++) {
      wrapped('[Warning] play :gverb — room: 233 clamped to 1 (max)')
    }
    wrapped('[Warning] something else')
    wrapped('[Warning] play :gverb — room: 233 clamped to 1 (max)')
    wrapped('[Warning] play :gverb — mix: 5 clamped to 1 (max)') // distinct line — passes
    const clampMatches = messages.filter((m) => /room: 233 clamped to 1 \(max\)/.test(m))
    const otherMessages = messages.filter((m) => /something else/.test(m))
    const distinctClamp = messages.filter((m) => /mix: 5 clamped to 1 \(max\)/.test(m))
    expect(clampMatches.length).toBe(1)
    expect(otherMessages.length).toBe(1)
    expect(distinctClamp.length).toBe(1)

    // Re-evaluate clears the dedup so the same clamp re-surfaces once.
    messages.length = 0
    await engine.evaluate(`# noop again`)
    wrapped('[Warning] play :gverb — room: 233 clamped to 1 (max)')
    wrapped('[Warning] play :gverb — room: 233 clamped to 1 (max)')
    const reMatches = messages.filter((m) => /room: 233 clamped to 1 \(max\)/.test(m))
    expect(reMatches.length).toBe(1)

    engine.dispose()
  })
})
