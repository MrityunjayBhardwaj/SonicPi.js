/**
 * #480 — a `live_loop` nested inside a user `in_thread` must fork at the parent
 * thread's virtualTime, not the `getAudioTime()` at its DEFERRED registration.
 *
 * Surfaced by the #477 onset-sequence diff-matrix oracle: `live_loop__*__nested`
 * cells started ~27ms late on web vs desktop. Root: the nested `live_loop`
 * registers as a global loop during the outer in_thread's first-tick body
 * execution; `registerLoop` seeded its virtualTime from `getAudioTime()` at that
 * deferred moment — ~1-3 ticks past launch — while the anchor / top-level loops
 * registered at launch (~getAudioTime 0). Same wall-clock-seed root as #475
 * (`case 'thread'`), here for the global-live_loop path (SonicPiEngine
 * wrappedLiveLoop). Fix: anchor the nested registration to the parent task's
 * virtualTime via `currentBuildTaskVt` (SV28 — build-phase state visible to
 * synchronous registrations inside builderFn).
 *
 * The skew is a WALL-CLOCK-ADVANCE artifact: it only manifests when
 * getAudioTime() advances between launch and the deferred registration. The
 * vitest env has no AudioContext, so getAudioTime() is normally frozen at 0 (why
 * the existing unit suite never caught it). This test reproduces it
 * deterministically by overriding the scheduler's getAudioTime to ADVANCE
 * between evaluate() (outer in_thread registers at 0) and the tick that runs the
 * outer body (nested live_loop registers). Pre-fix the nested loop's virtualTime
 * == the advanced clock; post-fix it == the parent's 0.
 *
 * Timing PARITY itself is Level-3-verified (tools/event-parity.ts on the 4
 * live_loop__*__nested cells: 27ms DIVERGE → 0ms MATCH vs desktop).
 */
import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

type Task = { virtualTime: number }
type Sched = {
  tick: (t: number) => void
  getTask: (n: string) => Task | undefined
  getAudioTime: () => number
  registerLoop: (name: string, fn: () => Promise<void>, opts?: Record<string, unknown>) => void
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('#480 nested live_loop fork virtualTime', () => {
  it('nested live_loop anchors to the parent in_thread vtime, not the advanced clock', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    // Outer in_thread registers during evaluate() (getAudioTime still 0).
    await engine.evaluate(`
      in_thread do
        live_loop :test do
          play 60
          sleep 1
        end
      end
    `)

    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
    // Simulate the real browser clock having advanced past launch by the time
    // the outer in_thread's body runs and registers the nested live_loop. This
    // is what produces the ~27ms skew with a live AudioContext.
    const ADVANCED = 5.0
    scheduler.getAudioTime = () => ADVANCED

    // Capture `:test`'s virtualTime AT REGISTRATION (the seed). runLoop suspends
    // at scheduleSleep(0) before iterating, so the value right after register is
    // the seed — before `sleep 1` advances it.
    const origRegister = scheduler.registerLoop.bind(scheduler)
    let testSeedVt: number | undefined
    scheduler.registerLoop = (name, fn, opts) => {
      origRegister(name, fn, opts)
      if (name === 'test') testSeedVt = scheduler.getTask('test')?.virtualTime
    }

    engine.play()
    // Run the outer in_thread's (one-shot) body → it registers `:test`.
    for (let i = 0; i < 3; i++) {
      scheduler.tick(20)
      await flush()
    }

    expect(testSeedVt, 'nested live_loop :test should have registered').toBeDefined()
    // THE FIX: seeded from the parent in_thread's vtime (0 — it registered at
    // launch and never slept), NOT the advanced getAudioTime() (5.0) at the
    // deferred registration moment. Pre-fix testSeedVt === ADVANCED.
    expect(testSeedVt!).toBeCloseTo(0, 6)
    expect(testSeedVt!).not.toBeCloseTo(ADVANCED, 3)

    engine.dispose()
  })

  it('regression: a TOP-LEVEL live_loop still seeds from getAudioTime (depth 0, unchanged)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()

    // Top-level live_loop registers at launch (depth 0) — must keep the
    // getAudioTime() seed (the #480 anchor only applies to nested depth>0).
    await engine.evaluate(`
      live_loop :solo do
        play 60
        sleep 1
      end
    `)

    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
    const ATLAUNCH = scheduler.getTask('solo')?.virtualTime
    expect(ATLAUNCH, 'top-level loop registered at launch').toBeDefined()
    // Registered during evaluate() with the un-advanced clock (0 in the test env).
    expect(ATLAUNCH).toBeCloseTo(0, 6)

    engine.dispose()
  })
})
