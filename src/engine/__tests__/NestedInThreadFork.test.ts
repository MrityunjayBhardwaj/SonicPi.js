/**
 * #475 — A nested `in_thread` (inside `with_fx` / a loop) must fork at the
 * SPAWNING thread's current virtual-time cursor, not at the scheduler's
 * wall-clock getAudioTime().
 *
 * Bug (found via the SV61 onset-sequence event-parity tiebreaker on
 * tests/book-examples/e2e_03_fx.rb):
 *
 *   with_fx :distortion do
 *     in_thread do
 *       play 48; sleep 0.25; play 50
 *     end
 *     play 36; sleep 0.5
 *   end
 *
 * Desktop SP forks the in_thread (48,50) AND runs main `play 36` ALL at the
 * block cursor (an in_thread does NOT advance the spawning thread's time).
 * Web's main `play 36` was correct, but the nested in_thread fired ~0.3s EARLY
 * because `case 'thread'` → `registerLoop` seeded the child's virtualTime from
 * `getAudioTime()` (wall clock), which lags the spawner's logical cursor by
 * ~schedAheadTime.
 *
 * Root: VirtualTimeScheduler.registerLoop `virtualTime: this.getAudioTime()`.
 * Fix: AudioInterpreter `case 'thread'` passes `virtualTime: task.virtualTime`
 * (the spawning thread's cursor) so the child inherits the spawner's clock.
 *
 * #448 (top-level in_thread start-gate) is a DIFFERENT code path — top-level
 * in_thread hoists to a separate gated registration and never reaches
 * `case 'thread'`. The full suite is the regression guard for that path; the
 * `at` test below guards the sibling that SHARES `case 'thread'`.
 *
 * Observation: the mock bridge's triggerSynth(name, audioTime, params) records
 * the exact scheduled audioTime per note — a direct, deterministic measurement
 * of the fork time (no audio hardware needed; the divergence is pure virtual
 * time). getAudioTime is pinned to 0 while the program sleeps the cursor
 * forward, so the pre-fix bug manifests as the child firing a full `schedAhead`
 * + sleep early — same mechanism as the ~0.3s field divergence, exaggerated and
 * deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { ProgramBuilder } from '../ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'
import type { SuperSonicBridge } from '../SuperSonicBridge'
import { initTreeSitter, autoTranspile } from '../TreeSitterTranspiler'

async function flushMicrotasks(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

const SCHED_AHEAD = 100

/** Mock bridge recording per-note scheduled audioTime. */
function createRecordingBridge(): SuperSonicBridge & { plays: { note: number; t: number }[] } {
  let nextBus = 16
  let nextNode = 5000
  const plays: { note: number; t: number }[] = []
  return {
    plays,
    allocateBus() { return nextBus++ },
    freeBus() {},
    async applyFx() { return nextNode++ },
    async applyFxOrdered() { return nextNode++ },
    flushImmediateFx() {},
    freeNode() {},
    createFxGroup() { return nextNode++ },
    freeGroup() {},
    flushMessages() {},
    async triggerSynth(_name: string, time: number, params: Record<string, number>) {
      plays.push({ note: params.note as number, t: time })
      return nextNode++
    },
    async playSample() { return nextNode++ },
    get audioContext() { return null as unknown as AudioContext },
    send() {},
    sendTimedControl() {},
  } as unknown as SuperSonicBridge & { plays: { note: number; t: number }[] }
}

function makeAudioCtx(scheduler: VirtualTimeScheduler, taskId: string, bridge: SuperSonicBridge): AudioCtx {
  return {
    bridge,
    scheduler,
    taskId,
    eventStream: new SoundEventStream(),
    schedAheadTime: SCHED_AHEAD,
    nodeRefMap: new Map<number, number>(),
    reusableFx: new Map(),
  } as AudioCtx
}

