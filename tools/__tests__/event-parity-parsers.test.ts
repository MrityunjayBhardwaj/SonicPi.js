/**
 * Unit tests for the event-parity parsers + verdict logic (issue #446).
 * Pure functions only — no Sonic Pi / browser needed.
 */
import { describe, it, expect } from 'vitest'
import { parseDumpOsc, isFxEvent, type OscEvent } from '../lib/desktop-events.ts'
import { parseTraceLine, rebase } from '../lib/web-events.ts'
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

// --- rebase: FX nodes must not anchor the timeline (issue #466 / SP122) -------
describe('web rebase excludes FX nodes from the anchor', () => {
  const ev = (synthdef: string, tRel: number): OscEvent => ({ addr: '/s_new', synthdef, params: {}, tRel, raw: '' })

  it('anchors on the earliest NON-FX event, not an earlier FX node', () => {
    // The #466 scenario: web emits the with_fx FX node at tRel=0 (registration),
    // the vt-0 marker bell at 2.935, and the first saw at 6.935. Anchoring on the
    // FX node (old behaviour) leaves the bell at 2.935 / saw at 6.935 → a false
    // ~2.9s onset gap vs desktop (which anchors on the bell). Excluding FX from
    // the anchor puts the bell at 0 and the saw at 4.0, matching desktop.
    const out = rebase([
      ev('sonic-pi-fx_reverb', 0),
      ev('sonic-pi-pretty_bell', 2.935),
      ev('sonic-pi-saw', 6.935),
    ])
    const bell = out.find((e) => e.synthdef === 'sonic-pi-pretty_bell')!
    const saw = out.find((e) => e.synthdef === 'sonic-pi-saw')!
    const fx = out.find((e) => e.synthdef === 'sonic-pi-fx_reverb')!
    expect(bell.tRel).toBe(0) // marker is the shared zero
    expect(saw.tRel).toBeCloseTo(4.0, 3) // == desktop, no false gap
    expect(fx.tRel).toBeCloseTo(-2.935, 3) // FX shifted with everything (excluded from compare anyway)
  })

  it('falls back to all scheduled events when there are no non-FX events', () => {
    const out = rebase([ev('sonic-pi-fx_reverb', 5), ev('sonic-pi-fx_echo', 7)])
    expect(out.find((e) => e.synthdef === 'sonic-pi-fx_reverb')!.tRel).toBe(0)
    expect(out.find((e) => e.synthdef === 'sonic-pi-fx_echo')!.tRel).toBeCloseTo(2, 3)
  })

  it('matches isFxEvent on both naming conventions', () => {
    expect(isFxEvent({ synthdef: 'sonic-pi-fx_reverb' })).toBe(true)
    expect(isFxEvent({ synthdef: 'sonic_pi_fx_echo' })).toBe(true)
    expect(isFxEvent({ synthdef: 'sonic-pi-beep' })).toBe(false)
    expect(isFxEvent({ synthdef: undefined })).toBe(false)
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

// --- onset-SEQUENCE parity (SV61, #377/#378 — the EVENT-MATCH tiebreaker) ----
//
// The crux of the tiebreaker: STRUCTURE-MATCH (same layers) is necessary but not
// sufficient — the layers must also fire at the same TIMES. These tests pin the
// tolerance model (prefix-compare + ε≈15ms) AND the mandatory negative control
// (a real mis-timed / dropped layer must STILL diverge — never be promoted).

// onsets at explicit times for one synthdef
function at(synthdef: string, times: number[]): OscEvent[] {
  return times.map((t) => sNew(synthdef, t))
}

describe('buildReport onset-sequence parity (SV61)', () => {
  it('MATCHES the #378 ch6_binary_bizet pattern: blade @0,2,4… + stereo_player spacing [0,0.5,0.5,0,…]', () => {
    // Two non-commensurate live_loops; the audio pitch-tracker mis-orders the
    // dense interleave (false DIVERGE), but per-synthdef onset sequences are
    // identical desktop↔web — the engine schedules correctly.
    const blade = [0, 2, 4, 6, 8, 10, 12]
    const sp = [0, 0, 0.5, 1, 1, 1.5, 2, 2, 2.5, 3]
    const d = [...at('sonic-pi-blade', blade), ...at('sonic-pi-basic_stereo_player', sp)]
    const w = [...at('sonic-pi-blade', blade), ...at('sonic-pi-basic_stereo_player', sp)]
    const r = buildReport(d, w, 'live_loop :bizet do; end\nlive_loop :drums do; end')
    expect(r.verdict).toBe('STRUCTURE-MATCH')
    expect(r.sequenceParity.match).toBe(true)
  })

  it('tolerates desktop ~2ms real-time jitter (1.998 vs 2.0) within ε', () => {
    const d = at('sonic-pi-tb303', [0, 1.998, 3.997, 5.999])
    const w = at('sonic-pi-tb303', [0, 2.0, 4.0, 6.0])
    const r = buildReport(d, w, 'live_loop :a do; end')
    expect(r.sequenceParity.match).toBe(true)
    const row = r.sequenceParity.rows.find((s) => s.synthdef === 'sonic-pi-tb303')!
    expect(row.maxDevMs).toBeLessThanOrEqual(15)
  })

  it('PREFIX-compares: web captures one fewer cycle (cold-start trim) — not penalised', () => {
    const d = at('sonic-pi-tb303', [0, 2, 4, 6, 8, 10, 12]) // desktop last @12
    const w = at('sonic-pi-tb303', [0, 2, 4, 6, 8, 10]) // web trimmed @10
    const r = buildReport(d, w, 'live_loop :a do; end')
    expect(r.sequenceParity.match).toBe(true)
    const row = r.sequenceParity.rows.find((s) => s.synthdef === 'sonic-pi-tb303')!
    expect(row.comparedLen).toBe(6) // common prefix only
  })

  // ── NEGATIVE CONTROL (MANDATORY, SV50) — a real bug must STILL diverge ──────
  it('NEGATIVE CONTROL: a mis-timed loop period (2.0 vs 2.5) does NOT promote — sequenceParity.match=false', () => {
    // Layers match (STRUCTURE-MATCH) but web runs the loop ~25% slow. The very
    // first cycle already exceeds ε; deviation then grows unbounded. A tiebreaker
    // that promoted this would mask a real engine timing bug.
    const d = at('sonic-pi-tb303', [0, 2, 4, 6, 8])
    const w = at('sonic-pi-tb303', [0, 2.5, 5, 7.5, 10])
    const r = buildReport(d, w, 'live_loop :a do; end')
    expect(r.verdict).toBe('STRUCTURE-MATCH') // same layer multiset
    expect(r.sequenceParity.match).toBe(false) // …but timing diverges → real bug
    expect(r.sequenceParity.reasons.join(' ')).toMatch(/mis-timed/)
  })

  it('NEGATIVE CONTROL: a single mis-timed onset (one beat fires 80ms late) still diverges', () => {
    // Survives rebasing (a pure constant offset would not) — models a real
    // dropped/late beat. Anchored at 0 on both sides; the 3rd onset is late.
    const d = at('sonic-pi-tb303', [0, 1, 2, 3, 4])
    const w = at('sonic-pi-tb303', [0, 1, 2.08, 3, 4])
    const r = buildReport(d, w, 'live_loop :a do; end')
    expect(r.sequenceParity.match).toBe(false)
    const row = r.sequenceParity.rows.find((s) => s.synthdef === 'sonic-pi-tb303')!
    expect(row.firstMismatchIdx).toBe(2)
  })

  it('NEGATIVE CONTROL: a dropped significant layer is STRUCTURE-DIVERGE (never reaches event-match)', () => {
    const d = [...at('sonic-pi-mod_saw', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ...at('sonic-pi-beep', [0, 1, 2, 3, 4])]
    const w = at('sonic-pi-mod_saw', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) // beep dropped
    const r = buildReport(d, w, 'live_loop :a do; end')
    expect(r.verdict).toBe('STRUCTURE-DIVERGE')
  })

  it('returns match=null (not false) when there is no judgeable shared significant layer', () => {
    // Below the significance floor (≥3 and ≥5% of side total) → cannot judge.
    const d = at('sonic-pi-tb303', [0, 5])
    const w = at('sonic-pi-tb303', [0, 5])
    const r = buildReport(d, w, 'play 60')
    expect(r.sequenceParity.match).toBeNull()
  })
})

// --- NOTE-value parity per timetag (closes the timing≠notes hole) -----------
// onsets WITH note values for one synthdef
function atN(synthdef: string, pairs: Array<[number, number]>): OscEvent[] {
  return pairs.map(([t, note]) => ({ addr: '/s_new', synthdef, params: { note }, tRel: t, raw: '' }))
}

describe('buildReport onset-sequence parity — NOTE axis (SV61, deterministic)', () => {
  it('checks notes on deterministic pieces (notesChecked=true) and matches identical note sequences', () => {
    const seq: Array<[number, number]> = [[0, 60], [1, 62], [2, 64], [3, 65], [4, 67]]
    const r = buildReport(atN('sonic-pi-tb303', seq), atN('sonic-pi-tb303', seq), 'play 60')
    expect(r.sequenceParity.notesChecked).toBe(true)
    expect(r.sequenceParity.match).toBe(true)
    expect(r.sequenceParity.rows[0].noteMatched).toBe(true)
  })

  it('is order-invariant WITHIN a simultaneous cluster (octave stack) — the #378 fix', () => {
    // bizet plays two beeps per tick (look, look-12). The intra-tick serialisation
    // order is arbitrary per engine and inaudible; only the per-tick SET is musical.
    const d = atN('sonic-pi-tb303', [[0, 60], [0, 48], [1, 62], [1, 50], [2, 64], [2, 52]])
    const w = atN('sonic-pi-tb303', [[0, 48], [0, 60], [1, 50], [1, 62], [2, 52], [2, 64]]) // reordered within tick
    const r = buildReport(d, w, 'play 60')
    expect(r.sequenceParity.match).toBe(true)
    expect(r.sequenceParity.rows[0].noteMatched).toBe(true)
  })

  // ── THE HOLE THIS CLOSES (negative control) ─────────────────────────────────
  it('NEGATIVE CONTROL: same synthdef at the same TIMES but TRANSPOSED notes does NOT promote', () => {
    const times: Array<[number, number]> = [[0, 60], [1, 62], [2, 64], [3, 65], [4, 67]]
    const transposed: Array<[number, number]> = times.map(([t, n]) => [t, n + 7]) // up a fifth
    const r = buildReport(atN('sonic-pi-tb303', times), atN('sonic-pi-tb303', transposed), 'play 60')
    expect(r.sequenceParity.rows[0].timingMatched).toBe(true) // times identical
    expect(r.sequenceParity.rows[0].noteMatched).toBe(false) // …but wrong notes
    expect(r.sequenceParity.match).toBe(false) // → never EVENT-MATCH promoted
    expect(r.sequenceParity.reasons.join(' ')).toMatch(/wrong notes|transposition/)
  })

  it('does NOT check notes on PRNG pieces (notesChecked=false) — SV49, values vary by construction', () => {
    // Same times, different notes, but the source is PRNG → notes are not compared
    // (the random walk legitimately differs); timing parity still holds.
    const times: Array<[number, number]> = [[0, 60], [1, 62], [2, 64], [3, 65], [4, 67]]
    const other: Array<[number, number]> = [[0, 72], [1, 48], [2, 55], [3, 90], [4, 53]]
    const r = buildReport(atN('sonic-pi-tb303', times), atN('sonic-pi-tb303', other), 's = scale(:c, :major).choose')
    expect(r.sequenceParity.notesChecked).toBe(false)
    expect(r.sequenceParity.rows[0].noteMatched).toBeNull()
    expect(r.sequenceParity.match).toBe(true) // timing matches; notes not a criterion for PRNG
  })
})
