/**
 * Canonical list of FX synthdef names available in Sonic Web.
 *
 * Sourced from synthinfo.rb FX classes (desktop Sonic Pi). Each entry maps to
 * a `sonic-pi-fx_<name>.scsyndef` binary on the SuperSonic CDN. Loaded on demand
 * via `SuperSonicBridge.ensureSynthDefLoaded`, or in bulk via
 * `SuperSonicBridge.preloadFxSynthDefs` (called from engine.init for warm start).
 *
 * Single source of truth — consumed by the DSL `fx_names` introspector
 * (`SonicPiEngine.ts:fx_names_fn`) AND the bridge preloader. Adding an FX here
 * makes it both queryable AND eagerly loaded on engine init.
 */
// NOTE on omissions (issue #301):
// `delay` and `chorus` exist in desktop Sonic Pi's synthinfo.rb FX classes
// but are NOT shipped in the `supersonic-scsynth-synthdefs` CDN package —
// verified 404 across versions 0.57.0 through 0.66.0 (latest). Including them
// here would make `with_fx :delay` / `with_fx :chorus` fail at /s_new dispatch
// with a 404 + CORS console error and silent FX skip. Until the upstream
// package ships them:
//   - users wanting delay should use `:echo` (similar character, different params)
//   - users wanting chorus can approximate via `:flanger` or `:ring_mod`
// FriendlyErrors.KNOWN_FX is kept in sync (same omissions) so the
// "did-you-mean" suggester won't recommend names that won't resolve.
export const ALL_FX_NAMES: readonly string[] = [
  'reverb','echo','distortion','slicer','wobble','ixi_techno',
  'compressor','rlpf','rhpf','hpf','lpf','normaliser','pan','band_eq',
  'flanger','krush','bitcrusher','ring_mod','octaver','vowel',
  'tanh','gverb','pitch_shift','whammy','tremolo','level','mono',
  'ping_pong','panslicer',
  // Filter variants — from synthinfo.rb FX classes
  'bpf','rbpf','nbpf','nrbpf','nlpf','nrlpf','nhpf','nrhpf','eq',
] as const
