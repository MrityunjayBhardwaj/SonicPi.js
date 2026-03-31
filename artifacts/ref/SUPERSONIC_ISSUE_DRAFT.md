# Issue: WASM scsynth output is ~2.3x louder than desktop scsynth for identical synthdefs and samples

## Filed on: samaaron/supersonic

---

### Title

WASM scsynth output is ~2.3x louder than desktop scsynth for identical code

### Body

Hi Sam — we've been building [Sonic Pi Web](https://sonicpi.cc) (browser-native Sonic Pi reimplementation using SuperSonic), and during A/B testing against desktop Sonic Pi we've found a consistent **~2.3x RMS difference** in output level for identical code, samples, and synthdefs.

## Reproducing

### Self-contained HTML repro

Save as `repro.html`, serve with any static server (`npx serve .`), open in Chrome, click "Run Test". The page plays a kick sample through the Sonic Pi mixer, records 3 seconds of audio, and computes RMS + peak. Desktop Sonic Pi produces RMS ≈ 0.19 for this code; SuperSonic produces ≈ 0.42.

```html
<!DOCTYPE html>
<html>
<head><title>SuperSonic Output Level Test</title></head>
<body>
<h2>SuperSonic Output Level Test</h2>
<button id="run">Run Test</button>
<pre id="log"></pre>
<script type="module">
import SuperSonic from "https://unpkg.com/supersonic-scsynth@latest";

const log = (msg) => { document.getElementById("log").textContent += msg + "\n"; };

document.getElementById("run").onclick = async () => {
  log("Initialising SuperSonic...");

  const ss = new SuperSonic({
    baseURL: "https://unpkg.com/supersonic-scsynth@latest/dist/",
    coreBaseURL: "https://unpkg.com/supersonic-scsynth-core@latest/",
    synthdefBaseURL: "https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/",
    sampleBaseURL: "https://unpkg.com/supersonic-scsynth-samples@latest/samples/",
    scsynthOptions: { numOutputBusChannels: 2 },
  });
  await ss.init();

  // Load synthdef + sample
  await ss.loadSynthDefs(["sonic-pi-basic_stereo_player", "sonic-pi-mixer"]);
  await ss.loadSample(0, "bd_tek.flac");
  await ss.sync();

  // Create group structure matching desktop Sonic Pi
  const mixerGroupId = ss.nextNodeId();
  ss.send("/g_new", mixerGroupId, 0, 0);   // mixer group at head of root
  ss.send("/g_new", 100, 2, mixerGroupId);  // synths group before mixer

  // Create mixer — identical settings to desktop Sonic Pi
  ss.send("/s_new", "sonic-pi-mixer", ss.nextNodeId(), 0, mixerGroupId,
    "out_bus", 0,
    "in_bus", 16,      // private bus (silence — only out_bus=0 carries audio)
    "amp", 6,          // Sonic Pi default
    "pre_amp", 0.2     // Sonic Pi default: set_volume!(1) → vol * 0.2
  );
  await ss.sync();

  // Set up Web Audio recording
  const audioCtx = ss.audioContext;
  const dest = audioCtx.createMediaStreamDestination();
  ss.node.connect(dest);
  ss.node.connect(audioCtx.destination); // also play to speakers

  const recorder = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);

  // Start recording
  recorder.start();
  log("Playing kicks for 3 seconds...");

  // Play 6 kicks (one every 0.5s for 3 seconds)
  for (let i = 0; i < 6; i++) {
    const nodeId = ss.nextNodeId();
    ss.send("/s_new", "sonic-pi-basic_stereo_player", nodeId, 0, 100,
      "buf", 0,
      "amp", 1.5,
      "out_bus", 0
    );
    await new Promise(r => setTimeout(r, 500));
  }

  // Stop recording and analyse
  recorder.stop();
  await new Promise(r => { recorder.onstop = r; });

  const blob = new Blob(chunks, { type: "audio/webm" });
  const arrayBuf = await blob.arrayBuffer();
  const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
  const samples = audioBuf.getChannelData(0);

  let peak = 0, sumSq = 0, clipCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
    sumSq += samples[i] * samples[i];
    if (abs > 0.95) clipCount++;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const clipping = (clipCount / samples.length * 100).toFixed(2);

  log("");
  log("=== RESULTS ===");
  log(`Peak:     ${peak.toFixed(4)}`);
  log(`RMS:      ${rms.toFixed(4)}`);
  log(`Clipping: ${clipping}%`);
  log("");
  log("Expected (desktop Sonic Pi, same code):");
  log("  Peak: ~0.63, RMS: ~0.19, Clipping: 0%");
  log("");
  log(`Ratio: ${(rms / 0.19).toFixed(2)}x louder than desktop`);

  ss.destroy();
};
</script>
</body>
</html>
```

### Equivalent desktop Sonic Pi code

