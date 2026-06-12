import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeRandStream, RAND_STREAM_LENGTH } from '../../src/engine/RandStream'
import { SPRand } from '../../src/engine/SPRand'

/**
 * EPIC #531 Phase 1 — value parity against the REAL desktop random stream.
 *
 * The verdict values come from desktop's own test/lang/core/test_random.rb:
 * after a reset (default seed 0), `rand` yields exactly these four floats, which
 * are table[1..4] of rand-stream.wav (the +1 lookahead). This is THE proof that
 * we ship the right table, decode it the same way (÷32768), and index it with the
 * same arithmetic — i.e. that `rand`/`choose`/… match desktop note-for-note.
 *
 * Lives in tools/__tests__ (not src/) because it reads a file via node:fs, which
 * the src tsconfig (no @types/node) can't type-check — same split as the tutorial
 * drift guard. Still runs in CI via the standard vitest suite.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const WAV = join(HERE, '..', '..', 'public', 'rand-stream.wav')
const table = decodeRandStream(readFileSync(WAV))

// Desktop golden values (test_random.rb), == table[1..4].
const GOLDEN = [0.75006103515625, 0.733917236328125, 0.464202880859375, 0.24249267578125]

describe('rand-stream.wav decode (#531)', () => {
  it('decodes exactly 441000 values, all in [0, 1)', () => {
    expect(table.length).toBe(RAND_STREAM_LENGTH)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < table.length; i++) {
      if (table[i] < min) min = table[i]
      if (table[i] > max) max = table[i]
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThan(1)
  })

  it('table[1..4] equals the desktop golden rand values', () => {
    expect([table[1], table[2], table[3], table[4]]).toEqual(GOLDEN)
  })

  it('table[0] is the value the +1 lookahead skips on the first draw', () => {
    expect(table[0]).toBe(0.576446533203125)
  })

  it('rejects a non-RIFF buffer (a corrupt table must fail loudly, never mis-seed)', () => {
    expect(() => decodeRandStream(new Uint8Array([1, 2, 3, 4]))).toThrow(/RIFF/)
  })
})

describe('SPRand value parity vs desktop (#531)', () => {
  it('after reset(0), the first four rand() match desktop exactly', () => {
    const r = new SPRand(table, 0)
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual(GOLDEN)
  })

  it('rand_i! truncates rand! toward zero (Float#to_i)', () => {
    const r = new SPRand(table, 0)
    // rand!(10) = table[1]*10 = 7.5006… ⇒ choose over 0..9 lands on index 7
    expect(r.choose(Array.from({ length: 10 }, (_, i) => i))).toBe(7)
  })
})
