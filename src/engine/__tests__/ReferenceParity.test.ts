/**
 * Reference Parity Tests — Desktop Sonic Pi as ground truth.
 *
 * These tests verify that our normalization pipeline produces the SAME output
 * as desktop Sonic Pi for specific inputs. The expected values are derived
 * directly from desktop Sonic Pi's source code:
 *
 *   - synthinfo.rb: :bpm_scale => true/false tags per param per synth/FX
 *   - sound.rb: normalise_and_resolve_synth_args, scale_time_args_to_bpm!
 *   - runtime.rb: arg_bpm_scaling defaults to true
 *
 * WHY THIS EXISTS (SP17 prevention):
 * A wrong assumption about desktop behavior ("FX params are NOT BPM-scaled")
 * was encoded in code comments and unit tests. Tests passed while the behavior
 * was incorrect. These parity tests use desktop's actual source as the oracle,
 * not our own assumptions. If our normalization diverges from desktop, these
 * tests fail — even if our "unit tests" pass.
 *
 * HOW TO MAINTAIN:
 * When adding a new normalization rule, add a parity test case here with the
 * expected output derived from synthinfo.rb. Cite the source file and line.
 *
 * Source: https://github.com/sonic-pi-net/sonic-pi/blob/dev/app/server/ruby/lib/sonicpi/synths/synthinfo.rb
 */

import { describe, it, expect } from 'vitest'
import {
  normalizePlayParams,
  normalizeSampleParams,
  normalizeControlParams,
  normalizeFxParams,
} from '../SoundLayer'

const BPM = 130
const FACTOR = 60 / BPM // 0.46153...

// ---------------------------------------------------------------------------
// Reference: synthinfo.rb :bpm_scale tags
//
// Every param listed below is tagged :bpm_scale => true in desktop Sonic Pi.
// Our normalization MUST scale these by 60/BPM. Anything NOT listed here
// MUST NOT be scaled.
// ---------------------------------------------------------------------------

/**
 * Desktop Sonic Pi's BPM-scaled params, extracted from synthinfo.rb.
 * Format: { paramName: true } means :bpm_scale => true in desktop.
 *
 * Source: synthinfo.rb FXEcho, FXSlicer, FXFlanger, FXTremolo, FXPingPong, etc.
 */
const DESKTOP_FX_BPM_SCALED: Record<string, boolean> = {
  // FXEcho: phase, decay, max_phase + slides
  phase: true,
  decay: true,
  max_phase: true,
  phase_slide: true,
  decay_slide: true,
  max_phase_slide: true,
  // FXFlanger: delay + phase
  delay: true,
  delay_slide: true,
  // FXInfo base: mix_slide, pre_amp_slide, pre_mix_slide (all FX inherit)
  mix_slide: true,
  pre_amp_slide: true,
  pre_mix_slide: true,
}

const DESKTOP_FX_NOT_SCALED: Record<string, boolean> = {
  // These are NOT :bpm_scale => true — they are non-time params
  room: true,
  damp: true,
  mix: true,
  pre_amp: true,
  feedback: true,
  // FXChorus: phase is explicitly :bpm_scale => false (the ONLY exception)
  // (FXChorus is commented out in desktop Sonic Pi, not user-accessible)
}

const DESKTOP_SYNTH_BPM_SCALED: Record<string, boolean> = {
  // SynthInfo base class + subclasses
  attack: true,
  decay: true,
  sustain: true,
  release: true,
  attack_slide: true,
  decay_slide: true,
  sustain_slide: true,
  release_slide: true,
  amp_slide: true,
  pan_slide: true,
  // tb303: cutoff envelope times
  cutoff_attack: true,
  cutoff_decay: true,
  cutoff_sustain: true,
  cutoff_release: true,
}

const DESKTOP_SYNTH_NOT_SCALED: Record<string, boolean> = {
  amp: true,
  note: true,
  pan: true,
  env_curve: true,
  sustain_level: true,
  decay_level: true,
  cutoff: true,
  res: true,
}

// ---------------------------------------------------------------------------
// Parity tests: FX normalization
// ---------------------------------------------------------------------------

