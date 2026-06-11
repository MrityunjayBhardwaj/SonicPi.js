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

describe('ProgramBuilder.with_sample_bpm (#518, desktop sound.rb:588)', () => {
  const withProvider = (dur: number | undefined) => {
    const b = new ProgramBuilder()
    b.setSampleDurationProvider(() => dur)
    return b
  }

  it('sets the block bpm to the sample tempo (loop_amen → ~34.2) then RESTORES it', () => {
    const b = withProvider(LOOP_AMEN)
    let inside = -1
    // transpiler emits the no-opts form as with_sample_bpm(name, fn)
    b.with_sample_bpm('loop_amen', (bb) => { inside = bb.currentBpm })
    expect(inside).toBeCloseTo(60 / 1.753, 2) // 34.23 inside the block
    expect(b.currentBpm).toBe(60)             // restored after the block
  })

  it('honors num_beats (opts form: with_sample_bpm(name, opts, fn))', () => {
    const b = withProvider(LOOP_AMEN)
    let inside = -1
    b.with_sample_bpm('loop_amen', { num_beats: 4 }, (bb) => { inside = bb.currentBpm })
    expect(inside).toBeCloseTo((4 * 60) / 1.753, 2)
    expect(b.currentBpm).toBe(60)
  })

  it('emits the useBpm step pair (set then restore) so sleeps inside scale', () => {
    const b = withProvider(LOOP_AMEN)
    b.with_sample_bpm('loop_amen', (bb) => { bb.sleep(1) })
    const useBpm = b.build().filter((s) => s.tag === 'useBpm') as Array<{ bpm: number }>
    expect(useBpm.length).toBe(2)
    expect(useBpm[0].bpm).toBeCloseTo(60 / 1.753, 2) // set to sample tempo
    expect(useBpm[1].bpm).toBe(60)                    // restored
  })

  it('unknown duration → block STILL runs at the current bpm AND warns once (#519)', () => {
    const b = withProvider(undefined)
    const warned: string[] = []
    b.setWarnHandler((n) => warned.push(n))
    let ran = false
    let inside = -1
    b.with_sample_bpm('mystery', (bb) => { ran = true; inside = bb.currentBpm })
    expect(ran).toBe(true)        // a block wrapper must always execute its body
    expect(inside).toBe(60)       // bpm unchanged (no use_bpm(Infinity))
    expect(b.currentBpm).toBe(60)
    expect(warned).toEqual(['mystery'])
  })

  it('no warn when the duration IS known', () => {
    const b = withProvider(LOOP_AMEN)
    const warned: string[] = []
    b.setWarnHandler((n) => warned.push(n))
    b.with_sample_bpm('loop_amen', () => {})
    expect(warned).toEqual([])
  })
})

describe('ProgramBuilder use_sample_bpm warn seam (#519)', () => {
  it('use_sample_bpm warns once via _warnHandler when the duration is unknown', () => {
    const b = new ProgramBuilder()
    b.setSampleDurationProvider(() => undefined)
    const warned: string[] = []
    b.setWarnHandler((n) => warned.push(n))
    b.use_sample_bpm('mystery')
    expect(b.currentBpm).toBe(60)
    expect(warned).toEqual(['mystery'])
  })

  it('the warn seam is inherited by with_fx sub-builders', () => {
    const b = new ProgramBuilder()
    b.setSampleDurationProvider(() => undefined)
    const warned: string[] = []
    b.setWarnHandler((n) => warned.push(n))
    b.with_fx('reverb', (inner) => inner.use_sample_bpm('mystery'))
    expect(warned).toEqual(['mystery'])
  })
})
