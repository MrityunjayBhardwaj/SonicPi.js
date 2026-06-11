# Desktop ↔ Web Comparison: norand

- **Timestamp:** 2026-06-09T18:39:40.587Z
- **Capture window:** 12000 ms

## Code
```ruby
# faithful filtered_dnb, rrand removed (deterministic) — control sweep kept
use_sample_bpm :loop_amen

with_fx :rlpf, cutoff: 10, cutoff_slide: 4 do |c|
  live_loop :dnb do
    sample :bass_dnb_f, amp: 5
    sample :loop_amen, amp: 5
    sleep 1
    control c, cutoff: 80, cutoff_slide: 2
  end
end
```

## Stats (Level 3 — observation, not inference)

| Metric        | Desktop SP             | SonicPi.js (web)        | Δ (desk − web) |
|---------------|------------------------|-------------------------|----------------|
| Duration (s) | 13.371 | 11.691 | 1.680 |
| Peak | 1.0000 | 0.5557 | 0.4443 |
| RMS | 0.1564 | 0.0795 | 0.0769 |
| Clipping (%) | 0.06 | 0.00 | 0.06 |
| Sample rate (Hz) | 48000 | 48000 | 0 |
| Channels | 2 | 2 | — |

## Verdict
### ≈ Tier 1 PRNG-VARIANT — musically equivalent (same composition, different random walk). pitch-class histogram cos=0.992 (≥0.92), tempo match, density ratio 0.96 (≥0.5), PRNG token in source; same composition, different random walk (cross-engine seed parity is not a v1 goal — #358/#364/#367)  · ⚠ Tier-0 SOFT: level/count aggregates unreliable (Tier 1 pitch unaffected)

### Tier 0 — Validity gates
- ✓ 0.1 Sample rate consistent (48000 Hz)
- ⚠ 0.2 Capture-window misaligned (Δ 1.68s > 0.5s) — note-count / level aggregates unreliable  **(SOFT — Tier 3 + 1.3 unreliable; Tier 1 pitch still valid)**
- ◦ 0.3 equal preconditions / 0.4 lossless capture / 0.5 routing sanity — not auto-checked; ensure SP.app reset + raw-float32 + FX-bus wired (SV31/SV27/SV30)

### Tier 1 — Musical correctness (THE verdict — energy/MFCC may never override)
- **1.1 Note progression:** ≈ pitch-class histogram cos=0.992 (≥0.92), tempo match, density ratio 0.96 (≥0.5), PRNG token in source; same composition, different random walk (cross-engine seed parity is not a v1 goal — #358/#364/#367)
  - method: desktop `onset` (conf 1) · web `onset` (conf 1)
  - desktop: `47,44,60,46,44,60,48,74,46,60,48,74,46,44,60,48,74,46,44,60,48,74,46`
  - web&nbsp;&nbsp;&nbsp;: `47,41,44,60,46,60,48,74,46,44,60,48,74,46,44,60,48,74,46,44,60,48`
- **1.2 Tempo (inter-onset):** ✓ desktop 0.130s · web 0.130s/note
- **1.3 Onset count:** desktop 23 · web 22 (Δ explained by Tier-0 window misalignment)
- ◦ 1.4 note duration / 1.5 polyphony / 1.6 determinism — not auto-tracked here (unit tests cover determinism; see SV24/SV45)

### Tier 3 — Level / gain (reported; NOT a musical-correctness blocker — known ~0.5× web gain-staging)
> ⚠ Tier-0 SOFT failed — these ratios span misaligned windows; treat as indicative only.
- 3.1 RMS ratio web/desktop = 0.51× (within 0.5–2× band)
- 3.2 Peak ratio web/desktop = 0.56×
- 3.3 Clipping: desktop 0.06% · web 0% ✓ (< 1%)

### Tier 2 — Spectral / timbral (supporting only) · Tier 4 — FX/routing · Tier 5 — lifecycle
- Tier 2: see **Spectrogram comparison** section below (MFCC carries its mandatory caveat there).
- Tier 4 (FX accumulation/suppression 200ms scan, per-FX-scope energy): **not analysed** by this tool — use the FX-sweep / boundary-scan tools when FX is in scope.
- Tier 5 (Run/Stop/hot-swap, cold-start, long-run drift): **not analysed** — single capture; use `tools/test-run-stop-cycle.ts` for lifecycle.

## Source WAVs
- **Desktop:** /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/desktop-recordings/desktop_2026-06-09T18-39-18-576Z_norand.wav
- **Web:** /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/2026-06-09T18-39-19-647Z_inline_audio.wav

## Spectrogram comparison
![spectrogram comparison](/Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/compare_2026-06-09T18-39-38-338Z_norand_spectrogram.png)

| Metric | Value | Reading |
|---|---|---|
| L2 distance (mel-dB) | 10.14 | < 10 = very close · 10–25 = similar shape · > 25 = divergent |
| MFCC distance (timbre) | 106.95 | < 30 = similar · 30–80 = noticeably different · > 80 = unrelated |
| ↳ MFCC caveat | — | **Tier-2 supporting only.** Confounded by the known ~0.5× web gain ratio + desktop reverb-tail length; **never overrides Tier 1** (SP93). A high MFCC with a Tier-1 PITCH-MATCH means timbre/gain, not wrong notes. |
| Frames compared | 1097 | overlapping window after length-aligning |
| Peak freq desktop | 87.3 Hz | dominant frequency |
| Peak freq web | 87.2 Hz | dominant frequency |
⚠ MFCC distance 106.95 is high — **check Tier 1 first**: if pitch-track matched, this is timbre/gain (the known 0.5× + reverb tail), NOT wrong notes. Only treat as "different synth/sample chain" when Tier 1 also diverges.

## Tool stdout (debug)
### Desktop
```
▶ Desktop capture (12000ms): norand
✓ Report: /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/desktop_2026-06-09T18-39-18-576Z_norand.md
✓ WAV:    /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/desktop-recordings/desktop_2026-06-09T18-39-18-576Z_norand.wav
  13.37s · peak 1 · RMS 0.1564 · clip 0.06%
```
### Web
```
Launching Chromium (headed, audio capture)...
  Running: inline (12000ms)...

Capture saved: /Users/mrityunjaybhardwaj/Documents/projects/sonicPiWeb/.captures/inline.md
No errors detected.
```