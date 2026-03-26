/**
 * Per-synth and per-FX parameter catalogs.
 *
 * This is documentation data for error messages and future autocomplete.
 * It is NOT used in the hot path (ProgramBuilder / scheduler).
 *
 * _common entries list parameters shared by most synths/FX.
 * Synth-specific entries list ADDITIONAL params beyond _common.
 */

export const SYNTH_PARAMS: Record<string, string[]> = {
  // Common params shared by most synths
  _common: [
    'note', 'amp', 'pan',
    'attack', 'decay', 'sustain', 'release',
    'attack_level', 'decay_level', 'sustain_level',
    'note_slide', 'amp_slide', 'pan_slide',
    'cutoff', 'cutoff_slide', 'res',
  ],

  // Synth-specific additions (empty = uses only common)
  beep: [],
  saw: [],
  sine: [],
  square: [],
  tri: [],
  pulse: ['pulse_width', 'pulse_width_slide'],
  noise: [],
  pnoise: [],
  bnoise: [],
  gnoise: [],
  cnoise: [],
  prophet: [],
  tb303: ['wave', 'pulse_width', 'pulse_width_slide'],
  supersaw: ['detune', 'detune_slide'],
  dsaw: ['detune', 'detune_slide'],
  dpulse: ['detune', 'detune_slide', 'pulse_width', 'pulse_width_slide'],
  dtri: ['detune', 'detune_slide'],
  pluck: ['noise_amp', 'max_delay_time', 'pluck_decay'],
  pretty_bell: [],
  piano: ['vel', 'hard', 'stereo_width'],
  fm: ['divisor', 'depth', 'depth_slide', 'divisor_slide'],
  mod_fm: ['divisor', 'depth', 'depth_slide', 'divisor_slide', 'mod_phase', 'mod_range', 'mod_phase_slide'],
  mod_saw: ['mod_phase', 'mod_range', 'mod_phase_slide', 'mod_width'],
  mod_pulse: ['mod_phase', 'mod_range', 'mod_phase_slide', 'mod_width', 'pulse_width', 'pulse_width_slide'],
  mod_tri: ['mod_phase', 'mod_range', 'mod_phase_slide', 'mod_width'],
  chipbass: [],
  chiplead: ['width'],
  chipnoise: ['freq_band'],
  dark_ambience: ['ring', 'room', 'reverb_time'],
  hollow: ['noise', 'norm'],
  growl: [],
  zawa: ['wave', 'phase', 'phase_offset', 'invert_wave', 'range', 'disable_wave'],
  blade: ['vibrato_rate', 'vibrato_depth', 'vibrato_delay', 'vibrato_onset'],
  tech_saws: [],
  sound_in: ['input'],
  sound_in_stereo: ['input'],
}

export const FX_PARAMS: Record<string, string[]> = {
  // Common params shared by most FX
  _common: ['amp', 'amp_slide', 'mix', 'mix_slide', 'pre_amp', 'pre_amp_slide'],

  // FX-specific additions
  reverb: ['room', 'room_slide', 'damp', 'damp_slide'],
  echo: ['phase', 'phase_slide', 'decay', 'decay_slide', 'max_phase'],
  delay: ['phase', 'phase_slide', 'decay', 'decay_slide', 'max_phase'],
  distortion: ['distort', 'distort_slide'],
  slicer: ['phase', 'phase_slide', 'wave', 'pulse_width', 'smooth', 'probability'],
  wobble: ['phase', 'phase_slide', 'wave', 'cutoff_min', 'cutoff_max', 'res'],
  ixi_techno: ['phase', 'phase_slide', 'cutoff_min', 'cutoff_max', 'res'],
  compressor: ['threshold', 'clamp_time', 'slope_above', 'slope_below', 'relax_time'],
  rlpf: ['cutoff', 'cutoff_slide', 'res', 'res_slide'],
  rhpf: ['cutoff', 'cutoff_slide', 'res', 'res_slide'],
  hpf: ['cutoff', 'cutoff_slide'],
  lpf: ['cutoff', 'cutoff_slide'],
  normaliser: ['level', 'level_slide'],
  pan: ['pan', 'pan_slide'],
  band_eq: ['freq', 'freq_slide', 'res', 'res_slide', 'db', 'db_slide'],
  flanger: ['phase', 'phase_slide', 'wave', 'depth', 'decay', 'feedback', 'delay'],
  krush: ['cutoff', 'cutoff_slide', 'res', 'res_slide', 'gain', 'gain_slide'],
  bitcrusher: ['sample_rate', 'sample_rate_slide', 'bits', 'bits_slide', 'cutoff', 'cutoff_slide'],
  ring_mod: ['freq', 'freq_slide', 'mod_amp', 'mod_amp_slide'],
  chorus: ['phase', 'phase_slide', 'decay', 'max_phase'],
  octaver: ['super_amp', 'sub_amp', 'subsub_amp'],
  vowel: ['vowel_sound', 'voice'],
  tanh: ['krunch', 'krunch_slide'],
  gverb: ['spread', 'spread_slide', 'damp', 'damp_slide', 'room', 'release', 'ref_level', 'tail_level'],
  pitch_shift: ['pitch', 'pitch_slide', 'window_size', 'pitch_dis', 'time_dis'],
  whammy: ['transpose', 'transpose_slide', 'max_delay_time', 'deltime', 'grainsize'],
  tremolo: ['phase', 'phase_slide', 'wave', 'depth', 'depth_slide'],
  record: ['buffer'],
  sound_out: ['output'],
  sound_out_stereo: ['output'],
  level: [],
  mono: [],
  autotuner: ['note'],
}

/**
 * Get all valid parameters for a given synth name.
 * Returns common params merged with synth-specific params.
 */
export function getSynthParams(synthName: string): string[] {
  const common = SYNTH_PARAMS._common ?? []
  const specific = SYNTH_PARAMS[synthName] ?? []
  return [...common, ...specific]
}

/**
 * Get all valid parameters for a given FX name.
 * Returns common params merged with FX-specific params.
 */
export function getFxParams(fxName: string): string[] {
  const common = FX_PARAMS._common ?? []
  const specific = FX_PARAMS[fxName] ?? []
  return [...common, ...specific]
}
