# SuperSonic WASM Output Level — 2.3x Louder Than Desktop scsynth

## Summary

SuperSonic's scsynth WASM build produces audio at **~2.3x the RMS level** of desktop Sonic Pi's scsynth for identical code, identical samples, identical synthdefs, and identical mixer settings. This is a consistent, reproducible factor verified with proper A/B recordings using the Rec button on both platforms.

No existing issue has been filed about this in any relevant repository (searched `samaaron/supersonic`, `supercollider/supercollider`, `scsynth.org` forums — April 2026).

---

## A/B Test Data

### Test Setup
- **Code:** DJ Dave kick+clap at `use_bpm 130` (see Appendix A for exact code)
- **Desktop:** Sonic Pi (latest), recorded via built-in Rec button (DiskOut synthdef inside scsynth)
- **Web:** Sonic Pi Web (sonicpi.cc), recorded via Chromium capture tool (Web Audio MediaRecorder)
- **Samples:** Byte-identical FLAC files from `supersonic-scsynth-samples` (verified MD5 in prior research)
- **Synthdefs:** `sonic-pi-basic_stereo_player`, `sonic-pi-mixer` from `supersonic-scsynth-synthdefs@0.66.0`

### Only Drums (kick pattern, NO FX — cleanest signal)

| Metric | Desktop Sonic Pi | Sonic Pi Web | Ratio |
|--------|-----------------|-------------|-------|
| Peak | 0.6267 | 1.0000 (clipped) | 1.60x |
| RMS | 0.1881 | 0.4158 | **2.21x** |
| Clipping (>0.95) | 0.00% | 3.37% | — |
| Crest factor | 3.33 | 2.41 | 0.72x |

**Source:** `tools/audio_comparison/latest_test/only_Drums/`

### No Drums (clap + echo + reverb)

| Metric | Desktop Sonic Pi | Sonic Pi Web | Ratio |
|--------|-----------------|-------------|-------|
| Peak | 0.9832 | 1.0000 (clipped) | 1.02x |
| RMS | 0.0494 | 0.0897 | **1.82x** |
| Clipping (>0.95) | 0.00% | 0.13% | — |
| Crest factor | 19.91 | 11.15 | 0.56x |

**Source:** `tools/audio_comparison/latest_test/no_Drums/`

### Per-Second RMS Comparison (Drums)

| Second | Desktop RMS | Web RMS | Ratio |
|--------|------------|---------|-------|
| 1 | 0.169 | 0.415 | 2.46x |
| 2 | 0.207 | 0.420 | 2.03x |
| 3 | 0.180 | 0.382 | 2.13x |
| 4 | 0.211 | 0.432 | 2.05x |
| 5 | 0.204 | 0.403 | 1.97x |
| 6 | 0.205 | 0.412 | 2.01x |

The ratio is stable at **~2.0-2.5x per second** — not a transient spike, but a sustained factor.

---

## Signal Path Trace — Every Stage Verified

### Stage 1: Synth Parameter Construction

**What happens:** AudioInterpreter builds params, SoundLayer normalizes (BPM scaling, env_curve, aliasing), params sent to bridge.

**For `sample :bd_tek, amp: 1.5, cutoff: 130`:**
- After SoundLayer: `{ amp: 1.5, lpf: 130, out_bus: 0, buf: N }`
- Desktop sends: `{ amp: 1.5, lpf: 130, out_bus: <bus>, buf: N }`
- **Identical params.** No extra gain.

**Source:** `src/engine/SoundLayer.ts`, `src/engine/interpreters/AudioInterpreter.ts`

### Stage 2: OSC Message Encoding

**What happens:** Params encoded as OSC bundle, sent to scsynth WASM via `sendOSC()`.

**Verified:** OSC encoding uses standard int32/float32/string types. No amplitude transform.

**Source:** `src/engine/osc.ts`, `src/engine/SuperSonicBridge.ts:235-255`

### Stage 3: scsynth Internal Processing

**What happens inside scsynth:**
1. Buses cleared at start of each audio block (64 samples)
2. Group 100 (synths): each synth runs `Out.ar(out_bus, signal)` — **ADDITIVE** to bus
3. Group 101 (FX): FX reads private bus, `Out.ar(out_bus, signal)` — ADDITIVE to output bus
4. Mixer group: reads `In.ar(out_bus=0, 2)`, processes, `ReplaceOut.ar(0, processed)` — **REPLACES** bus 0

