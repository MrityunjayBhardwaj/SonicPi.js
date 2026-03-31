/**
 * SoundLayer — parameter normalization pipeline.
 *
 * Mirrors Sonic Pi's sound.rb (4000+ lines). All parameter transforms
 * consolidated here: symbol resolution, default injection, aliasing,
 * synth-specific munging, BPM time scaling.
 *
 * Pipeline order (matches sound.rb):
 *   1. Strip non-scsynth params (on:)
 *   2. Resolve symbol references (decay_level: :sustain_level)
 *   3. Inject mandatory defaults (env_curve: 2)
 *   4. Alias param names (cutoff → lpf for samples/sc808)
 *   5. Synth-specific munging (tb303 envelope mirroring)
 *   6. BPM time scaling (LAST — after all values are final)
 *
 * SuperSonicBridge is pure OSC transport. This module owns all transforms.
 */

// ---------------------------------------------------------------------------
// Time params — ALLOWLIST (only these get BPM-scaled)
// ---------------------------------------------------------------------------

/** Params that represent time durations. Scaled by 60/BPM before sending to scsynth. */
const TIME_PARAMS = new Set([
  // ADSR envelope
  'attack', 'decay', 'sustain', 'release',
  // ADSR slide times
  'attack_slide', 'decay_slide', 'sustain_slide', 'release_slide',
  // General slide times
  'amp_slide', 'pan_slide', 'cutoff_slide', 'lpf_slide', 'hpf_slide',
  'res_slide', 'note_slide', 'pitch_slide',
  // tb303 filter envelope
  'cutoff_attack', 'cutoff_decay', 'cutoff_sustain', 'cutoff_release',
])

// ---------------------------------------------------------------------------
// Symbol defaults — resolve cross-parameter references
// ---------------------------------------------------------------------------

/**
 * Sonic Pi's synthinfo.rb declares symbolic defaults like:
 *   decay_level: :sustain_level
 * Meaning: if user doesn't set decay_level, use sustain_level's value.
 *
 * This applies to ALL synths with ADSR envelopes (37+).
 * Without resolution, decay_level uses the compiled default (1.0)
 * even when sustain_level is 0.5 — creating a wrong envelope shape.
 */
const SYMBOL_DEFAULTS: Array<[string, string]> = [
  ['decay_level', 'sustain_level'],
]

// ---------------------------------------------------------------------------
// Non-scsynth params to strip
// ---------------------------------------------------------------------------

/** Params that Sonic Pi uses internally but scsynth doesn't recognize. */
const STRIP_PARAMS = new Set([
  'on',           // conditional trigger flag — should_trigger? mutates args_h
  'slide',        // global slide propagation (not an scsynth param)
  'beat_stretch', // handled by translateSampleOpts before this stage
  'pitch_stretch',
  'rpitch',
])

// ---------------------------------------------------------------------------
// Synth-specific aliases (munge_opts)
// ---------------------------------------------------------------------------