Run in Sonic Pi, press Rec, wait 3 seconds, press Rec again to save WAV:

```ruby
use_bpm 120
live_loop :kick do
  sample :bd_tek, amp: 1.5
  sleep 1
end
```

### Comparison

| | Desktop Sonic Pi | SuperSonic WASM |
|--|---|---|
| **Peak** | ~0.63 | ~1.0 (clipped) |
| **RMS** | ~0.19 | ~0.42 |
| **Clipping** | 0% | ~3% |
| **Ratio** | baseline | **~2.2x louder** |

## Measurement data

We recorded the same code on both platforms using their respective Rec buttons (desktop: DiskOut synthdef inside scsynth; web: Chromium MediaRecorder). All recordings are 48kHz 16-bit stereo WAV.

### Only Drums (kick pattern, no FX)

| Metric | Desktop Sonic Pi | SuperSonic WASM | Ratio |
|--------|-----------------|-----------------|-------|
| Peak | 0.6267 | 1.0000 (clipped) | 1.60x |
| RMS | 0.1881 | 0.4158 | **2.21x** |
| Clipping (>0.95) | 0.00% | 3.37% | — |

### Clap + echo + reverb (no drums)

| Metric | Desktop Sonic Pi | SuperSonic WASM | Ratio |
|--------|-----------------|-----------------|-------|
| Peak | 0.9832 | 1.0000 | 1.02x |
| RMS | 0.0494 | 0.0897 | **1.82x** |
| Clipping (>0.95) | 0.00% | 0.13% | — |

The ratio is stable per-second (~2.0-2.5x) and consistent across different instruments.

## What we've verified

We traced the entire signal path end-to-end:

1. **AudioWorklet processor** (`scsynth_audio_worklet.js`): Direct `.set()` copy from WASM Float32Array to Web Audio output. **Zero gain applied.**

2. **Web Audio chain**: ChannelSplitter → ChannelMerger(2) → AnalyserNode → GainNode(1.0) → destination. All unity-gain nodes. **No extra gain.**

3. **Mixer is alive**: Setting `amp=1` drops RMS from 0.42 to 0.074 (6x reduction, matching the 6x amp change). The sonic-pi-mixer synthdef IS processing the signal.

4. **Mixer settings identical**: `pre_amp=0.2`, `amp=6` (effective gain 1.2x). Same as desktop Sonic Pi.

5. **Samples identical**: bd_tek.flac MD5 matches desktop Sonic Pi's copy byte-for-byte.

6. **Synthdefs**: From `supersonic-scsynth-synthdefs@0.66.0`, sourced from Sonic Pi's compiled synthdefs.

7. **Reverse-engineered raw signal** (before mixer):
   - Desktop raw RMS: ~0.16 (calculated: 0.19 / 1.2 gain)
   - WASM raw RMS: 0.37 (measured: 0.074 / 0.2 pre_amp, from amp=1 test)
   - **Same synthdef + same sample + same params → 2.3x louder raw output in WASM**

## Suspected cause

The Emscripten [Wasm Audio Worklets documentation](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html) contains:

> "Warning: scale down audio volume by factor of 0.2, raw noise can be really loud otherwise"

Desktop scsynth outputs through native audio drivers (CoreAudio/ALSA/JACK) which may apply output normalization or attenuation at the driver level. The WASM build bypasses all native drivers — float32 samples go from WASM memory directly to Web Audio with no intermediate processing.

The 2.3x factor is consistent and appears to be a constant scaling difference in how scsynth's internal bus output maps to the final audio path in WASM vs native.

## Workaround

We currently compensate by reducing the mixer's `pre_amp`:

```
pre_amp = 0.2 / 2.3 ≈ 0.087
```

This produces desktop-equivalent output levels, but it's a hardcoded workaround that may not be correct for all sample rates or configurations.

## Suggested fix

A few options (in order of preference):

1. **Documented `outputGain` constructor option** — Let users set a gain factor applied in the AudioWorklet before output. Default could match desktop levels.

2. **Automatic output normalization in the worklet** — Apply a scaling factor in `process()` to match desktop scsynth output levels.

3. **Document the difference** — If the louder output is intentional (raw scsynth output with no driver attenuation), document it so users can compensate in their mixer settings.

## Environment

| Component | Version |
|-----------|---------|
| supersonic-scsynth | 0.66.0 |
| supersonic-scsynth-core | 0.66.0 |
| supersonic-scsynth-synthdefs | 0.66.0 |
| Browser | Chromium 136 (via Playwright) |
| AudioContext sampleRate | 48000 Hz |
| Desktop Sonic Pi | latest stable (2026) |
| OS | macOS Darwin 24.4.0 |

Thanks for building SuperSonic — it's an incredible achievement bringing scsynth to the browser. Happy to provide the WAV files or any additional data if helpful.