**Result on bus 0 after full block:** mixer's processed output (all synth contributions → mixer → ReplaceOut).

**Reference:** scsynth source code. `Out.ar` is additive, `ReplaceOut.ar` overwrites. [scsynth.org discussion on Out vs ReplaceOut](https://scsynth.org/t/replaceout-vs-out/8668)

### Stage 4: Mixer Synthdef (sonic-pi-mixer)

**Signal chain (from synthdef source, `studio.clj`):**
```
In.ar(out_bus=0) + In.ar(in_bus=private_silence)
  → pre_amp (0.2)
  → HPF (22 MIDI ≈ 29Hz)
  → LPF (135.5 MIDI ≈ 19912Hz)
  → Limiter.ar(signal, 0.99, 0.01)   ← 10ms lookahead brickwall
  → LeakDC.ar(signal)
  → amp (6)
  → clip2(signal, 1)                 ← hard clip at ±1.0
  → HPF 10Hz + LPF 20500Hz (safety)
  → ReplaceOut.ar(out_bus=0)
```

**Effective gain:** `pre_amp(0.2) × amp(6) = 1.2x`

**Our settings match desktop exactly:**
```typescript
this.sonic.send('/s_new', 'sonic-pi-mixer', this.mixerNodeId, 0, mixerGroupId,
  'out_bus', 0,       // explicit
  'in_bus', mixerBus, // private bus (silence)
  'amp', 6,           // Sonic Pi default
  'pre_amp', 0.2,     // Sonic Pi default: set_volume!(1) → 1 * 0.2
)
```

**Verified alive:** Setting `amp=1` reduced RMS from 0.41 → 0.074 (6x reduction, matching 6x amp change). The mixer IS processing.

**Source:** `artifacts/ref/RESEARCH_SONIC_PI_DEEP_INTERNALS.md` section 3, `src/engine/SuperSonicBridge.ts:162-175`

### Stage 5: WASM → AudioWorklet Output

**What happens:** scsynth WASM writes processed audio to output bus memory. The AudioWorklet processor reads this memory and copies to Web Audio output channels.

**Verified from source code** (`supersonic-scsynth-core@0.66.0/workers/scsynth_audio_worklet.js`):
```javascript
// Reads scsynth output bus pointer from WASM
let n = this.wasmInstance.exports.get_audio_output_bus(),
    E = this.wasmInstance.exports.get_audio_buffer_samples();
// Creates Float32Array view directly over WASM memory
this.audioView = new Float32Array(S, n, E*a);
// Direct copy to Web Audio output — NO multiplication, NO scaling
for(let u = 0; u < a; u++)
    e[0][u].set(this.channelViews[u]);
```

**Finding: ZERO gain applied.** Direct `.set()` copy from WASM Float32Array to Web Audio output buffers. No multiplication, normalization, clamping, or any transform.

**Source:** [scsynth_audio_worklet.js on unpkg](https://unpkg.com/supersonic-scsynth-core@latest/workers/scsynth_audio_worklet.js)

### Stage 6: Web Audio Chain

```
AudioWorkletNode (scsynth output, 14 channels)
  → ChannelSplitter(14)
  → ChannelMerger(2) ← only channels 0-1 connected (bus 0 = mixer output)
  → AnalyserNode (passive, fftSize=2048)
  → GainNode (value = 1.0)
  → audioCtx.destination (speakers / recorder)
```

**Each node verified:**
- **ChannelMerger:** Unity-gain pass-through per [MDN Web Audio spec](https://developer.mozilla.org/en-US/docs/Web/API/ChannelMergerNode). Only 2 inputs connected (bus 0 L+R). No summing of multiple sources.
- **AnalyserNode:** Purely passive — reads audio for visualization, does not modify signal.
- **GainNode:** `value = 1.0` (default, no additional gain).

**Source:** `src/engine/SuperSonicBridge.ts:182-208`, [MDN ChannelMergerNode docs](https://developer.mozilla.org/en-US/docs/Web/API/ChannelMergerNode)

### Stage 7: Recording

- **Desktop:** `sonic-pi-recorder` synthdef uses `DiskOut` to write bus 0 directly to disk. Captures AFTER mixer's `ReplaceOut`. Not affected by `safetyClipThreshold`.
- **Web:** Chromium's Rec button → `MediaRecorder` taps from Web Audio chain (after GainNode). Captures the same signal that reaches speakers.

Both recording methods capture post-mixer audio. Neither introduces gain.

**Reference for DiskOut not affected by safety clip:** [PR #5110 discussion](https://github.com/supercollider/supercollider/pull/5110) — "Although clipping affects inter-app routing (as it happens through the same out busses), it doesn't affect recording."

---

## Reverse-Engineered Raw Signal Levels

### From amp=1 mixer test (empirical)
```
Mixer with amp=1, pre_amp=0.2:
  Output RMS = 0.074
  → raw_signal_rms = output / (pre_amp × amp) = 0.074 / (0.2 × 1) = 0.37
```

### From desktop output (calculated)
```
Desktop output RMS = 0.1881, peak = 0.6267
Mixer gain = pre_amp × amp = 0.2 × 6 = 1.2
Desktop peak < 1.0 → clip2 not triggered → limiter not triggered
  → raw_peak = output_peak / gain = 0.6267 / 1.2 = 0.5223
  → raw_rms ≈ output_rms / gain = 0.1881 / 1.2 = 0.1567
```

### Comparison
| Metric | Desktop Raw | Web Raw | Ratio |
|--------|------------|---------|-------|
| Peak | 0.52 | >0.84 (limiter triggers) | >1.6x |
| RMS | 0.16 | 0.37 | **2.36x** |

**Same sample (bd_tek), same amp (1.5), same synthdef (basic_stereo_player).** The scsynth WASM internal output is 2.3x louder.

---

## Eliminated Hypotheses

### ❌ Recording method artifact
**Disproven.** Both recordings use platform Rec buttons (DiskOut on desktop, MediaRecorder on web). The A/B test uses properly matched recordings from the user's own testing.

### ❌ Web Audio chain adds gain
**Disproven.** ChannelMerger is unity-gain (MDN spec). AnalyserNode is passive. GainNode = 1.0. Verified from source code.

### ❌ AudioWorklet applies scaling
**Disproven.** Verified from `scsynth_audio_worklet.js` source: direct `.set()` copy, zero arithmetic on samples.

### ❌ Mixer settings differ
**Disproven.** pre_amp=0.2, amp=6 on both platforms. Verified mixer is alive via amp=1 test (RMS drops 6x).

### ❌ SuperCollider Volume class
**Disproven.** [Volume class docs](https://doc.sccode.org/Classes/Volume.html): only creates a synth when volume ≠ 0dB. At default 0dB, inactive. Sonic Pi uses its own mixer, not the SC Volume class.

### ❌ safetyClipThreshold reduces desktop volume
**Disproven.** [ServerOptions docs](https://doc.sccode.org/Classes/ServerOptions.html): default 1.26 CLIPS signals ABOVE 1.26. Does not reduce signals below 1.0. And per [PR #5110](https://github.com/supercollider/supercollider/pull/5110): doesn't affect recording. macOS CoreAudioDriver only — WASM has no CoreAudio.

### ❌ numOutputBusChannels affects level
**Disproven.** [ServerOptions docs](https://doc.sccode.org/Classes/ServerOptions.html): controls channel count only, no effect on signal level.

### ❌ Sample rate conversion changes amplitude
**Disproven.** [scsynth.org discussion](https://scsynth.org/t/using-samples-with-different-rates-48000hz-vs-44-1khz/10354): BufRateScale adjusts pitch, not amplitude. Cubic interpolation is gain-neutral.

### ❌ Different synth parameters sent
**Disproven.** Traced end-to-end through SoundLayer → AudioInterpreter → SuperSonicBridge → OSC encoding. Same params: `amp: 1.5, lpf: 130, out_bus: 0, buf: N`.

### ❌ basic_stereo_player has hidden gain
**Disproven.** Verified from [samplers.clj source](https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/synthdefs/designs/overtone/sonic-pi/src/sonic_pi/samplers.clj): no `pre_amp`, single `amp` multiplication via `balance2` / `pan2`. No additional gain stages.

---

## Most Likely Root Cause

### Emscripten WASM Audio Output Has No Implicit Normalization

The [Emscripten Wasm Audio Worklets documentation](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html) contains an explicit warning:

> **"Warning: scale down audio volume by factor of 0.2, raw noise can be really loud otherwise"**

Desktop scsynth outputs through native audio drivers (CoreAudio on macOS, JACK/ALSA on Linux) which may apply:
1. **Output normalization** — driver-level gain adjustment
2. **Sample format conversion** — int16/int32 ↔ float32 conversion with implicit scaling
3. **Buffer management** — driver-managed output buffers with potential level adjustment

SuperSonic's WASM build bypasses ALL native audio drivers. The scsynth WASM writes float32 samples directly to a memory buffer, and the AudioWorklet copies them verbatim to Web Audio output. No driver-level processing occurs.

**The 2.3x factor likely originates from a difference in how scsynth's internal float32 output maps to the final audio output path:**
- **Desktop:** scsynth → CoreAudio driver → hardware (driver may normalize/attenuate)
- **WASM:** scsynth → WASM memory → Float32Array → Web Audio (raw, no attenuation)

### Unverifiable Without scsynth Source Access

The exact mechanism is inside the scsynth binary — either in:
1. The hardware output bus rendering code (which differs between native and WASM)
2. The `World_Run()` output stage (may have platform-specific scaling)
3. The compiled synthdef behavior (synthdefs from npm may differ from desktop's compiled binaries)

Verifying this requires access to SuperSonic's C++ source and the WASM build configuration, which is not publicly documented at the level needed.

---

## Impact on Sonic Pi Web

| Effect | Detail |
|--------|--------|
| **Louder output** | ~2.3x RMS vs desktop for same code |
| **More clipping** | 3.4% vs 0.01% — mixer's clip2(1) triggers frequently |
| **Less dynamic range** | Crest factor 2.41 vs 3.33 — transients are squashed by clipping |
| **Different tonal character** | Clipping introduces harmonics, changes envelope shape |

---

## Recommended Fix

### Interim: Mixer gain compensation

Adjust `pre_amp` to compensate for the 2.3x hotter raw signal:

```
Desktop effective gain: pre_amp(0.2) × amp(6) = 1.2
Needed effective gain:  1.2 / 2.3 = 0.52
→ pre_amp = 0.52 / 6 ≈ 0.087
```

This produces equivalent output levels to desktop without changing any other behavior.

### Proper: File issue on SuperSonic

Report the finding with A/B WAV data. The fix belongs in either:
- The AudioWorklet processor (apply 0.43x output scaling)
- The scsynth WASM build (match desktop output levels)
- A documented `outputGain` constructor option for SuperSonic users

---

## Appendix A: Test Code

### Only Drums
```ruby
use_bpm 130

live_loop :met1 do
  sleep 1
end

cmaster1 = 130
cmaster2 = 130

define :pattern do |pattern|
  return pattern.ring.tick == "x"
end

live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern "x--x--x---x--x--"
  sleep 0.25
end
```

### No Drums (clap + FX)
```ruby
use_bpm 130

live_loop :met1 do
  sleep 1
end

cmaster1 = 130
cmaster2 = 130

define :pattern do |pattern|
  return pattern.ring.tick == "x"
end

with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sample :drum_snare_hard, rate: 2.2, start: 0.02, cutoff: cmaster1, pan: 0.2, amp: a
      sample :drum_snare_hard, rate: 2, start: 0.04, cutoff: cmaster1, pan: -0.2, amp: a
      sleep 1
    end
  end
end
```

## Appendix B: Versions

| Component | Version |
|-----------|---------|
| supersonic-scsynth | 0.66.0 |
| supersonic-scsynth-core | latest (0.66.0) |
| supersonic-scsynth-synthdefs | 0.66.0 |
| supersonic-scsynth-samples | latest |
| Sonic Pi (desktop) | latest stable |
| Browser | Chromium (Playwright) |
| AudioContext sampleRate | 48000 Hz |

## Appendix C: File Locations

| File | Description |
|------|-------------|
| `tools/audio_comparison/latest_test/only_Drums/` | A/B WAVs + code for drums test |
| `tools/audio_comparison/latest_test/no_Drums/` | A/B WAVs + code for clap test |
| `tools/audio_comparison/OriginalSonicPi.wav` | Earlier desktop reference (full DJ Dave code) |
| `.captures/` | All Web capture WAVs with timestamps |
