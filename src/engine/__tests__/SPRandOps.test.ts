import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'

/**
 * EPIC #531 Phase 2 — every random op consumes the frozen stream exactly like
 * desktop (value AND draw count). Verified at the top-level builder, which
 * respects use_random_seed today (loop-body seeding is Phase 3).
 *
 * Golden values are hand-computed from rand-stream.wav after use_random_seed 0:
 *   table[1..7] = 0.75006103515625, 0.733917236328125, 0.464202880859375,
 *                 0.24249267578125, 0.10821533203125, 0.54010009765625,
 *                 0.822113037109375
 * Each draw reads table[seed+idx+1] then advances idx (the +1 lookahead).
 * Draw-COUNT exactness matters most: one extra/missing draw misaligns every
 * subsequent random, so the "no-draw" edges (min==max) are tested explicitly.
 */
const T1 = 0.75006103515625
const T2 = 0.733917236328125

const seeded = () => {
  const b = new ProgramBuilder()
  b.use_random_seed(0)
  return b
}

describe('SPRand op values match desktop (#531 Phase 2)', () => {
  it('rand() / rand(max) = table[1] * max', () => {
    expect(seeded().rand()).toBe(T1)
    expect(seeded().rand(12)).toBe(T1 * 12)
  })

  it('rand_i(max) = floor(table[1] * max) — and rand_i(1) DRAWS (= 0)', () => {
    expect(seeded().rand_i(12)).toBe(9)
    expect(seeded().rand_i(1)).toBe(0) // rand_i!(1) = floor(0.75) = 0, one draw
  })

  it('rrand(min,max) = min + table[1]*(max-min)', () => {
    expect(seeded().rrand(10, 20)).toBe(10 + T1 * 10)
  })

  it('rrand_i(min,max) = min + floor(table[1]*(range+1))', () => {
    expect(seeded().rrand_i(0, 9)).toBe(7) // floor(0.75006*10)=7
  })

  it('dice(6) = rrand_i(1,6) = 5', () => {
    expect(seeded().dice(6)).toBe(5) // 1 + floor(0.75006*6) = 1+4
  })

  it('choose picks arr[rand_i!(len)]', () => {
    expect(seeded().choose(Array.from({ length: 10 }, (_, i) => i))).toBe(7)
  })

  it('rdist(width,centre) = rrand(centre-width, centre+width)', () => {
    expect(seeded().rdist(1, 0)).toBe(-1 + T1 * 2) // 0.5001220703125
  })

  it('rand_look peeks the next value without consuming', () => {
    const b = seeded()
    expect(b.rand_look()).toBe(T1)
    expect(b.rand()).toBe(T1) // same value then consumed
  })
})

describe('SPRand draw-count exactness — the no-draw edges (#531 Phase 2)', () => {
  it('rrand(x,x) returns x WITHOUT consuming a draw', () => {
    const b = seeded()
    expect(b.rrand(5, 5)).toBe(5)
    expect(b.rand()).toBe(T1) // stream untouched ⇒ still table[1]
  })

  it('dice(1) returns 1 WITHOUT consuming (rrand_i(1,1))', () => {
    const b = seeded()
    expect(b.dice(1)).toBe(1)
    expect(b.rand()).toBe(T1)
  })

  it('rand_i(1) DOES consume (rand_i! always draws)', () => {
    const b = seeded()
    expect(b.rand_i(1)).toBe(0)
    expect(b.rand()).toBe(T2) // advanced ⇒ table[2]
  })
})

describe('shuffle — desktop derived-seed algorithm (#531 Phase 2)', () => {
  it('consumes EXACTLY ONE outer draw regardless of list size', () => {
    const b = seeded()
    expect(b.current_random_seed()).toBe(0)
    b.shuffle([1, 2, 3, 4, 5, 6, 7, 8])
    expect(b.current_random_seed()).toBe(1) // seed 0 + idx 1, not + list size
  })

  it('after shuffle, the next rand reads table[2] (outer advanced by one)', () => {
    const b = seeded()
    b.shuffle([10, 20, 30, 40, 50])
    expect(b.rand()).toBe(T2)
  })

  it('is a permutation of the input (same elements, length preserved)', () => {
    const out = seeded().shuffle([1, 2, 3, 4, 5]).toArray()
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('is deterministic — same seed ⇒ same order', () => {
    expect(seeded().shuffle([1, 2, 3, 4, 5, 6]).toArray()).toEqual(
      seeded().shuffle([1, 2, 3, 4, 5, 6]).toArray(),
    )
  })
})
