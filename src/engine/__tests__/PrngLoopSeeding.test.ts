/**
 * EPIC #531 Phase 3 — loop/thread random seeding parity (the E2E unlock).
 *
 * Phases 1+2 made random VALUES and per-op draw COUNTS match desktop at the
 * builder level, but NO real piece matched end-to-end: a live_loop's `rand`
 * ignored `use_random_seed` entirely. Loop builders were seeded from a HASH OF
 * THE LOOP NAME (the old `loopSeeds`), so `rand` inside any live_loop read a
 * name-derived position, not desktop's stream-derived child seed.
 *
 * Phase 3 replaces that with desktop's per-thread fork seeding
 * (runtime.rb:1062-1067): each spider thread (live_loop / in_thread) gets its OWN
 * stream derived from the parent at spawn:
 *   child_seed = SPRand.rand!(441000, gen_idx) + parent_seed   (gen_idx++ per spawn)
 * and the loop's stream then ADVANCES CONTINUOUSLY across iterations (desktop
 * live_loop is one thread = one stream — it does NOT re-seed per iteration).
 *
 * THE METHOD (SP140 lesson): a DIRECT `new ProgramBuilder(); b.rand()` test
 * PASSES while the real pipeline is WRONG, because it bypasses transpile +
 * evaluate + loop-registration seeding. So every assertion below drives the FULL
 * pipeline (engine.evaluate → play → scheduler ticks → captured `puts`).
 *
 * GROUND TRUTH: the expected values are computed from desktop's exact arithmetic
 * over desktop's exact frozen table (public/rand-stream.wav — the same wav
 * desktop ships). For `use_random_seed 0`, parent_seed=0, the first live_loop
 * (gen_idx 0) forks child_seed = table[1]*441000 = 330776.9165, whose stream
 * reads table[330777], table[330778], … :
 *   0.9287109375, 0.1043701171875, 0.7489013671875, 0.093414306640625, …
 * The second sibling (gen_idx 1) forks child_seed = table[2]*441000 = 323657.50,
 * first rand = 0.957244873046875. Verified independently against the raw wav.
 * (Desktop SP A/B is the Level-3 check; these ARE desktop's values by
 * construction — identical table, identical arithmetic.)
 */
import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import { SPRand } from '../SPRand'
import { RAND_STREAM_LENGTH } from '../RandStream'

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

// Desktop ground truth for `use_random_seed 0`, first live_loop (gen_idx 0).
const FOO_SEED0 = [
  '0.9287109375',
  '0.1043701171875',
  '0.7489013671875',
  '0.093414306640625',
  '0.03045654296875',
]
// Second sibling live_loop (gen_idx 1) — a DIFFERENT derived stream.
const BAR_SEED0_FIRST = '0.957244873046875'

describe('EPIC #531 Phase 3 — live_loop rand respects use_random_seed (E2E pipeline)', () => {
  it('a live_loop rand stream matches desktop after use_random_seed 0', async () => {
    const printed = await runAndCapture(`use_random_seed 0
live_loop :foo do
  puts rand
  sleep 1
end`)
    const nums = printed.filter((m) => /^[0-9.]/.test(m))
    expect(nums.slice(0, FOO_SEED0.length)).toEqual(FOO_SEED0)
  })

  it('the loop stream ADVANCES continuously across iterations (no per-iteration re-seed)', async () => {
    const printed = await runAndCapture(`use_random_seed 0
live_loop :foo do
  puts rand
  sleep 1
end`)
    const nums = printed.filter((m) => /^[0-9.]/.test(m))
    // Distinct values per iteration — a per-iteration re-seed would repeat or
    // shift-by-one, not produce desktop's continuous sequence.
    expect(new Set(nums.slice(0, 5)).size).toBe(5)
    expect(nums[1]).not.toBe(nums[0])
  })

  it('sibling live_loops fork DIFFERENT deterministic streams (gen_idx per spawn)', async () => {
    const printed = await runAndCapture(`use_random_seed 0
live_loop :foo do
  puts "foo " + rand.to_s
  sleep 1
end
live_loop :bar do
  puts "bar " + rand.to_s
  sleep 1
end`, 4)
    const foo = printed.filter((m) => m.startsWith('foo ')).map((m) => m.slice(4))
    const bar = printed.filter((m) => m.startsWith('bar ')).map((m) => m.slice(4))
    expect(foo[0]).toBe(FOO_SEED0[0])
    expect(bar[0]).toBe(BAR_SEED0_FIRST)
    expect(bar[0]).not.toBe(foo[0]) // siblings diverge
  })

  it('no use_random_seed defaults to seed 0 (desktop default)', async () => {
    const printed = await runAndCapture(`live_loop :foo do
  puts rand
  sleep 1
end`)
    const nums = printed.filter((m) => /^[0-9.]/.test(m))
    expect(nums.slice(0, FOO_SEED0.length)).toEqual(FOO_SEED0)
  })

  it('re-running re-derives the SAME stream (deterministic across Runs)', async () => {
    const code = `use_random_seed 0
live_loop :foo do
  puts rand
  sleep 1
end`
    const a = (await runAndCapture(code)).filter((m) => /^[0-9.]/.test(m))
    const b = (await runAndCapture(code)).filter((m) => /^[0-9.]/.test(m))
    expect(b.slice(0, 5)).toEqual(a.slice(0, 5))
  })

  it('a different seed yields a DIFFERENT loop stream', async () => {
    const s0 = (await runAndCapture(`use_random_seed 0
live_loop :foo do
  puts rand
  sleep 1
end`)).filter((m) => /^[0-9.]/.test(m))
    const s1 = (await runAndCapture(`use_random_seed 1
live_loop :foo do
  puts rand
  sleep 1
end`)).filter((m) => /^[0-9.]/.test(m))
    expect(s1[0]).not.toBe(s0[0])
  })
})

describe('EPIC #531 Phase 3 — SPRand.deriveChildSeed mechanics (synthetic table)', () => {
  // Synthetic ramp table: table[i] = i / N, so table[k]*N == k exactly — makes
  // the arithmetic checkable by hand independent of the real wav.
  const N = RAND_STREAM_LENGTH
  const ramp = new Float64Array(N)
  for (let i = 0; i < N; i++) ramp[i] = i / N

  it('derives child_seed = table[(seed+genIdx+1)%N]*N + seed (runtime.rb:1062)', () => {
    const r = new SPRand(ramp, 0)
    // genIdx 0, seed 0 → table[1]*N + 0 == 1
    expect(r.deriveChildSeed(0)).toBe(1)
    // genIdx 1 → table[2]*N == 2 ; genIdx 5 → 6
    expect(r.deriveChildSeed(1)).toBe(2)
    expect(r.deriveChildSeed(5)).toBe(6)
  })

  it('a non-zero parent seed offsets the derivation by seed', () => {
    const r = new SPRand(ramp, 100)
    // table[(100+0+1)%N]*N + 100 == 101 + 100 == 201
    expect(r.deriveChildSeed(0)).toBe(201)
  })

  it('does NOT consume the parent stream (explicit-idx peek, no idx advance)', () => {
    const r = new SPRand(ramp, 0)
    const before = r.getState()
    r.deriveChildSeed(0)
    r.deriveChildSeed(3)
    expect(r.getState()).toEqual(before) // seed + idx unchanged
  })
})
