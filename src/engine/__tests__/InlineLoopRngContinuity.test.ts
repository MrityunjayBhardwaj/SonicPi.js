import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

// #593 / SV75: a top-level bare `loop` is `__inline` — it models desktop's
// single continuous main-thread spider stream. Its RNG must CONTINUE the stream
// after the bare-code draws that precede it (run inside `__run_once`), not
// snapshot the top-level state at registration and REPLAY those draws.
//
// Oracle (desktop-independent): the engine's OWN continuous-stream semantics. A
// pure-bare `puts rand ×N` advances one stream → [v0, v1, v2, ...]. Splitting
// the same draws into bare-prefix + inline loop must reproduce the SAME stream:
// the loop's first `rand` continues at the index AFTER the prefix draws.

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
type Sched = { tick: (t: number) => void }

/** Drive code through the full engine pipeline, capturing numeric `puts` lines. */
async function runAndCapture(code: string, iterations = 8): Promise<string[]> {
  const engine = new SonicPiEngine()
  await engine.init()
  const printed: string[] = []
  engine.setPrintHandler((m) => printed.push(m))
  await engine.evaluate(code)
  const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
  engine.play()
  for (let i = 0; i < iterations; i++) {
    scheduler.tick(20)
    await flush()
  }
  engine.dispose()
  return printed
}

describe('#593 — inline bare loop continues the top-level RNG stream (SV75)', () => {
  it("the loop's first rand continues AFTER the bare-prefix draws (not a replay)", async () => {
    // Reference: one continuous main-thread stream of 4 draws (all in __run_once).
    const ref = await runAndCapture(`use_random_seed 0
puts rand
puts rand
puts rand
puts rand`)
    expect(ref.length).toBeGreaterThanOrEqual(4)
    const [v0, , v2] = ref

    // Target: two draws in bare code (→ __run_once), then the inline loop draws.
    // The loop's FIRST rand must equal v2 (continuation), NOT v0 (replay of the
    // bare-prefix stream from index 0).
    const got = await runAndCapture(`use_random_seed 0
a = rand
b = rand
loop do
  puts rand
  sleep 1
end`)
    expect(got.length).toBeGreaterThanOrEqual(2)
    expect(got[0]).toBe(v2)
    expect(got[0]).not.toBe(v0)
    // And it keeps continuing: second loop draw is the next stream value.
    expect(got[1]).toBe(ref[3])
  })

  it('a true fork (in_thread) keeps its derived child stream — SV69/#531-P3 intact', async () => {
    // Regression guard: the deferred inline seeding must not touch forked-loop
    // child-seed derivation. Determinism across two identical runs.
    const code = `use_random_seed 0
a = rand
in_thread do
  loop do
    puts rand
    sleep 1
  end
end
loop do
  sleep 1
end`
    const a = await runAndCapture(code)
    const b = await runAndCapture(code)
    expect(a.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
