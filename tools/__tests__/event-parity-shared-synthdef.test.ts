import { describe, it, expect } from 'vitest'
import { buildReport, type ParityReport } from '../event-parity.ts'
import type { OscEvent } from '../lib/desktop-events.ts'

// Regression for #618 — Pocket Groove's hi-hat "rate desync" was a TOOLING false
// positive, not an engine bug. Sonic Pi's generic sample players are shared by
// every `sample` call, so :kick (bd_808, no rate) and :hats (drum_cymbal_closed,
// rate: rrand) BOTH emit `basic_mono_player`. The old tool merged them into one
// per-synthdef onset stream; an SV83 window-edge count gap in one sample then
// desynced the merged prefix → false onset-DIVERGE. It also never diffed sample
// `rate` at all, so a REAL rate desync would slip through as "notes ✓".
//
// The fix: split a shared sample player into rate / no-rate sub-streams (keyed on
// rate-PRESENCE, which is invariant across engines — buf ids are engine-local),
// and add a per-onset RATE axis with a look-ahead TAIL GUARD.

let nodeId = 1000
function ev(synthdef: string, t: number, params: Record<string, number>): OscEvent {
  return { addr: '/s_new', synthdef, nodeId: nodeId++, params, tRel: t, raw: '' }
}

/** A kick (no rate) every beat + a hat (rate) on the off-beats, on ONE shared
 *  synthdef. `hatRates` supplies each hat's rate; `tailExtra` adds desktop-only
 *  look-ahead onsets (SV83). */
function pocketGrooveLike(hatRates: number[], tailExtra: number): OscEvent[] {
  const out: OscEvent[] = []
  // kick: one per beat at t = 0,1,2,… (rate-less)
  const beats = Math.ceil(hatRates.length / 2)
  for (let b = 0; b < beats; b++) out.push(ev('sonic-pi-basic_mono_player', b, { amp: 0, buf: 7 }))
  // hat: every 0.5 beat, carries rate
  hatRates.forEach((r, i) => out.push(ev('sonic-pi-basic_mono_player', i * 0.5, { amp: 0, rate: r, buf: 6 })))
  // desktop-only look-ahead tail (rate-bearing hats past the window edge)
  for (let k = 0; k < tailExtra; k++)
    out.push(ev('sonic-pi-basic_mono_player', hatRates.length * 0.5 + k * 0.5, { amp: 0, rate: 1.0 + k * 0.01, buf: 6 }))
  return out
}

const CODE = 'sample :drum_cymbal_closed, rate: rrand(0.8, 1.1) if pattern.tick'

function bmpRows(r: ParityReport) {
  return r.sequenceParity.rows.filter((row) => row.synthdef.includes('basic_mono_player'))
}

describe('event-parity shared sample-player split + rate axis (#618)', () => {
  const baseRates = Array.from({ length: 40 }, (_, i) => 0.8 + ((i * 7) % 30) / 100) // deterministic 0.80–1.09

  it('splits a shared synthdef into #rate / #norate sub-streams (no merge desync)', () => {
    // Desktop carries 3 extra look-ahead hats (SV83); web does not. The OLD tool
    // would desync the merged kick+hat prefix here. Split → both streams align.
    const desktop = pocketGrooveLike(baseRates, 3)
    const web = pocketGrooveLike(baseRates, 0)
    const r = buildReport(desktop, web, CODE)
    const keys = bmpRows(r).map((row) => row.synthdef).sort()
    expect(keys).toContain('sonic-pi-basic_mono_player#rate')
    expect(keys).toContain('sonic-pi-basic_mono_player#norate')
    expect(r.sequenceParity.match).toBe(true)
  })

  it('verifies the rate axis on the rated sub-stream when rates match', () => {
    const r = buildReport(pocketGrooveLike(baseRates, 2), pocketGrooveLike(baseRates, 0), CODE)
    const rated = bmpRows(r).find((row) => row.synthdef.endsWith('#rate'))!
    expect(rated.rateMatched).toBe(true)
    const norate = bmpRows(r).find((row) => row.synthdef.endsWith('#norate'))!
    expect(norate.rateMatched).toBeNull() // rate-less stream → no rate to judge
  })

  it('CATCHES a real (permanent, mid-stream) rate desync', () => {
    // Diverge from hat #10 onward — well inside the committed region.
    const webRates = baseRates.map((x, i) => (i >= 10 ? x + 0.2 : x))
    const r = buildReport(pocketGrooveLike(baseRates, 1), pocketGrooveLike(webRates, 0), CODE)
    const rated = bmpRows(r).find((row) => row.synthdef.endsWith('#rate'))!
    expect(rated.rateMatched).toBe(false)
    expect(rated.firstRateMismatchIdx).toBe(10)
    expect(r.sequenceParity.match).toBe(false)
  })

  it('GUARDS a tail-only rate divergence (SV83 look-ahead jitter, #599 family)', () => {
    // Diverge only in the final two hats — the uncommitted look-ahead tail. This
    // is the 16_neon_grid case (vanishes with a longer window) — must NOT fail.
    const webRates = baseRates.map((x, i) => (i >= baseRates.length - 2 ? x + 0.3 : x))
    const r = buildReport(pocketGrooveLike(baseRates, 0), pocketGrooveLike(webRates, 0), CODE)
    const rated = bmpRows(r).find((row) => row.synthdef.endsWith('#rate'))!
    expect(rated.rateMatched).toBe(true)
    expect(r.sequenceParity.match).toBe(true)
  })

  it('does NOT split a synthdef that is rate-less on both sides (pitched/plain)', () => {
    const desktop = Array.from({ length: 8 }, (_, i) => ev('sonic-pi-beep', i * 0.5, { note: 60 + i }))
    const web = Array.from({ length: 8 }, (_, i) => ev('sonic-pi-beep', i * 0.5, { note: 60 + i }))
    const r = buildReport(desktop, web, 'play 60')
    const keys = r.sequenceParity.rows.map((row) => row.synthdef)
    expect(keys).toContain('sonic-pi-beep')
    expect(keys.every((k) => !k.includes('#'))).toBe(true)
  })
})