/** Per-synth parameter aliasing — matches Sonic Pi's munge_opts per synthinfo class. */
const SYNTH_ALIASES: Record<string, Array<[string, string]>> = {
  sc808_snare: [['cutoff', 'lpf']],
  sc808_clap: [['cutoff', 'lpf']],
  dpulse: [['dpulse_width', 'pulse_width']],
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize synth params for play().
 * Full pipeline: strip → resolve → defaults → alias → munge → BPM scale.
 */
export function normalizePlayParams(
  synthName: string,
  params: Record<string, number>,
  bpm: number,
): Record<string, number> {
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = resolveSymbolDefaults(p)
  p = injectMandatoryDefaults(p)
  p = aliasSynthParams(synthName, p)
  p = mungeSynthOpts(synthName, p)
  p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize sample params.
 * Sample-specific transforms (beat_stretch, cutoff→lpf) + BPM scaling.
 * Called by SuperSonicBridge.playSample after translateSampleOpts.
 */
export function normalizeSampleParams(
  params: Record<string, number>,
  bpm: number,
): Record<string, number> {
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = injectSampleDefaults(p)
  p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize control message params.
 * Only strip + BPM scale. No symbol resolution (synth already running),
 * no defaults (already set at creation), no aliasing (already applied).
 */
export function normalizeControlParams(
  params: Record<string, number>,
  bpm: number,
): Record<string, number> {
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = scaleTimeParamsToBpm(p, bpm)
  return p
}

/**
 * Normalize FX params.
 * Strip + resolve symbols. NO BPM scaling (Sonic Pi passes arg_bpm_scaling: false for FX).
 * Matches desktop Sonic Pi's trigger_fx which calls normalise_and_resolve_synth_args
 * with bpm_scaling disabled.
 */
export function normalizeFxParams(
  params: Record<string, number>,
): Record<string, number> {
  let p = { ...params }
  p = stripNonScynthParams(p)
  p = resolveSymbolDefaults(p)
  return p
}

// ---------------------------------------------------------------------------
// Internal pipeline steps
// ---------------------------------------------------------------------------

/** Step 1: Remove params that scsynth doesn't recognize. */
function stripNonScynthParams(params: Record<string, number>): Record<string, number> {
  for (const key of STRIP_PARAMS) {
    if (key in params) {
      const p = { ...params }
      for (const k of STRIP_PARAMS) delete p[k]
      return p
    }
  }
  return params
}

/**
 * Step 2: Resolve symbolic defaults.
 * decay_level: :sustain_level → if sustain_level is set and decay_level isn't,
 * copy sustain_level's value to decay_level.
 */
function resolveSymbolDefaults(params: Record<string, number>): Record<string, number> {
  let p = params
  for (const [param, targetParam] of SYMBOL_DEFAULTS) {
    if (!(param in p) && targetParam in p) {
      if (p === params) p = { ...params }
      p[param] = p[targetParam]
    }
  }
  return p
}

/**
 * Step 3: Inject mandatory defaults that differ from compiled synthdef defaults.
 * env_curve: compiled default is 1 (linear), Sonic Pi sends 2 (exponential).
 */
function injectMandatoryDefaults(params: Record<string, number>): Record<string, number> {
  if ('env_curve' in params) return params
  return { ...params, env_curve: 2 }
}

/** Step 3 (samples): Inject env_curve for stereo_player (envelope player). */
function injectSampleDefaults(params: Record<string, number>): Record<string, number> {
  // basic_stereo_player has no envelope — env_curve not applicable.
  // stereo_player has an envelope — inject env_curve: 2 if not set.
  // We can't know the player here (selected later by bridge), so we inject
  // only if ADSR params are present (indicating stereo_player will be used).
  const hasEnvelope = 'attack' in params || 'decay' in params ||
    'sustain' in params || 'release' in params
  if (hasEnvelope) {
    const p = { ...params }
    if (!('env_curve' in p)) p.env_curve = 2
    if (!('pre_amp' in p)) p.pre_amp = 1
    return p
  }
  return params
}

/** Step 4: Per-synth parameter aliasing (cutoff → lpf, etc.). */
function aliasSynthParams(
  synthName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = synthName.replace(/^sonic-pi-/, '')
  const aliases = SYNTH_ALIASES[name]
  if (!aliases) return params

  let p = params
  for (const [from, to] of aliases) {
    if (from in p && !(to in p)) {
      if (p === params) p = { ...params }
      p[to] = p[from]
      delete p[from]
    }
  }
  return p
}

/**
 * Step 5: Synth-specific munging.
 * tb303: mirror amplitude envelope → filter envelope.
 */
function mungeSynthOpts(
  synthName: string,
  params: Record<string, number>,
): Record<string, number> {
  const name = synthName.replace(/^sonic-pi-/, '')

  if (name === 'tb303') {
    const p = { ...params }
    // Mirror amplitude envelope → filter envelope (only if not explicitly set)
    if (p.attack != null && p.cutoff_attack == null) p.cutoff_attack = p.attack
    if (p.decay != null && p.cutoff_decay == null) p.cutoff_decay = p.decay
    if (p.sustain != null && p.cutoff_sustain == null) p.cutoff_sustain = p.sustain
    if (p.release != null && p.cutoff_release == null) p.cutoff_release = p.release
    // tb303 Sonic Pi default: cutoff_min 30
    if (p.cutoff_min == null) p.cutoff_min = 30
    return p
  }

  return params
}

/**
 * Step 6: Scale time-based params by 60/BPM.
 * At BPM 130, release:1 (1 beat) becomes 0.4615 seconds.
 * Only params in the TIME_PARAMS allowlist are scaled.
 * FX params are NOT scaled (Sonic Pi passes arg_bpm_scaling: false for FX).
 */
function scaleTimeParamsToBpm(
  params: Record<string, number>,
  bpm: number,
): Record<string, number> {
  if (bpm === 60) return params // identity — no scaling needed

  const factor = 60 / bpm
  let p = params
  for (const key of TIME_PARAMS) {
    if (key in p) {
      // Guard: negative values are sentinels (e.g., sustain: -1 = "play full duration").
      // Don't scale sentinels — synthdef interprets them specially.
      if (p[key] < 0) continue
      if (p === params) p = { ...params }
      p[key] = p[key] * factor
    }
  }
  return p
}

// ---------------------------------------------------------------------------
// Sample player selection — moved from SuperSonicBridge
// ---------------------------------------------------------------------------

/** Complex opts that require stereo_player instead of basic_stereo_player. */
const COMPLEX_SAMPLE_KEYS = new Set(['pitch', 'compress', 'norm', 'window_size', 'start', 'finish'])

/**
 * Select the appropriate sample player synthdef.
 * basic_stereo_player for simple opts, stereo_player for complex.
 */
export function selectSamplePlayer(opts?: Record<string, number>): string {
  if (opts && Array.from(COMPLEX_SAMPLE_KEYS).some(k => k in opts)) {
    return 'sonic-pi-stereo_player'
  }
  return 'sonic-pi-basic_stereo_player'
}