describe('Reference parity: FX params match desktop Sonic Pi', () => {
  it('BPM-scales all params tagged :bpm_scale => true in synthinfo.rb (FXEcho)', () => {
    const input = { phase: 0.25, decay: 2, max_phase: 1 }
    const result = normalizeFxParams('echo', input, BPM)

    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
    expect(result.decay).toBeCloseTo(2 * FACTOR, 10)
    expect(result.max_phase).toBeCloseTo(1 * FACTOR, 10)
  })

  it('BPM-scales FX slide params (all *_slide are :bpm_scale => true)', () => {
    const input: Record<string, number> = {
      phase_slide: 1, decay_slide: 0.5, mix_slide: 0.2,
      pre_amp_slide: 0.1, room_slide: 0.3,
    }
    const result = normalizeFxParams('echo', input, BPM)

    for (const key of Object.keys(input)) {
      expect(result[key], `${key} should be BPM-scaled`).toBeCloseTo(input[key] * FACTOR, 10)
    }
  })

  it('does NOT scale non-time FX params', () => {
    const input: Record<string, number> = { room: 0.8, damp: 0.5, mix: 0.3, feedback: 0.6, pre_amp: 1.0 }
    const result = normalizeFxParams('reverb', input, BPM)

    for (const [key, val] of Object.entries(input)) {
      expect(result[key], `${key} should NOT be BPM-scaled`).toBe(val)
    }
  })

  it('handles mixed time + non-time FX params correctly', () => {
    const input = { phase: 0.25, decay: 4, mix: 0.2, room: 0.5 }
    const result = normalizeFxParams('echo', input, BPM)

    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
    expect(result.decay).toBeCloseTo(4 * FACTOR, 10)
    expect(result.mix).toBe(0.2)
    expect(result.room).toBe(0.5)
  })

  it('FXFlanger: delay and phase are both BPM-scaled', () => {
    const input = { phase: 0.5, delay: 0.01 }
    const result = normalizeFxParams('flanger', input, BPM)

    expect(result.phase).toBeCloseTo(0.5 * FACTOR, 10)
    expect(result.delay).toBeCloseTo(0.01 * FACTOR, 10)
  })

  it('FXSlicer/FXTremolo/FXWobble: phase is BPM-scaled', () => {
    const input = { phase: 0.125 }
    const result = normalizeFxParams('slicer', input, BPM)
    expect(result.phase).toBeCloseTo(0.125 * FACTOR, 10)
  })

  it('at 60 BPM: explicit params pass through unchanged (identity)', () => {
    const input = { phase: 0.25, decay: 2, room: 0.8, mix_slide: 0.5 }
    const result = normalizeFxParams('echo', input, 60)
    expect(result.phase).toBe(0.25)
    expect(result.decay).toBe(2)
    expect(result.room).toBe(0.8)
    expect(result.mix_slide).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// Parity tests: FX default injection (#67)
// ---------------------------------------------------------------------------

describe('Reference parity: FX defaults injected from synthinfo.rb', () => {
  it('echo: injects phase=0.25, decay=2, max_phase=2 when not set', () => {
    // User writes: with_fx :echo, mix: 0.2 (no phase/decay/max_phase)
    // Desktop injects synthinfo.rb defaults, then BPM-scales them.
    const result = normalizeFxParams('echo', { mix: 0.2 }, BPM)

    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
    expect(result.decay).toBeCloseTo(2 * FACTOR, 10)
    expect(result.max_phase).toBeCloseTo(2 * FACTOR, 10)
    expect(result.mix).toBe(0.2) // not a time param
  })

  it('echo: does NOT override user-provided phase', () => {
    const result = normalizeFxParams('echo', { phase: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(0.5 * FACTOR, 10) // user value, not default 0.25
  })

  it('slicer: injects phase=0.25 when not set', () => {
    const result = normalizeFxParams('slicer', { mix: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
  })

  it('wobble: injects phase=0.5 when not set', () => {
    const result = normalizeFxParams('wobble', { mix: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(0.5 * FACTOR, 10)
  })

  it('flanger: injects phase=4 when not set', () => {
    const result = normalizeFxParams('flanger', { mix: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(4 * FACTOR, 10)
  })

  it('tremolo: injects phase=4 when not set', () => {
    const result = normalizeFxParams('tremolo', { mix: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(4 * FACTOR, 10)
  })

  it('ping_pong: injects phase=0.25, max_phase=1 when not set', () => {
    const result = normalizeFxParams('ping_pong', { mix: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
    expect(result.max_phase).toBeCloseTo(1 * FACTOR, 10)
  })

  it('reverb: no time defaults injected (room/damp are not time params)', () => {
    const result = normalizeFxParams('reverb', { mix: 0.2, room: 0.5 }, BPM)
    expect(result.phase).toBeUndefined()
    expect(result.decay).toBeUndefined()
  })

  it('unknown FX: no defaults injected, params still BPM-scaled', () => {
    const result = normalizeFxParams('unknown_fx', { phase: 0.5 }, BPM)
    expect(result.phase).toBeCloseTo(0.5 * FACTOR, 10)
  })

  it('handles fx_ prefix stripping', () => {
    const result = normalizeFxParams('fx_echo', { mix: 0.2 }, BPM)
    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
  })

  it('handles sonic-pi-fx_ prefix stripping', () => {
    const result = normalizeFxParams('sonic-pi-fx_echo', { mix: 0.2 }, BPM)
    expect(result.phase).toBeCloseTo(0.25 * FACTOR, 10)
  })
})

// ---------------------------------------------------------------------------
// Parity tests: Synth normalization
// ---------------------------------------------------------------------------

describe('Reference parity: Synth params match desktop Sonic Pi', () => {
  it('BPM-scales all ADSR params tagged :bpm_scale => true', () => {
    const input: Record<string, number> = { attack: 0.1, decay: 0.2, sustain: 1, release: 0.5 }
    const result = normalizePlayParams('beep', input, BPM)

    for (const key of ['attack', 'decay', 'sustain', 'release']) {
      expect(result[key], `${key} should be BPM-scaled`).toBeCloseTo(input[key] * FACTOR, 10)
    }
  })

  it('BPM-scales all slide params', () => {
    const input: Record<string, number> = { amp_slide: 0.5, pan_slide: 0.3, note_slide: 1 }
    const result = normalizePlayParams('beep', input, BPM)

    for (const key of Object.keys(input)) {
      expect(result[key], `${key} should be BPM-scaled`).toBeCloseTo(input[key] * FACTOR, 10)
    }
  })

  it('does NOT scale non-time synth params', () => {
    // Source: synthinfo.rb — amp, note, pan, env_curve, sustain_level, etc.
    // have NO :bpm_scale tag
    const input = { amp: 0.8, note: 60, pan: -0.5, sustain_level: 0.7 }
    const result = normalizePlayParams('beep', input, BPM)

    expect(result.amp).toBe(0.8)
    expect(result.note).toBe(60)
    expect(result.pan).toBe(-0.5)
    expect(result.sustain_level).toBe(0.7)
  })

  it('env_curve is NOT BPM-scaled (it is a shape index, not time)', () => {
    // Source: synthinfo.rb — env_curve has no :bpm_scale tag
    // env_curve injection disabled (SP22 workaround) — test with explicit user value
    const result = normalizePlayParams('beep', { release: 1, env_curve: 2 }, BPM)
    expect(result.env_curve).toBe(2)      // preserved from user, not scaled
    expect(result.release).toBeCloseTo(FACTOR, 10) // scaled
  })

  it('tb303: mirrored cutoff envelope times are BPM-scaled', () => {
    // Source: synthinfo.rb TB303 — cutoff_attack/decay/sustain/release
    // all have :bpm_scale => true
    const input = { attack: 0.1, decay: 0.2, sustain: 0.5 }
    const result = normalizePlayParams('tb303', input, BPM)

    // Mirrored values should also be scaled
    expect(result.cutoff_attack).toBeCloseTo(0.1 * FACTOR, 10)
    expect(result.cutoff_decay).toBeCloseTo(0.2 * FACTOR, 10)
    expect(result.cutoff_sustain).toBeCloseTo(0.5 * FACTOR, 10)
  })
})

// ---------------------------------------------------------------------------
// Parity tests: Synth default injection (#68)
// ---------------------------------------------------------------------------

describe('Reference parity: Synth defaults injected from synthinfo.rb', () => {
  it('injects release:1 for standard synths when not set', () => {
    // play 60 at 130 BPM — no explicit release.
    // Desktop: injects release=1 (beat) → scales to 0.46s → sends explicitly.
    // Without injection: scsynth uses compiled default 1.0s → note 2.17x too long.
    const result = normalizePlayParams('beep', { note: 60 }, BPM)
    expect(result.release).toBeCloseTo(1 * FACTOR, 10)
  })

  it('does NOT override user-provided release', () => {
    const result = normalizePlayParams('beep', { note: 60, release: 2 }, BPM)
    expect(result.release).toBeCloseTo(2 * FACTOR, 10) // user value, not default 1
  })

  it('gabberkick: uses per-synth overrides (release=0.02, not 1)', () => {
    const result = normalizePlayParams('gabberkick', { note: 60 }, BPM)
    expect(result.release).toBeCloseTo(0.02 * FACTOR, 10)
    expect(result.attack).toBeCloseTo(0.001 * FACTOR, 10)
    expect(result.decay).toBeCloseTo(0.01 * FACTOR, 10)
    expect(result.sustain).toBeCloseTo(0.3 * FACTOR, 10)
  })

  it('dark_sea_horn: attack=1, release=4', () => {
    const result = normalizePlayParams('dark_sea_horn', {}, BPM)
    expect(result.attack).toBeCloseTo(1 * FACTOR, 10)
    expect(result.release).toBeCloseTo(4 * FACTOR, 10)
  })

  it('mod_saw: injects mod_phase=0.25 and release=1', () => {
    const result = normalizePlayParams('mod_saw', { note: 60 }, BPM)
    expect(result.mod_phase).toBeCloseTo(0.25 * FACTOR, 10)
    expect(result.release).toBeCloseTo(1 * FACTOR, 10)
  })

  it('sc808_bassdrum: decay=2 (no release)', () => {
    const result = normalizePlayParams('sc808_bassdrum', {}, BPM)
    expect(result.decay).toBeCloseTo(2 * FACTOR, 10)
  })

  it('at 60 BPM: defaults pass through unchanged', () => {
    const result = normalizePlayParams('beep', { note: 60 }, 60)
    expect(result.release).toBe(1) // 1 * 60/60 = 1
  })

  it('handles sonic-pi- prefix', () => {
    const result = normalizePlayParams('sonic-pi-beep', { note: 60 }, BPM)
    expect(result.release).toBeCloseTo(1 * FACTOR, 10)
  })
})

// ---------------------------------------------------------------------------
// Parity tests: Sample normalization
// ---------------------------------------------------------------------------

describe('Reference parity: Sample params match desktop Sonic Pi', () => {
  it('BPM-scales ADSR params for samples', () => {
    const input = { attack: 0.1, release: 0.5 }
    const result = normalizeSampleParams(input, BPM)

    expect(result.attack).toBeCloseTo(0.1 * FACTOR, 10)
    expect(result.release).toBeCloseTo(0.5 * FACTOR, 10)
  })

  it('does NOT scale non-time sample params', () => {
    const input = { amp: 1.5, rate: 2, lpf: 130 }
    const result = normalizeSampleParams(input, BPM)

    expect(result.amp).toBe(1.5)
    expect(result.rate).toBe(2)
    expect(result.lpf).toBe(130)
  })
})

// ---------------------------------------------------------------------------
// Parity tests: Control normalization
// ---------------------------------------------------------------------------

describe('Reference parity: Control params match desktop Sonic Pi', () => {
  it('BPM-scales time and slide params in control messages', () => {
    const input = { amp_slide: 0.5, release: 1, amp: 0.8 }
    const result = normalizeControlParams(input, BPM)

    expect(result.amp_slide).toBeCloseTo(0.5 * FACTOR, 10) // scaled
    expect(result.release).toBeCloseTo(1 * FACTOR, 10)      // scaled
    expect(result.amp).toBe(0.8)                             // NOT scaled
  })
})

// ---------------------------------------------------------------------------
// Meta-test: exhaustive check of known BPM-scale tags
// ---------------------------------------------------------------------------

describe('Reference parity: exhaustive BPM-scale tag verification', () => {
  it('every desktop-tagged FX time param IS scaled by our code', () => {
    for (const param of Object.keys(DESKTOP_FX_BPM_SCALED)) {
      const input: Record<string, number> = { [param]: 1.0 }
      const result = normalizeFxParams('echo', input, BPM)
      expect(result[param], `FX "${param}" tagged :bpm_scale=>true but NOT scaled`).toBeCloseTo(FACTOR, 8)
    }
  })

  it('every desktop-untagged FX param is NOT scaled by our code', () => {
    for (const param of Object.keys(DESKTOP_FX_NOT_SCALED)) {
      const input: Record<string, number> = { [param]: 1.0 }
      // Use 'reverb' — it has no time defaults that would conflict
      const result = normalizeFxParams('reverb', input, BPM)
      expect(result[param], `FX "${param}" has NO :bpm_scale tag but WAS scaled`).toBe(1.0)
    }
  })

  it('every desktop-tagged synth time param IS scaled by our code', () => {
    for (const param of Object.keys(DESKTOP_SYNTH_BPM_SCALED)) {
      const input: Record<string, number> = { [param]: 1.0 }
      const result = normalizePlayParams('beep', input, BPM)
      expect(result[param], `Synth "${param}" tagged :bpm_scale=>true but NOT scaled`).toBeCloseTo(FACTOR, 8)
    }
  })

  it('every desktop-untagged synth param is NOT scaled by our code', () => {
    for (const param of Object.keys(DESKTOP_SYNTH_NOT_SCALED)) {
      // env_curve gets injected as default; we test with explicit value
      const input: Record<string, number> = { [param]: 1.0 }
      const result = normalizePlayParams('beep', input, BPM)
      expect(result[param], `Synth "${param}" has NO :bpm_scale tag but WAS scaled`).toBe(1.0)
    }
  })
})
