import { describe, it, expect } from 'vitest'
import {
  normalizePlayParams,
  normalizeSampleParams,
  normalizeControlParams,
  normalizeFxParams,
  selectSamplePlayer,
} from '../SoundLayer'

// ---------------------------------------------------------------------------
// BPM scaling (G_NEW.1)
// ---------------------------------------------------------------------------

describe('BPM time scaling', () => {
  it('is identity at 60 BPM', () => {
    const p = normalizePlayParams('beep', { note: 60, release: 1, attack: 0.5 }, 60)
    expect(p.release).toBe(1)
    expect(p.attack).toBe(0.5)
  })

  it('scales time params at 120 BPM', () => {
    const p = normalizePlayParams('beep', { release: 1, attack: 0.5 }, 120)
    expect(p.release).toBe(0.5)
    expect(p.attack).toBe(0.25)
  })

  it('scales time params at 130 BPM', () => {
    const p = normalizePlayParams('beep', { release: 1 }, 130)
    expect(p.release).toBeCloseTo(60 / 130, 10)
  })

  it('scales all ADSR params', () => {
    const p = normalizePlayParams('beep', {
      attack: 1, decay: 0.5, sustain: 2, release: 1,
    }, 120)
    expect(p.attack).toBe(0.5)
    expect(p.decay).toBe(0.25)
    expect(p.sustain).toBe(1)
    expect(p.release).toBe(0.5)
  })

  it('scales slide times', () => {
    const p = normalizePlayParams('beep', {
      amp_slide: 1, cutoff_slide: 0.5, note_slide: 2,
    }, 120)
    expect(p.amp_slide).toBe(0.5)
    expect(p.cutoff_slide).toBe(0.25)
    expect(p.note_slide).toBe(1)
  })

  it('does NOT scale non-time params', () => {
    const p = normalizePlayParams('beep', {
      note: 60, amp: 0.8, pan: -0.5, cutoff: 90,
      release: 1,
    }, 130)
    expect(p.note).toBe(60)
    expect(p.amp).toBe(0.8)
    expect(p.pan).toBe(-0.5)
    expect(p.cutoff).toBe(90)
    // release IS scaled
    expect(p.release).toBeCloseTo(60 / 130, 10)
  })

  it('does NOT scale env_curve', () => {
    const p = normalizePlayParams('beep', { env_curve: 2, release: 1 }, 130)
    expect(p.env_curve).toBe(2)
    expect(p.release).toBeCloseTo(60 / 130, 10)
  })

  it('scales tb303 filter envelope times', () => {
    const p = normalizePlayParams('tb303', {
      attack: 0.1, cutoff_attack: 0.2, cutoff_release: 0.5,
    }, 120)
    expect(p.attack).toBe(0.05)
    expect(p.cutoff_attack).toBe(0.1)
    expect(p.cutoff_release).toBe(0.25)
  })

  it('scales sample time params', () => {
    const p = normalizeSampleParams({ release: 1, attack: 0.2 }, 130)
    expect(p.release).toBeCloseTo(60 / 130, 10)
    expect(p.attack).toBeCloseTo(0.2 * 60 / 130, 10)
  })

  it('does NOT scale negative sentinel values (sustain: -1)', () => {
    const p = normalizePlayParams('beep', { sustain: -1, release: 1 }, 130)
    expect(p.sustain).toBe(-1) // sentinel preserved
    expect(p.release).toBeCloseTo(60 / 130, 10) // positive value scaled
  })

  it('does NOT scale negative sample sustain sentinel', () => {
    const p = normalizeSampleParams({ sustain: -1, attack: 0.1 }, 120)
    expect(p.sustain).toBe(-1)
    expect(p.attack).toBe(0.05) // 0.1 * 60/120
  })
})

// ---------------------------------------------------------------------------
// Symbol resolution (G_NEW.4)
// ---------------------------------------------------------------------------

describe('symbol resolution', () => {
  it('resolves decay_level from sustain_level', () => {
    const p = normalizePlayParams('beep', { sustain_level: 0.5 }, 60)
    expect(p.decay_level).toBe(0.5)
  })

  it('preserves explicit decay_level over symbol resolution', () => {
    const p = normalizePlayParams('beep', {
      sustain_level: 0.5, decay_level: 0.8,
    }, 60)
    expect(p.decay_level).toBe(0.8)
  })

  it('does nothing when sustain_level is not set', () => {
    const p = normalizePlayParams('beep', { release: 1 }, 60)
    expect(p.decay_level).toBeUndefined()
  })

  it('works for any synth with ADSR', () => {
    for (const synth of ['saw', 'prophet', 'supersaw', 'fm', 'pluck']) {
      const p = normalizePlayParams(synth, { sustain_level: 0.3 }, 60)
      expect(p.decay_level).toBe(0.3)
    }
  })
})

