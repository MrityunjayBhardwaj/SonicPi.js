import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'
import { sampleDurationSeconds } from '../SoundLayer'

// #513 / SV66 — use_sample_bpm / sample_duration must derive the tempo from a
// sample's REAL decoded buffer length, not the old hardcoded `1` stub. The
// reference number is loop_amen ≈ 1.753 s (desktop event-parity: sleep 1 advances
// 1.753 s → BPM 34.2; web was stuck at BPM 60 = 1.0 s/beat, 1.753× too fast).
const LOOP_AMEN = 1.753

describe('sampleDurationSeconds (SoundLayer, mirrors sound.rb:2236)', () => {
  it('returns undefined when the buffer duration is unknown', () => {
    expect(sampleDurationSeconds(undefined)).toBeUndefined()
    expect(sampleDurationSeconds(null)).toBeUndefined()
  })

  it('returns undefined for a non-positive buffer duration (div-by-zero guard)', () => {
    expect(sampleDurationSeconds(0)).toBeUndefined()
    expect(sampleDurationSeconds(-1)).toBeUndefined()
  })

  it('returns the raw buffer seconds with no opts', () => {
    expect(sampleDurationSeconds(LOOP_AMEN)).toBeCloseTo(1.753, 3)
  })

  it('scales by 1/|rate| (rate 2 halves, rate -1 keeps magnitude)', () => {
    expect(sampleDurationSeconds(LOOP_AMEN, { rate: 2 })).toBeCloseTo(0.8765, 3)
    expect(sampleDurationSeconds(LOOP_AMEN, { rate: -1 })).toBeCloseTo(1.753, 3)
  })

  it('applies the start/finish window', () => {
    expect(sampleDurationSeconds(LOOP_AMEN, { start: 0, finish: 0.5 })).toBeCloseTo(0.8765, 3)
    expect(sampleDurationSeconds(LOOP_AMEN, { start: 0.25, finish: 0.75 })).toBeCloseTo(0.8765, 3)
  })

  it('clamps to the envelope only when sustain is finite (default -1 = whole buffer)', () => {
    // sustain default -1 → no clamp
    expect(sampleDurationSeconds(LOOP_AMEN, { sustain: -1 })).toBeCloseTo(1.753, 3)
    // finite sustain shorter than the buffer → clamp to attack+decay+sustain+release
    expect(sampleDurationSeconds(LOOP_AMEN, { attack: 0, decay: 0, sustain: 0.5, release: 0.1 }))
      .toBeCloseTo(0.6, 3)
    // sustain envelope longer than the buffer → buffer wins (min)
    expect(sampleDurationSeconds(LOOP_AMEN, { sustain: 5 })).toBeCloseTo(1.753, 3)
  })

  it('returns undefined when a zero-width window collapses the duration', () => {
    expect(sampleDurationSeconds(LOOP_AMEN, { start: 0.5, finish: 0.5 })).toBeUndefined()
  })
})

describe('ProgramBuilder.use_sample_bpm (#513)', () => {
  const withProvider = (dur: number | undefined) => {
    const b = new ProgramBuilder()
    b.setSampleDurationProvider(() => dur)
    return b
  }

  it('sets BPM = 60 / raw_seconds (loop_amen → ~34.2, NOT the old no-op 60)', () => {
    const b = withProvider(LOOP_AMEN)
    b.use_sample_bpm('loop_amen')
    expect(b.currentBpm).toBeCloseTo(60 / 1.753, 2) // 34.23
    expect(b.currentBpm).not.toBeCloseTo(60, 0)
  })

  it('honors num_beats (compus_beats: num_beats 4 → BPM = 4*60/dur)', () => {
    const b = withProvider(LOOP_AMEN)
    b.use_sample_bpm('loop_compus', { num_beats: 4 })
    expect(b.currentBpm).toBeCloseTo((4 * 60) / 1.753, 2)
  })

  it('leaves BPM unchanged when the duration is unknown (no use_bpm(Infinity))', () => {
    const b = withProvider(undefined)
    b.use_sample_bpm('loop_amen')
    expect(b.currentBpm).toBe(60) // default, untouched
    expect(Number.isFinite(b.currentBpm)).toBe(true)
  })

  it('is a no-op when no provider is wired (pure builder, no bridge)', () => {
    const b = new ProgramBuilder()
    b.use_sample_bpm('loop_amen')
    expect(b.currentBpm).toBe(60)
  })
})

describe('ProgramBuilder.sample_duration (#513)', () => {
  const withProvider = (dur: number | undefined) => {
    const b = new ProgramBuilder()
    b.setSampleDurationProvider(() => dur)
    return b
  }

  it('returns raw seconds as beats at the default bpm 60', () => {
    const b = withProvider(LOOP_AMEN)
    expect(b.sample_duration('loop_amen')).toBeCloseTo(1.753, 3)
  })

  it('returns beats scaled by the current bpm (1 beat at the matched tempo)', () => {
    const b = withProvider(LOOP_AMEN)
    b.use_sample_bpm('loop_amen') // bpm → 34.2
    // at the matched tempo the amen break is exactly 1 beat long
    expect(b.sample_duration('loop_amen')).toBeCloseTo(1, 2)
  })

  it('falls back to 1 beat when the duration is unknown (never NaN into sleep)', () => {
    const b = withProvider(undefined)
    expect(b.sample_duration('loop_amen')).toBe(1)
    const bare = new ProgramBuilder()
    expect(bare.sample_duration('loop_amen')).toBe(1)
  })
})
