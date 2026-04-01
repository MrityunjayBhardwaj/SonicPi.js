# Raw OSC Isolation Test Results

**Date:** 2026-04-01T06:33:16.259Z
**Branch:** feat/osc-bundle-timestamps

## Purpose

This test BYPASSES the entire Sonic Pi Web engine (no SonicPiEngine, no SoundLayer,
no AudioInterpreter, no ProgramBuilder). It loads SuperSonic directly from CDN and
sends raw OSC commands with desktop-identical settings.

If the output is still ~2.3x louder, SuperSonic WASM is the source.
If the output matches desktop, our engine is adding gain.

## Test Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| pre_amp | 0.2 | Desktop default (NOT compensated) |
| amp | 6 | Desktop default |
| Sample | bd_tek | Same as desktop reference |
| Synthdef | basic_stereo_player | Same as desktop |
| BPM | 130 | Same as desktop |
| Pattern | x--x--x---x--x-- | Same as desktop |
| amp (synth) | 1.5 | Same as desktop |
| lpf (cutoff) | 130 | Same as desktop |
| out_bus | 0 | Same as desktop |

## Results

### Raw OSC Test (WASM, desktop settings)

| Metric | Value |
|--------|-------|
| Duration | 9.47s |
| Peak | 1.0000 |
| RMS | 0.3604 |
| Clipping (>0.95) | 2.69% |

### Desktop Reference (original Sonic Pi)

| Metric | Value |
|--------|-------|
| Duration | 11.31s |
| Peak | 0.6267 |
| RMS | 0.1881 |
| Clipping (>0.95) | 0.00% |

### Comparison

| Metric | Ratio (WASM / Desktop) |
|--------|----------------------|
| RMS | **1.92x** |
| Peak | **1.60x** |

### Per-Second RMS

| Second | WASM RMS | Desktop RMS | Ratio |
|--------|----------|-------------|-------|
| 1 | 0.0000 | 0.0000 | N/Ax |
| 2 | 0.4351 | 0.2124 | 2.05x |
| 3 | 0.4601 | 0.2067 | 2.23x |
| 4 | 0.3638 | 0.1798 | 2.02x |
| 5 | 0.4326 | 0.2123 | 2.04x |
| 6 | 0.4298 | 0.2098 | 2.05x |
| 7 | 0.4183 | 0.2048 | 2.04x |
| 8 | 0.3765 | 0.1866 | 2.02x |
| 9 | 0.2544 | 0.2165 | 1.18x |
| 10 | 0.0000 | 0.1981 | 0.00x |

## Verdict

**SuperSonic WASM IS the source of the 1.9x louder output.**

Our engine code is NOT adding gain. With desktop-identical settings (pre_amp=0.2, amp=6)
and direct OSC to SuperSonic (bypassing SoundLayer, AudioInterpreter, ProgramBuilder),
the output is still 1.9x louder than desktop scsynth.

This confirms the finding in artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md:
scsynth WASM produces hotter raw output than desktop scsynth.

**Action:** File issue on samaaron/supersonic with this A/B data.

## Console Log

```
Loading SuperSonic from CDN...
SuperSonic module loaded
scsynth WASM initialized (sampleRate=48000)
Synthdefs loaded: basic_stereo_player, mixer
Sample loaded: bd_tek (buf=0)
scsynth synced
Group structure created: synths(100) â†’ fx(101) â†’ mixer(11000)
Mixer created: pre_amp=0.2, amp=6 (desktop identical)
Audio routing: splitter â†’ merger(bus 0 L+R) â†’ gain(1.0) â†’ destination
WAV recorder ready (ScriptProcessor, float32 PCM)
Recording started
Scheduled 20 kicks (4 loops of pattern)
Pattern: x--x--x---x--x-- at 130 BPM
Params: amp=1.5, lpf=130, out_bus=0 (desktop identical)
Total playback: 7.38s + 1s lead
WAV built: 454656 samples, 48000Hz, 9.47s
Recording saved (119 KB)
```
