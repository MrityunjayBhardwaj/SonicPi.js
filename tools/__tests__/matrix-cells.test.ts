/**
 * Unit tests for the differential-coverage matrix enumeration (issue #459).
 * Pure functions only — no Sonic Pi / browser needed. Guards the contract the
 * driver (tools/diff-matrix.ts) and viewer (tools/build-diff-matrix.ts) rely on:
 * complete coverage, deterministic (no-PRNG) reproducers, logged skips.
 */
import { describe, it, expect } from 'vitest'
import {
  enumerateCells,
  summarizeCells,
  CONSTRUCTS,
  MODIFIERS,
  POSITIONS,
} from '../lib/matrix-cells.ts'

const PRNG = /\b(choose|rrand|rrand_i|rand|rand_i|shuffle|dice|one_in|pick|rand_look|ring_shuffle)\b/

describe('enumerateCells — coverage of the construct×modifier×position space', () => {
  const cells = enumerateCells()

  it('covers the full Cartesian product exactly once (no silent caps)', () => {
    expect(cells.length).toBe(CONSTRUCTS.length * MODIFIERS.length * POSITIONS.length)
    const ids = new Set(cells.map((c) => c.id))
    expect(ids.size).toBe(cells.length) // unique ids
    for (const construct of CONSTRUCTS)
      for (const modifier of MODIFIERS)
        for (const position of POSITIONS)
          expect(ids.has(`${construct}__${modifier}__${position}`)).toBe(true)
  })

  it('every skipped cell carries a human reason and empty code (logged, never silent)', () => {
    for (const c of cells) {
      if (c.skip) {
        expect(c.skip.length).toBeGreaterThan(0)
        expect(c.code).toBe('')
      } else {
        expect(c.code.length).toBeGreaterThan(0)
      }
    }
  })

  it('skips exactly the nonsensical cells: delay×non-loop + sync×at', () => {
    const skipped = cells.filter((c) => c.skip).map((c) => c.id).sort()
    expect(skipped).toEqual(
      [
        'at__delay__nested',
        'at__delay__top_level',
        'at__sync__nested',
        'at__sync__top_level',
        'bare_loop__delay__nested',
        'bare_loop__delay__top_level',
        'with_fx__delay__nested',
        'with_fx__delay__top_level',
      ].sort(),
    )
  })

  it('delay: only appears on live_loop / in_thread reproducers', () => {
    for (const c of cells) {
      if (c.skip) continue
      if (/\bdelay:/.test(c.code)) {
        expect(['live_loop', 'in_thread']).toContain(c.construct)
      }
    }
  })

  it('every active reproducer is deterministic — no PRNG tokens (SV49)', () => {
    for (const c of cells) {
      if (c.skip) continue
      expect(c.code, `${c.id} must be PRNG-free`).not.toMatch(PRNG)
    }
  })

  it('sync cells include the driver cuer; non-sync cells do not', () => {
    for (const c of cells) {
      if (c.skip) continue
      if (c.modifier === 'sync') {
        expect(c.code).toMatch(/live_loop :driver do[\s\S]*cue :tick/)
        expect(c.code).toMatch(/sync :tick/)
      } else {
        expect(c.code).not.toMatch(/cue :tick/)
      }
    }
  })

  it('every active reproducer begins with the shared vt-0 reference anchor', () => {
    for (const c of cells) {
      if (c.skip) continue
      expect(c.code, `${c.id} must lead with the anchor`).toMatch(/^synth :pretty_bell, note: 36/)
    }
  })

  it('nested cells wrap the construct in a user in_thread; top-level do not', () => {
    const llNestedNothing = cells.find((c) => c.id === 'live_loop__nothing__nested')!
    // after the anchor, the construct is wrapped in an in_thread
    expect(llNestedNothing.code).toMatch(/in_thread do\n {2}live_loop :test do/)
    const llTopNothing = cells.find((c) => c.id === 'live_loop__nothing__top_level')!
    // top-level: the live_loop is unwrapped (not inside an in_thread)
    expect(llTopNothing.code).not.toMatch(/in_thread do/)
    expect(llTopNothing.code).toMatch(/\nlive_loop :test do/)
  })

  it('var-read cells bind n before the construct and read it in the body (SP121 form)', () => {
    const sp121 = cells.find((c) => c.id === 'bare_loop__var_read__nested')!
    expect(sp121.code).toMatch(/n = 7/)
    expect(sp121.code).toMatch(/play 60 \+ n/)
  })

  it('use_synth cells set the synth and play a bare note so propagation is observable (SV55 form)', () => {
    for (const c of cells.filter((c) => c.modifier === 'use_synth' && !c.skip)) {
      expect(c.code).toMatch(/use_synth :tb303/)
      expect(c.code).toMatch(/\bplay 60\b/) // bare play — voice reveals inherited synth
    }
  })

  it('marks the fork/registration seam column (the §36 fatality instrument)', () => {
    // live_loop / in_thread / bare_loop ALWAYS become a separate scheduler entity
    // (run-2 finding: even a nested live_loop forks at launch, losing the enclosing
    // in_thread's sequencing). with_fx / at run inline in __run_once → not on the seam.
    const seam = (id: string) => cells.find((c) => c.id === id)!.seam
    expect(seam('bare_loop__nothing__top_level')).toBe(true)
    expect(seam('bare_loop__nothing__nested')).toBe(true)
    expect(seam('in_thread__nothing__nested')).toBe(true)
    expect(seam('live_loop__nothing__top_level')).toBe(true)
    expect(seam('live_loop__nothing__nested')).toBe(true) // nested live_loop STILL forks at launch
    expect(seam('with_fx__nothing__top_level')).toBe(false) // with_fx body runs inline in __run_once
    expect(seam('at__nothing__top_level')).toBe(false) // at runs in __run_once at cursor
  })

  it('summarizeCells reports active/skipped split', () => {
    const s = summarizeCells(cells)
    expect(s.total).toBe(cells.length)
    expect(s.active + s.skipped).toBe(s.total)
    expect(s.skipped).toBe(8)
    expect(s.skippedCells.length).toBe(8)
  })
})
