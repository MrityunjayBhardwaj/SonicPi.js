/**
 * Unit tests for the event-parity parsers + verdict logic (issue #446).
 * Pure functions only — no Sonic Pi / browser needed.
 */
import { describe, it, expect } from 'vitest'
import { parseDumpOsc, type OscEvent } from '../lib/desktop-events.ts'
import { parseTraceLine } from '../lib/web-events.ts'
import { buildReport } from '../event-parity.ts'

describe('parseDumpOsc (desktop scsynth dumpOSC stream)', () => {
  it('parses plain messages, bundles with NTP timetags, and skips noise', () => {
    const sample = [
      '[ "/g_new", 8, 1, 4 ]',
      '[ "/s_new", "sonic-pi-basic_mixer", 9, 0, 2, "amp", 1, "out_bus", 18 ]',
      '[ "#bundle", 17134385929134665728, ',
      '  [ "/s_new", "sonic-pi-beep", 10, 1, 8, "note", 60, "out_bus", 20 ]',
      ']',
      '[ "#bundle", 17134385931282149376, ',
      '  [ "/s_new", "sonic-pi-beep", 11, 1, 8, "note", 67, "amp", 0.8, "out_bus", 20 ]',
      ']',
      '[ "/n_set", 9, "amp", 0 ]',
      'late 0.140410299',
      'FAILURE IN SERVER /n_set Node 79 not found',
    ].join('\n')
    const evs = parseDumpOsc(sample)
    const sNew = evs.filter((e) => e.addr === '/s_new')
    expect(sNew.map((e) => e.synthdef)).toEqual([
      'sonic-pi-basic_mixer',
      'sonic-pi-beep',
      'sonic-pi-beep',
    ])
    // Bundle timetags rebased: first beep at 0, second 0.5s later (NTP delta).
    const beeps = sNew.filter((e) => e.synthdef === 'sonic-pi-beep')
    expect(beeps[0].tRel).toBe(0)
    expect(beeps[1].tRel).toBeCloseTo(0.5, 2)
    // params parsed as key→value
    expect(beeps[1].params).toMatchObject({ note: 67, amp: 0.8, out_bus: 20 })
    // /n_set tracked; noise lines dropped
    expect(evs.some((e) => e.addr === '/n_set')).toBe(true)
    expect(evs.every((e) => !e.raw.includes('FAILURE'))).toBe(true)
  })

  it('treats immediate (no-bundle) messages as null tRel', () => {
    const evs = parseDumpOsc('[ "/s_new", "sonic-pi-mixer", 5, 0, 1, "amp", 1 ]')
    expect(evs[0].tRel).toBeNull()
  })

  it('rebases scheduled events on their own minimum, leaving immediate (timetag 1) null', () => {
    // An immediate bundle (timetag 1) mixed with two scheduled bundles. The
    // immediate event must NOT anchor the rebase to 0 and strand the scheduled
    // events at raw NTP scale.
    const sample = [
      '[ "#bundle", 1, ',
      '  [ "/s_new", "sonic-pi-fx_reverb", 20, 0, 1 ]',
      ']',
      '[ "#bundle", 17134385929134665728, ',
      '  [ "/s_new", "sonic-pi-beep", 10, 1, 8, "note", 60 ]',
      ']',
      '[ "#bundle", 17134385931282149376, ',
      '  [ "/s_new", "sonic-pi-beep", 11, 1, 8, "note", 67 ]',
      ']',
    ].join('\n')
    const evs = parseDumpOsc(sample)
    const reverb = evs.find((e) => e.synthdef === 'sonic-pi-fx_reverb')!
    const beeps = evs.filter((e) => e.synthdef === 'sonic-pi-beep')
    expect(reverb.tRel).toBeNull() // immediate — no absolute time
    expect(beeps[0].tRel).toBe(0) // earliest scheduled → 0
    expect(beeps[1].tRel).toBeCloseTo(0.5, 2) // not a raw NTP value
    expect(beeps[1].tRel! < 1).toBe(true)
  })
})