// ---------------------------------------------------------------------------
// env_curve injection (G_NEW.13)
// ---------------------------------------------------------------------------

describe('env_curve injection', () => {
  it('injects env_curve: 2 for synths when not set', () => {
    const p = normalizePlayParams('beep', { note: 60 }, 60)
    expect(p.env_curve).toBe(2)
  })

  it('preserves explicit env_curve from user', () => {
    const p = normalizePlayParams('beep', { note: 60, env_curve: 1 }, 60)
    expect(p.env_curve).toBe(1)
  })

  it('injects env_curve for samples with envelope params', () => {
    const p = normalizeSampleParams({ attack: 0.1, release: 0.5 }, 60)
    expect(p.env_curve).toBe(2)
  })

  it('does NOT inject env_curve for simple samples (no ADSR)', () => {
    const p = normalizeSampleParams({ amp: 0.8 }, 60)
    expect(p.env_curve).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Parameter aliasing
// ---------------------------------------------------------------------------

describe('parameter aliasing', () => {
  it('aliases cutoff → lpf for sc808_snare', () => {
    const p = normalizePlayParams('sc808_snare', { cutoff: 80 }, 60)
    expect(p.lpf).toBe(80)
    expect(p.cutoff).toBeUndefined()
  })

  it('aliases cutoff → lpf for sc808_clap', () => {
    const p = normalizePlayParams('sc808_clap', { cutoff: 90 }, 60)
    expect(p.lpf).toBe(90)
    expect(p.cutoff).toBeUndefined()
  })

  it('aliases dpulse_width → pulse_width for dpulse', () => {
    const p = normalizePlayParams('dpulse', { dpulse_width: 0.5 }, 60)
    expect(p.pulse_width).toBe(0.5)
    expect(p.dpulse_width).toBeUndefined()
  })

  it('does NOT alias if target already set', () => {
    const p = normalizePlayParams('sc808_snare', { cutoff: 80, lpf: 100 }, 60)
    expect(p.lpf).toBe(100)
    // cutoff remains since lpf was already set
    expect(p.cutoff).toBe(80)
  })

  it('does not alias for regular synths', () => {
    const p = normalizePlayParams('beep', { cutoff: 90 }, 60)
    expect(p.cutoff).toBe(90)
    expect(p.lpf).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Synth-specific munging (tb303)
// ---------------------------------------------------------------------------

describe('tb303 munging', () => {
  it('mirrors attack → cutoff_attack', () => {
    const p = normalizePlayParams('tb303', { attack: 0.1 }, 60)
    expect(p.cutoff_attack).toBe(0.1)
  })

  it('mirrors all ADSR to cutoff envelope', () => {
    const p = normalizePlayParams('tb303', {
      attack: 0.1, decay: 0.2, sustain: 0.3, release: 0.4,
    }, 60)
    expect(p.cutoff_attack).toBe(0.1)
    expect(p.cutoff_decay).toBe(0.2)
    expect(p.cutoff_sustain).toBe(0.3)
    expect(p.cutoff_release).toBe(0.4)
  })

  it('does not override explicit cutoff envelope params', () => {
    const p = normalizePlayParams('tb303', {
      attack: 0.1, cutoff_attack: 0.5,
    }, 60)
    expect(p.cutoff_attack).toBe(0.5)
  })

  it('injects cutoff_min: 30 default', () => {
    const p = normalizePlayParams('tb303', { note: 60 }, 60)
    expect(p.cutoff_min).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Strip non-scsynth params
// ---------------------------------------------------------------------------

describe('strip non-scsynth params', () => {
  it('removes on: param', () => {
    const p = normalizePlayParams('beep', { note: 60, on: 1 }, 60)
    expect(p.on).toBeUndefined()
    expect(p.note).toBe(60)
  })

  it('removes slide: param', () => {
    const p = normalizePlayParams('beep', { note: 60, slide: 0.5 }, 60)
    expect(p.slide).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Control message normalization
// ---------------------------------------------------------------------------

describe('normalizeControlParams', () => {
  it('BPM-scales time params', () => {
    const p = normalizeControlParams({ amp_slide: 1, amp: 0.5 }, 120)
    expect(p.amp_slide).toBe(0.5)
    expect(p.amp).toBe(0.5) // not scaled
  })

  it('does NOT inject env_curve', () => {
    const p = normalizeControlParams({ release: 1 }, 120)
    expect(p.env_curve).toBeUndefined()
    expect(p.release).toBe(0.5)
  })

  it('strips non-scsynth params', () => {
    const p = normalizeControlParams({ on: 1, amp: 0.5 }, 60)
    expect(p.on).toBeUndefined()
    expect(p.amp).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// FX normalization
// ---------------------------------------------------------------------------

describe('normalizeFxParams', () => {
  it('strips non-scsynth params', () => {
    const p = normalizeFxParams({ room: 0.8, on: 1 })
    expect(p.on).toBeUndefined()
    expect(p.room).toBe(0.8)
  })

  it('resolves symbol defaults', () => {
    const p = normalizeFxParams({ sustain_level: 0.5 })
    expect(p.decay_level).toBe(0.5)
  })

  it('does NOT BPM-scale any params', () => {
    const p = normalizeFxParams({ phase: 0.5, decay: 1, room: 0.8 })
    expect(p.phase).toBe(0.5)  // NOT scaled
    expect(p.decay).toBe(1)    // NOT scaled
    expect(p.room).toBe(0.8)   // NOT scaled
  })

  it('does NOT inject env_curve', () => {
    const p = normalizeFxParams({ room: 0.8 })
    expect(p.env_curve).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Composition pair tests
// ---------------------------------------------------------------------------

describe('composition pairs', () => {
  it('BPM scaling × Symbol resolution: resolve THEN scale (levels not scaled)', () => {
    // sustain_level: 0.5 at 130 BPM
    // → decay_level resolves to 0.5 (symbol resolution)
    // → decay_level and sustain_level are LEVELS (0-1), NOT time durations
    //   so they are NOT BPM-scaled
    const p = normalizePlayParams('beep', { sustain_level: 0.5, release: 1 }, 130)
    expect(p.decay_level).toBe(0.5)       // resolved, NOT scaled (it's a level)
    expect(p.sustain_level).toBe(0.5)     // NOT scaled (it's a level)
    expect(p.release).toBeCloseTo(60 / 130, 10) // IS scaled (it's a time)
  })

  it('BPM scaling × env_curve: env_curve NOT scaled', () => {
    const p = normalizePlayParams('beep', { release: 1, env_curve: 2 }, 130)
    expect(p.release).toBeCloseTo(60 / 130, 10)
    expect(p.env_curve).toBe(2) // NOT scaled
  })

  it('BPM scaling × FX params: FX params NOT scaled', () => {
    // FX params go through a different path (not normalizePlayParams)
    // This test verifies that room/damp are not in TIME_PARAMS
    const p = normalizePlayParams('beep', {
      room: 0.8, damp: 0.5, release: 1,
    }, 130)
    expect(p.room).toBe(0.8)    // NOT scaled
    expect(p.damp).toBe(0.5)    // NOT scaled
    expect(p.release).toBeCloseTo(60 / 130, 10) // IS scaled
  })

  it('Symbol resolution × tb303 munging: resolve then mirror then scale', () => {
    // tb303 with attack:0.1, sustain_level:0.5 at 120 BPM
    // 1. Symbol resolution: decay_level = 0.5 (level, not time)
    // 2. tb303 munge: cutoff_attack = 0.1 (time)
    // 3. BPM scale: attack = 0.05, cutoff_attack = 0.05
    //    decay_level stays 0.5 (it's a level, not a time)
    const p = normalizePlayParams('tb303', {
      attack: 0.1, sustain_level: 0.5,
    }, 120)
    expect(p.decay_level).toBe(0.5)    // level — NOT scaled
    expect(p.cutoff_attack).toBe(0.05) // 0.1 * 60/120 — IS scaled
    expect(p.attack).toBe(0.05)        // 0.1 * 60/120 — IS scaled
  })
})

// ---------------------------------------------------------------------------
// Sample player selection
// ---------------------------------------------------------------------------

describe('selectSamplePlayer', () => {
  it('returns basic_stereo_player for simple opts', () => {
    expect(selectSamplePlayer({ amp: 1, rate: 1 })).toBe('sonic-pi-basic_stereo_player')
  })

  it('returns basic_stereo_player for undefined opts', () => {
    expect(selectSamplePlayer()).toBe('sonic-pi-basic_stereo_player')
  })

  it('returns stereo_player for pitch', () => {
    expect(selectSamplePlayer({ pitch: 2 })).toBe('sonic-pi-stereo_player')
  })

  it('returns stereo_player for start/finish', () => {
    expect(selectSamplePlayer({ start: 0.2, finish: 0.8 })).toBe('sonic-pi-stereo_player')
  })

  it('returns stereo_player for compress', () => {
    expect(selectSamplePlayer({ compress: 1 })).toBe('sonic-pi-stereo_player')
  })
})
