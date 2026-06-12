import { describe, it, expect } from 'vitest'
import { RAND_STREAM_LENGTH } from '../RandStream'
import { SPRand } from '../SPRand'

/**
 * EPIC #531 Phase 1 — SPRand stream mechanics.
 *
 * These pin the (seed, idx) ARITHMETIC against a synthetic identity table
 * (`table[i] = i`) so every assertion reads as a position. Value parity against
 * the REAL desktop rand-stream.wav + its golden values lives in
 * tools/__tests__/sprand-golden.test.ts (it decodes a file, so it sits outside
 * the src tsconfig — same split as the tutorial drift guard).
 */
function identityTable(): Float64Array {
  const t = new Float64Array(RAND_STREAM_LENGTH)
  for (let i = 0; i < t.length; i++) t[i] = i
  return t
}
const T = identityTable()

describe('SPRand seed/idx arithmetic (#531)', () => {
  it('reset(0): successive draws read positions 1, 2, 3, … (rand_peek +1 lookahead)', () => {
    const r = new SPRand(T, 0)
    expect([r.next(), r.next(), r.next()]).toEqual([1, 2, 3])
  })

  it('default seed is 0', () => {
    expect(new SPRand(T).next()).toBe(1)
  })

  it('use_random_seed s reads positions s+1, s+2, … (set_seed! semantics)', () => {
    const r = new SPRand(T, 1000)
    expect([r.next(), r.next()]).toEqual([1001, 1002])
  })

  it('rand!(max) scales the raw table value by max (table[pos] * max)', () => {
    const r = new SPRand(T, 0)
    // raw table[1] = 1 ⇒ rrand(0, 10) = 0 + 1*10 = 10
    expect(r.rrand(0, 10)).toBe(10)
  })
})

describe('SPRand stream mechanics (#531)', () => {
  it('peek() (rand_look) returns the next value WITHOUT consuming', () => {
    const r = new SPRand(T, 0)
    expect(r.peek()).toBe(1)
    expect(r.peek()).toBe(1) // unchanged
    expect(r.next()).toBe(1) // same value then consumed
    expect(r.peek()).toBe(2) // now advanced
  })

  it('current_random_seed = seed + idx, advancing by one per draw', () => {
    const r = new SPRand(T, 5)
    expect(r.getSeedPlusIdx()).toBe(5)
    r.next()
    expect(r.getSeedPlusIdx()).toBe(6)
  })

  it('rand_back (decIdx) re-reads the prior value; rand_skip (incIdx) advances', () => {
    const r = new SPRand(T, 0)
    r.next() // pos 1
    r.next() // pos 2, idx 2
    r.decIdx(1) // idx 1 → next draw pos 2 again
    expect(r.peek()).toBe(2)
    r.incIdx(2) // idx 3 → next draw pos 4
    expect(r.peek()).toBe(4)
  })

  it('setIdx (rand_reset / set_idx!) jumps the position, keeping seed', () => {
    const r = new SPRand(T, 100)
    r.next()
    r.setIdx(0)
    expect(r.peek()).toBe(101) // seed 100 + idx 0 + 1
  })

  it('floor-mods a negative index — rand_back past 0 wraps like Ruby %, not JS %', () => {
    const r = new SPRand(T, 0)
    r.decIdx(3) // idx = -3 ⇒ pos = (-3 + 1) mod 441000 = 440998
    expect(r.peek()).toBe(440998)
  })

  it('floors a float position — thread-derived seeds (Phase 3) truncate like Ruby array index', () => {
    // A child thread seed is a float (rand!(441000,..)+parentSeed). pos must floor.
    const r = new SPRand(T, 1000.7)
    // pos = floor((1000.7 + 0 + 1) mod 441000) = floor(1001.7) = 1001
    expect(r.peek()).toBe(1001)
  })

  it('wraps at the top of the table (modulo 441000)', () => {
    const r = new SPRand(T, RAND_STREAM_LENGTH - 1)
    // pos = (440999 + 0 + 1) mod 441000 = 0
    expect(r.peek()).toBe(0)
  })

  it('getState/setState round-trips (seed, idx) for with_random_seed', () => {
    const r = new SPRand(T, 7)
    r.next()
    r.next()
    const snap = r.getState()
    r.reset(99)
    r.next()
    r.setState(snap)
    expect(r.getState()).toEqual({ seed: 7, idx: 2 })
    expect(r.peek()).toBe(7 + 2 + 1)
  })

  it('clone() copies (seed, idx) and shares the table', () => {
    const r = new SPRand(T, 3)
    r.next()
    const c = r.clone()
    expect(c.getState()).toEqual({ seed: 3, idx: 1 })
    c.next()
    expect(r.getState()).toEqual({ seed: 3, idx: 1 }) // original untouched
  })
})