describe('parseTraceLine (web formatOscTrace stream)', () => {
  it('parses /s_new trace lines', () => {
    const e = parseTraceLine('[t:1.5000] /s_new "sonic-pi-mod_saw" 1057 0 100 {note: 67, amp: 0.8}')
    expect(e).not.toBeNull()
    expect(e!.addr).toBe('/s_new')
    expect(e!.synthdef).toBe('sonic-pi-mod_saw')
    expect(e!.nodeId).toBe(1057)
    expect(e!.tRel).toBe(1.5)
    expect(e!.params).toMatchObject({ note: 67, amp: 0.8 })
  })
  it('parses /n_set and ignores non-trace lines', () => {
    expect(parseTraceLine('[t:2.0000] /n_set 1056 {amp: 0}')!.addr).toBe('/n_set')
    expect(parseTraceLine('how does it feel?')).toBeNull()
    expect(parseTraceLine('[t:0.0] /run-code 5')).toBeNull()
  })
})

// --- verdict logic ---------------------------------------------------------

function sNew(synthdef: string, tRel: number | null): OscEvent {
  return { addr: '/s_new', synthdef, params: {}, tRel, raw: '' }
}
function many(synthdef: string, n: number, base = 0): OscEvent[] {
  return Array.from({ length: n }, (_, i) => sNew(synthdef, base + i))
}

describe('buildReport verdict', () => {
  it('STRUCTURE-MATCH when significant multiset matches (deterministic)', () => {
    const d = [...many('sonic-pi-tb303', 8)]
    const w = [...many('sonic-pi-tb303', 8)]
    const r = buildReport(d, w, 'use_synth :tb303\nplay 60')
    expect(r.verdict).toBe('STRUCTURE-MATCH')
    expect(r.isPrng).toBe(false)
  })

  it('STRUCTURE-DIVERGE when web DROPS a significant desktop layer', () => {
    const d = [...many('sonic-pi-mod_saw', 30), ...many('sonic-pi-beep', 10)]
    const w = [...many('sonic-pi-mod_saw', 30)] // beep dropped
    const r = buildReport(d, w, 'play 60')
    expect(r.verdict).toBe('STRUCTURE-DIVERGE')
    expect(r.reasons.join(' ')).toMatch(/DROPPED/)
    expect(r.reasons.join(' ')).toMatch(/beep/)
  })

  it('does NOT diverge on a rare one-sided synth in a PRNG piece (choose-variance, SV49)', () => {
    // ocean-style: desktop happened to .choose gnoise twice; web didn't pick it.
    const d = [...many('sonic-pi-cnoise', 20), ...many('sonic-pi-gnoise', 2)]
    const w = [...many('sonic-pi-cnoise', 22)]
    const r = buildReport(d, w, 's = [:cnoise, :gnoise].choose')
    expect(r.verdict).toBe('STRUCTURE-MATCH')
    expect(r.isPrng).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/choose-variance/)
  })

  it('flags a gating gap when a shared layer first-onset differs ≥3s', () => {
    // monday_blues: live_loop :synths, delay: 6 — desktop mod_saw@6s, web@0s.
    const d = [...many('sonic-pi-basic_mono_player', 80), ...many('sonic-pi-mod_saw', 30, 6)]
    const w = [...many('sonic-pi-basic_mono_player', 80), ...many('sonic-pi-mod_saw', 30, 0)]
    const r = buildReport(d, w, 'live_loop :synths, delay: 6 do\nuse_synth :mod_saw\nend')
    expect(r.verdict).toBe('STRUCTURE-MATCH')
    expect(r.reasons.join(' ')).toMatch(/Gating\/timing/)
    expect(r.reasons.join(' ')).toMatch(/mod_saw/)
  })

  it('reports WEB-EMPTY when web produced no voices', () => {
    const r = buildReport(many('sonic-pi-beep', 5), [], 'play 60')
    expect(r.verdict).toBe('WEB-EMPTY')
  })
})