/** Run a ProgramBuilder program to completion under a pinned (lagging) clock. */
async function runToCompletion(build: (b: ProgramBuilder) => ProgramBuilder) {
  const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: SCHED_AHEAD })
  const bridge = createRecordingBridge()
  const program = build(new ProgramBuilder(0)).build()
  scheduler.registerLoop('main', async () => {
    await runProgram(program, makeAudioCtx(scheduler, 'main', bridge))
  })
  // Several ticks + microtask flushes so the main thread AND every child thread
  // (registered mid-run) run their bodies to completion.
  for (let i = 0; i < 6; i++) {
    scheduler.tick(SCHED_AHEAD)
    await flushMicrotasks()
  }
  return bridge.plays
}

describe('#475 nested in_thread fork timing', () => {
  it('nested in_thread inside with_fx forks at the spawning cursor, not ~schedAhead early', async () => {
    // sleep 2 advances the cursor to vt 2; the with_fx block then forks the
    // in_thread and plays 36, all expected at the SAME audio time (vt 2 + sa).
    const plays = await runToCompletion((b) =>
      b
        .sleep(2)
        .with_fx('distortion', (fx) =>
          fx
            .in_thread((t) => { t.play(48, { release: 0.3 }).sleep(0.25).play(50, { release: 0.3 }) })
            .play(36, { release: 0.5 })
            .sleep(0.5)
        )
    )

    const p48 = plays.find((p) => p.note === 48)
    const p50 = plays.find((p) => p.note === 50)
    const p36 = plays.find((p) => p.note === 36)
    expect(p48, 'in_thread play 48 should fire').toBeDefined()
    expect(p50, 'in_thread play 50 should fire').toBeDefined()
    expect(p36, 'main play 36 should fire').toBeDefined()

    // The block cursor is vt 2; every play schedules at cursor + schedAhead.
    const blockCursorAudioTime = 2 + SCHED_AHEAD

    // Main thread was always correct.
    expect(p36!.t).toBeCloseTo(blockCursorAudioTime, 6)

    // THE FIX: the nested in_thread forks at the SAME cursor as its spawner —
    // 48 fires together with 36, not ~schedAhead (here a full vt-2) early.
    expect(p48!.t).toBeCloseTo(blockCursorAudioTime, 6)
    // sleep 0.25 inside the thread → 50 is 0.25 later.
    expect(p50!.t).toBeCloseTo(blockCursorAudioTime + 0.25, 6)

    // Onset SEQUENCE matches desktop: 48 and 36 simultaneous, then 50.
    expect(p48!.t).toBeCloseTo(p36!.t, 6)
    expect(p50!.t).toBeGreaterThan(p36!.t)
  })

  it('regression: `at` (shares case "thread") still forks at cursor + offset', async () => {
    // `at 1 do play 72 end` after sleep 2 → fork at vt 2, sleep 1 → play 72 at vt 3.
    const plays = await runToCompletion((b) =>
      b.sleep(2).at(1, null, (t) => { (t as ProgramBuilder).play(72) })
    )
    const p72 = plays.find((p) => p.note === 72)
    expect(p72, 'at-block play 72 should fire').toBeDefined()
    expect(p72!.t).toBeCloseTo(3 + SCHED_AHEAD, 6)
  })

  it('regression: top-level in_thread does NOT route through case "thread"', async () => {
    // Guards the #448 path: a top-level in_thread must hoist to a SEPARATE
    // gated registration (`__startGate`), never an inline `__b.in_thread(...)`
    // that would reach `case 'thread'`. If this ever changes, the #475 anchor
    // would silently start interacting with the #448 start-gate.
    const base = new URL('../../..', import.meta.url).pathname
    await initTreeSitter({
      treeSitterWasmUrl: base + 'node_modules/web-tree-sitter/tree-sitter.wasm',
      rubyWasmUrl: base + 'node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm',
    })
    const js = autoTranspile(`use_bpm 120
sleep 2
in_thread do
  play 48
end
play 36`)
    // Top-level in_thread is a gated standalone registration, NOT inside __run_once.
    expect(js).toMatch(/in_thread\(\{\s*__startGate:/)
    expect(js).not.toMatch(/__run_once[\s\S]*__b\.in_thread/)
  })
})
