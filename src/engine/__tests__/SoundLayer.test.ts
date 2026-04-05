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

describe('env_curve injection — DISABLED (SP22 workaround)', () => {
  // SP22: WASM scsynth produces silence when env_curve: 2 is sent with overlapping
  // synth nodes. Injection disabled until upstream SuperSonic fix.
  it('does NOT inject env_curve (uses compiled default 1/linear)', () => {
    const p = normalizePlayParams('beep', { note: 60 }, 60)
    expect(p.env_curve).toBeUndefined()
  })

  it('preserves explicit env_curve from user', () => {
    const p = normalizePlayParams('beep', { note: 60, env_curve: 1 }, 60)
    expect(p.env_curve).toBe(1)
  })

  it('does not inject env_curve for samples', () => {
    const p = normalizeSampleParams({ attack: 0.1, release: 0.5 }, 60)
    expect(p.env_curve).toBeUndefined()
  })

  it('does NOT inject env_curve for simple samples (no ADSR)', () => {
    const p = normalizeSampleParams({ amp: 0.8 }, 60)
    expect(p.env_curve).toBeUndefined()
  })

  it('injects pre_amp: 1 for envelope samples', () => {
    const p = normalizeSampleParams({ attack: 0.1, release: 0.5 }, 60)
    expect(p.pre_amp).toBe(1)
  })

  it('does NOT inject pre_amp for simple samples', () => {
    const p = normalizeSampleParams({ amp: 0.8 }, 60)
    expect(p.pre_amp).toBeUndefined()
  })

  it('preserves explicit pre_amp', () => {
    const p = normalizeSampleParams({ attack: 0.1, pre_amp: 0.5 }, 60)
    expect(p.pre_amp).toBe(0.5)
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

// ---------------------------------------------------------------------------
// duration: → sustain calculation
// ---------------------------------------------------------------------------

describe('calculate sustain from duration:', () => {
  it('computes sustain = duration - attack - decay - release', () => {
    const p = normalizePlayParams('beep', { duration: 4, attack: 0.5, decay: 0.5, release: 1 }, 60)
    expect(p.sustain).toBe(2) // 4 - 0.5 - 0.5 - 1
    expect(p.duration).toBeUndefined() // stripped
  })

  it('uses default release:1 when not set', () => {
    const p = normalizePlayParams('beep', { duration: 2 }, 60)
    // sustain = 2 - 0(attack) - 0(decay) - 1(default release) = 1
    expect(p.sustain).toBe(1)
  })

  it('clamps sustain to 0 (not negative)', () => {
    const p = normalizePlayParams('beep', { duration: 0.5, attack: 0.3, release: 0.5 }, 60)
    expect(p.sustain).toBe(0) // 0.5 - 0.3 - 0 - 0.5 = -0.3 → clamped to 0
  })

  it('does not override explicit sustain', () => {
    const p = normalizePlayParams('beep', { duration: 4, sustain: 0.5 }, 60)
    expect(p.sustain).toBeCloseTo(0.5, 10) // explicit, not computed
  })

  it('computed sustain gets BPM-scaled', () => {
    const p = normalizePlayParams('beep', { duration: 4, attack: 0, release: 0 }, 120)
    // sustain = 4 - 0 - 0 - 0 = 4, then BPM-scaled: 4 * 60/120 = 2
    // But wait: duration is in beats. calculateSustain runs BEFORE BPM scaling.
    // So sustain = 4 (beats), then scaled to 4 * 60/120 = 2 (seconds). Correct.
    expect(p.sustain).toBe(2)
  })

  it('works for samples', () => {
    const p = normalizeSampleParams({ duration: 3, attack: 0.5, release: 0.5 }, 60)
    expect(p.sustain).toBe(2) // 3 - 0.5 - 0 - 0.5
  })
})

// ---------------------------------------------------------------------------
// slide: propagation
// ---------------------------------------------------------------------------

describe('slide: propagation', () => {
  it('expands slide: to all *_slide params', () => {
    const p = normalizePlayParams('beep', { note: 60, slide: 0.5 }, 60)
    expect(p.amp_slide).toBe(0.5)
    expect(p.pan_slide).toBe(0.5)
    expect(p.note_slide).toBe(0.5)
    expect(p.cutoff_slide).toBe(0.5)
    expect(p.slide).toBeUndefined() // stripped after expansion
  })

  it('does not override explicit *_slide params', () => {
    const p = normalizePlayParams('beep', { note: 60, slide: 0.5, amp_slide: 1.0 }, 60)
    expect(p.amp_slide).toBe(1.0) // explicit wins
    expect(p.pan_slide).toBe(0.5) // from slide:
  })

  it('expanded slide values get BPM-scaled', () => {
    const p = normalizePlayParams('beep', { note: 60, slide: 1.0 }, 120)
    expect(p.amp_slide).toBe(0.5) // 1.0 * 60/120
    expect(p.note_slide).toBe(0.5)
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
    const p = normalizeFxParams('echo', { room: 0.8, on: 1 }, 60)
    expect(p.on).toBeUndefined()
    expect(p.room).toBe(0.8)
  })

  it('resolves symbol defaults', () => {
    const p = normalizeFxParams('echo', { sustain_level: 0.5 }, 60)
    expect(p.decay_level).toBe(0.5)
  })

  it('BPM-scales FX time params (phase, decay, max_phase, delay)', () => {
    // Desktop Sonic Pi: trigger_fx → scale_time_args_to_bpm! for :bpm_scale => true params.
    // At 130 BPM: phase: 0.25 (beats) → 0.25 * 60/130 = 0.1154 seconds.
    // Verified from WAV: desktop echo at 115ms, not 250ms. See issue #66.
    const p = normalizeFxParams('echo', { phase: 0.25, decay: 2, max_phase: 1, room: 0.8 }, 130)
    expect(p.phase).toBeCloseTo(0.25 * 60 / 130, 10)      // scaled
    expect(p.decay).toBeCloseTo(2 * 60 / 130, 10)          // scaled
    expect(p.max_phase).toBeCloseTo(1 * 60 / 130, 10)      // scaled
    expect(p.room).toBe(0.8)                                 // NOT scaled (not a time param)
  })

  it('BPM-scales FX slide params', () => {
    const p = normalizeFxParams('echo', { phase_slide: 1, decay_slide: 0.5 }, 130)
    expect(p.phase_slide).toBeCloseTo(60 / 130, 10)
    expect(p.decay_slide).toBeCloseTo(0.5 * 60 / 130, 10)
  })

  it('does not scale at 60 BPM (identity)', () => {
    const p = normalizeFxParams('echo', { phase: 0.25, decay: 2, room: 0.8 }, 60)
    expect(p.phase).toBe(0.25)
    expect(p.decay).toBe(2)
    expect(p.room).toBe(0.8)
  })

  it('does NOT inject env_curve', () => {
    const p = normalizeFxParams('echo', { room: 0.8 }, 60)
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

  it('BPM scaling × non-time params: room/damp NOT scaled', () => {
    // Non-time FX params (room, damp) are not in TIME_PARAMS
    const p = normalizePlayParams('beep', {
      room: 0.8, damp: 0.5, release: 1,
    }, 130)
    expect(p.room).toBe(0.8)    // NOT scaled (not a time param)
    expect(p.damp).toBe(0.5)    // NOT scaled (not a time param)
    expect(p.release).toBeCloseTo(60 / 130, 10) // IS scaled
  })

  it('BPM scaling × FX time params: phase/decay ARE scaled', () => {
    // FX time params go through normalizeFxParams which also calls scaleTimeParamsToBpm.
    // Desktop Sonic Pi: trigger_fx → scale_time_args_to_bpm! for :bpm_scale => true.
    const p = normalizeFxParams('echo', { phase: 0.5, decay: 2, room: 0.8 }, 130)
    expect(p.phase).toBeCloseTo(0.5 * 60 / 130, 10)  // IS scaled (time param)
    expect(p.decay).toBeCloseTo(2 * 60 / 130, 10)     // IS scaled (time param)
    expect(p.room).toBe(0.8)                            // NOT scaled (not time)
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

  it('returns basic for cutoff + rate + amp (all simple)', () => {
    expect(selectSamplePlayer({ cutoff: 110, rate: 1.5, amp: 2 })).toBe('sonic-pi-basic_stereo_player')
  })

  it('returns basic for ADSR params (simple per Desktop SP)', () => {
    expect(selectSamplePlayer({ attack: 0.5, release: 2 })).toBe('sonic-pi-basic_stereo_player')
  })

  it('returns basic for beat_stretch (simple per Desktop SP)', () => {
    expect(selectSamplePlayer({ beat_stretch: 4 })).toBe('sonic-pi-basic_stereo_player')
  })

  it('returns stereo_player for window_size (granular)', () => {
    expect(selectSamplePlayer({ window_size: 0.1 })).toBe('sonic-pi-stereo_player')
  })

  it('returns stereo_player for norm', () => {
    expect(selectSamplePlayer({ norm: 1 })).toBe('sonic-pi-stereo_player')
  })
})

// ---------------------------------------------------------------------------
// Parameter validation & clamping (#57)
// ---------------------------------------------------------------------------

describe('validateAndClamp', () => {
  it('clamps cutoff above 130 to 130', () => {
    const p = normalizePlayParams('beep', { cutoff: 200 }, 60)
    expect(p.cutoff).toBe(130)
  })

  it('clamps negative amp to 0', () => {
    const p = normalizePlayParams('beep', { amp: -5 }, 60)
    expect(p.amp).toBe(0)
  })

  it('clamps pan outside -1..1', () => {
    const p1 = normalizePlayParams('beep', { pan: 3 }, 60)
    expect(p1.pan).toBe(1)
    const p2 = normalizePlayParams('beep', { pan: -5 }, 60)
    expect(p2.pan).toBe(-1)
  })

  it('clamps mix outside 0..1', () => {
    const p = normalizeFxParams('reverb', { mix: 1.5 }, 60)
    expect(p.mix).toBe(1)
  })

  it('clamps res outside 0..1', () => {
    const p = normalizePlayParams('beep', { res: 2 }, 60)
    expect(p.res).toBe(1)
  })

  it('passes valid values unchanged', () => {
    const p = normalizePlayParams('beep', { cutoff: 80, amp: 1, pan: -0.5 }, 60)
    expect(p.cutoff).toBe(80)
    expect(p.amp).toBe(1)
    expect(p.pan).toBe(-0.5)
  })

  it('emits warning via warnFn', () => {
    const warnings: string[] = []
    normalizePlayParams('beep', { cutoff: 200, pan: 5 }, 60, (msg) => warnings.push(msg))
    expect(warnings.length).toBe(2)
    expect(warnings[0]).toContain('cutoff')
    expect(warnings[0]).toContain('200')
    expect(warnings[1]).toContain('pan')
  })

  it('does not warn for valid values', () => {
    const warnings: string[] = []
    normalizePlayParams('beep', { cutoff: 80 }, 60, (msg) => warnings.push(msg))
    expect(warnings.length).toBe(0)
  })

  it('works on sample params', () => {
    const p = normalizeSampleParams({ start: 1.5, finish: -0.5 }, 60)
    expect(p.start).toBe(1)
    expect(p.finish).toBe(0)
  })

  it('works on FX params', () => {
    const p = normalizeFxParams('reverb', { room: 2, damp: -1 }, 60)
    expect(p.room).toBe(1)
    expect(p.damp).toBe(0)
  })
})
