# Known Limitations

Current known limitations and browser-specific behaviors for Sonic Pi Web.

## Browser Requirements

- **Chrome/Edge/Firefox** required — Safari has limited Web Audio and no Web MIDI support
- **HTTPS required** for microphone access (`live_audio`) in production deployments
- **User gesture required** to start audio — click Run or any button first (browser autoplay policy)
- **Tab backgrounding** — browser may suspend the AudioContext when the tab is not visible; audio resumes automatically when the tab returns to focus

## Audio Engine

- Audio runs via **SuperSonic** (scsynth compiled to WebAssembly), loaded from CDN at runtime
- **Offline use is not supported** — requires CDN access for SuperSonic WASM, SynthDefs, and samples
- **14 output channels** (2 master + 6 stereo track buses)
- SynthDefs are **lazy-loaded** on first use — slight delay on first `use_synth :prophet` or similar
- Samples are **lazy-loaded** from CDN on first use — ~100-500ms download on first `sample :bd_haus`
- Audio latency varies by browser and OS (~5-20ms typical, reported in console on startup)

## DSL Differences from Desktop Sonic Pi

- **`osc` / `osc_send`**: Hook-based — the engine emits OSC messages, but the host app must provide a transport (e.g., WebSocket-to-UDP bridge). Without a handler, messages are logged with a warning
- **`use_timing_guarantees`**: Not implemented (test-only feature in desktop Sonic Pi)
- **`sound_out` FX**: Not available
- **MIDI**: Requires Web MIDI API (Chrome/Edge only) — not available in Firefox or Safari
- **Recording**: Captures to WAV via MediaRecorder — quality depends on browser implementation
- **Timing**: Virtual time scheduling provides beat-accurate sequencing, but audio output latency varies by browser/OS
- **Custom samples**: Upload support is experimental — built-in samples (197 from desktop Sonic Pi) are loaded from CDN by default
- **Variable name `b`**: Avoid assigning to a variable named `b` at top level — the transpiler uses `__b` for the internal ProgramBuilder reference, but any variable shadowing in bare code scopes can conflict with DSL infrastructure. Use longer names like `bass`, `beat`, etc.
- **Ruby Array methods not supported**: `.zip(other)` and `.each_with_index` are not implemented. Use manual iteration with `.length.times do |i|` and index access `arr[i]` as a workaround. See #154.

## Audio Fidelity vs Desktop Sonic Pi

The same composition will sound recognizably similar but not bit-identical to desktop Sonic Pi. Most differences come from running scsynth in WebAssembly (no native audio drivers, fixed AudioWorklet block size, 32-bit FP) and choices made to keep the browser engine stable.

### Envelope shape — linear instead of exponential

- Sonic Pi defaults envelope-driven synths to `env_curve: 2` (exponential). We use `env_curve: 1` (linear) because exponential triggers a WASM scsynth bug at small attack values (silence on isolated synths, 1-sample δ-spike on overlapping ones).
- **Audible difference:** sustained notes hold their level longer through the release phase. Most noticeable on pads, drones, ambient music, and long-release leads. Drum/percussion and short staccato lines are essentially unaffected.
- **Workaround for users:** if you want a softer release on a specific synth, pass `attack: 0.01` or higher and re-enable the curve via `env_curve: 2` explicitly per-note (this works once attack ≥ 10ms).

### Per-synth loudness divergence

- Synth output levels diverge from desktop Sonic Pi by anywhere from 0.30× to 4.20× depending on the synth. Examples (measured 2026-05-04 against Sonic Pi.app on the same composition):
  - `:prophet` runs ~1.78× louder
  - `:pluck` runs ~0.51× quieter
  - Drum samples (`:bd_haus`, `:drum_cymbal_closed`) within ~2% of desktop
- Mixer levels (`pre_amp`, `amp`) are calibrated for browser playback (no native driver attenuation), following the Sonic Tau reference rather than raw desktop Sonic Pi values.
- **Workaround for users:** adjust master volume when porting compositions from desktop, and use `amp:` per-synth to fine-tune.
- Tracking: a per-synth amp calibration phase is planned but deferred. Issue: [#268](https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/268).

### FX coverage

- 40 FX are wired end-to-end. The full A/B WAV-verify sweep (`tools/fx-sweep.ts`) categorizes them as: **9 PASS · 29 FLAG · 0 FAIL · 2 INCONCLUSIVE**. No FX produces silence or wrong audio on web — every wired FX routes signal. Differences against Desktop SP are level / spectral-shape divergences, not engine bugs.
  - **PASS (9)**: `reverb`, `ping_pong`, `slicer`, `panslicer`, `tremolo`, `wobble`, `flanger`, `rlpf`, `lpf` — within RMS ratio [0.5, 2.0] AND spectral L2 ≤ 25 dB.
  - **FLAG (29)**: spectral shape diverges (most often L2 ~26-34 dB) or RMS / peak outside the tolerance band. Audible signal, but not bit-for-bit parity. See [#273](https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/273) for the audit roadmap.
  - **Filter-family gain gap**: notch filters (`n*pf`) are 0.35-0.40× quieter on web; `bpf`/`rbpf` are 2.5× louder. Tracked in [#272](https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/272).
  - **INCONCLUSIVE (2)**: `delay`, `chorus` produce silence on Desktop SP 4.6 — comparator can't evaluate parity until that's understood. Web side is fine. Tracked in [#274](https://github.com/MrityunjayBhardwaj/SonicPi.js/issues/274).
- Run `npx tsx tools/fx-sweep.ts` against any branch to regenerate `.captures/fx-baseline.json` and diff.

### Specific synths/samples with known issues

- A small number of upstream synthdef binaries are missing from `supersonic-scsynth-synthdefs` and not loadable on web (`dark_sea_horn`, `singer`, `winwood_lead`). Tracking upstream at [samaaron/supersonic#7](https://github.com/samaaron/supersonic/issues/7).

## Performance

- **Infinite loop detection**: Loops without `sleep` are stopped after 100,000 iterations to prevent browser tab freeze
- **Sample loading**: First use of a sample triggers CDN download (cached afterward)
- **Hot-swap**: Code changes via re-Run apply at the next loop iteration boundary (no audible gap)
- **Schedule-ahead buffer**: 300ms lookahead for sample-accurate timing (configurable in `config.ts`)

## Not Yet Implemented

- `use_timing_guarantees`
- `sound_out` FX
- Multi-channel audio output routing beyond 6 stereo track buses
- Built-in WebSocket-to-UDP bridge for `osc_send` (hook exists, transport not bundled)
