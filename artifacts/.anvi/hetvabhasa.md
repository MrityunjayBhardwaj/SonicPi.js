# Error Patterns — Sonic Pi Web

## SP1: Promise Resolution Ordering
**Root cause:** Multiple tasks' Promises resolve in the same tick. The microtask queue processes them in an order the scheduler doesn't control.
**Detection signal:** Non-deterministic event ordering across runs.
**The trap:** Add setTimeout(0) between resolutions. Root fix: resolve in deterministic order (sort by virtualTime, then by taskId for ties).

## SP2: AudioContext User Gesture Requirement
**Root cause:** Browser autoplay policy requires user interaction before AudioContext.resume().
**Detection signal:** `init()` completes but no sound — AudioContext is in "suspended" state.
**The trap:** Call init() on page load. Root fix: init() must be called from a click/tap handler. The editor's handlePlay is triggered by user click.

## SP3: Virtual Time Drift from Floating Point
**Root cause:** Repeated float addition (0.5 + 0.5 + 0.5...) accumulates error.
**Detection signal:** After 1000 iterations, virtual time is 499.9999... instead of 500.
**The trap:** Use tolerance checks. Root fix: use rational arithmetic or multiply beats * index instead of accumulating.

## SP4: Hot-Swap Timing Gap
**Root cause:** On re-evaluate, old loop is killed and new loop starts from virtualTime=0, creating a timing discontinuity.
**Detection signal:** Audible glitch on code change — gap or overlap.
**The trap:** Restart loop from beginning. Root fix: hot-swap preserves the current virtualTime position — new function, same clock.

## SP5: SuperSonic SynthDef Not Loaded
**Root cause:** User calls `use_synth("prophet")` but SynthDef hasn't been loaded yet.
**Detection signal:** scsynth logs "SynthDef not found" but no JS error surfaces.
**The trap:** Pre-load all 127 SynthDefs (slow init). Root fix: lazy-load on first use with await, cache loaded set.

## SP6: Capture Mode Infinite Loop
**Root cause:** Fast-forward scheduler runs a live_loop that never calls sleep — infinite loop, browser hangs.
**Detection signal:** Tab freezes during queryArc.
**The trap:** Add timeout. Root fix: cap iterations per tick in capture mode. If a loop body has zero sleep, mark as non-capturable (Stratum 3).

## SP7: Browser Engine Differences in Strict Mode Variable Binding
**Root cause:** `var eval = undefined` and `let eval` are handled differently across browser engines. V8 (Chrome/Node) allows `var eval` in sloppy-mode `new Function()`. SpiderMonkey (Firefox) forbids it entirely, producing "missing ) in parenthetical" SyntaxError.
**Detection signal:** Code works in Chrome but fails in Firefox with "missing ) in parenthetical". Also applies to `arguments` and `Function` as variable names.
**The trap:** Shadow dangerous names via `let`/`var` declarations inside the function body. Root fix: don't try to shadow `eval`/`Function`/`arguments` as variable names at all. Use parameter-name shadowing for other globals (fetch, document, etc.) which works cross-browser. Accept that eval/Function remain accessible — they're low-risk for the Sonic Pi use case.

## SP8: Event Log Mistaken for Audio Observation
**Root cause:** The event log (LOG panel text) shows what the JS scheduler intended. It does NOT show what scsynth actually played. Audio routing bugs (missing out_bus, FX not routing, mixer misconfigured) are invisible to the event log.
**Detection signal:** Event log shows correct events, correct timing, correct patterns — but the recorded audio WAV has wrong volume, missing instruments, clipping, or wrong frequency content.
**The trap:** Read the event log and declare "verified ✓". Root fix: ALWAYS capture and analyze the WAV file. Compare RMS, peak, clipping%, frequency content per beat against the original Sonic Pi reference. The event log is inference; the WAV is observation.
**How it manifested:** In the OSC bundle session, event log showed drum_snare_hard events scheduled correctly for 5+ fix rounds. But the actual audio had zero snare frequency content because samples were missing `out_bus` (bypassed FX) and nested FX only applied innermost. Five rounds of "it's still broken" before the WAV was analyzed.

## SP9: Parameter Name Mismatch at Layer Boundary
**Root cause:** Sonic Pi's DSL uses one name (e.g., `cutoff`), but the scsynth synthdef expects a different name (e.g., `lpf`). The Ruby `sound.rb` layer aliases between them via `munge_opts`. Our engine sends the DSL name directly — scsynth ignores unrecognized params silently.
**Detection signal:** Filter/effect has no audible impact despite correct parameter value. No error logged.
**The trap:** Assume all parameter names pass through unchanged. Root fix: implement per-synth `munge_opts` aliasing. Known aliases: cutoff→lpf (sample players, sc808_snare, sc808_clap), cutoff_slide→lpf_slide, dpulse_width→pulse_width (DPulse).
**How it manifested:** `sample :bd_tek, cutoff: 130` sent `cutoff: 130` to scsynth. The basic_stereo_player synthdef expects `lpf`. The filter never activated. Samples played unfiltered — brighter and louder than intended.

## SP10: Missing BPM Time Scaling
**Root cause:** Sonic Pi's `scale_time_args_to_bpm!` multiplies ALL time-based params by `60/BPM`. This includes ADSR envelopes (attack, decay, sustain, release), ALL `*_slide` params, AND FX time params (phase, max_phase, delay, pre_delay). At 130 BPM, `release: 1` becomes 0.46s; echo `phase: 0.25` becomes 0.115s.
**Detection signal:** Notes ring too long AND/OR FX timing wrong (echo too slow, slicer too wide) at non-60 BPM.
**The trap:** (1) Assume time params are in seconds. (2) Assume FX params are NOT BPM-scaled — the comment "Sonic Pi passes arg_bpm_scaling: false for FX" was **wrong**. Desktop Sonic Pi's `trigger_fx` DOES call `scale_time_args_to_bpm!` (verified from source: `synthinfo.rb` tags echo phase/decay/max_phase with `:bpm_scale => true`).
**Impact:** At 130 BPM, every unscaled time param is 2.17x too long/slow.
**Status:** FIXED for synths/samples (SoundLayer scaleTimeParamsToBpm). FIXED for FX (#66 — normalizeFxParams now BPM-scales).

## SP11: Top-Level FX Recreated Per Iteration
**Root cause:** `fxAwareWrappedLiveLoop` adds `b.with_fx()` to the ProgramBuilder on every loop iteration. AudioInterpreter creates a new FX synth node each time. Desktop Sonic Pi creates top-level FX ONCE — the GC thread's `subthread.join` blocks on the live_loop, so the FX persists forever.
**Detection signal:** Hundreds of FX nodes accumulate per minute. Volume may grow. CPU spikes. Audio gets washy from overlapping reverb/echo tails.
**The trap:** Create FX inside the loop body wrapper. Root fix: for top-level `with_fx` wrapping `live_loop`, create the FX node at registration time, pass the bus/group as inherited state, never recreate.

## SP12: SynthDef Compiled Default ≠ synthinfo.rb Default
**Root cause:** The compiled .scsyndef file bakes in parameter defaults at compile time. synthinfo.rb documents different defaults that Sonic Pi sends explicitly. If our engine relies on the compiled default (by not sending a param), the behavior differs.
**Detection signal:** Envelope shapes or filter behavior differs from desktop Sonic Pi despite sending the same user params.
**The trap:** Assume the synthdef default matches what Sonic Pi intends. Root fix: send critical params explicitly. Known discrepancies: `env_curve` (compiled=1/linear, Sonic Pi sends 2/exponential), mixer `amp` (compiled=1, Sonic Pi sends 6), tb303 `attack` (compiled=0.01, Sonic Pi sends 0).

## SP13: Nested Wrapper State Loss
**Root cause:** A single variable (not a stack) captures wrapper context. Nested wrappers overwrite the outer context.
**Detection signal:** Only the innermost wrapper takes effect. Outer wrappers are silently lost.
**The trap:** Use a single `currentTopFx` variable. Root fix: use a stack (`topFxStack`). Push on enter, pop on exit. Apply ALL stacked wrappers to the live_loop.
**How it manifested:** `with_fx :echo do; with_fx :reverb do; live_loop :clap` — only reverb was applied, echo was lost. Fixed by converting `currentTopFx` to `topFxStack`.

## SP14: Mixer Signal Doubling
**Root cause:** sonic-pi-mixer synthdef sums `in(out_bus) + in(in_bus)`. If both are the same bus (e.g., both bus 0), the signal is read twice and doubled.
**Detection signal:** Output is 2x louder than expected. Clipping increases.
**The trap:** Set `in_bus: 0` (same as out_bus default). Root fix: allocate a SEPARATE private bus for `in_bus`. Desktop Sonic Pi uses `@mixer_bus = new_bus(:audio)`.

## SP15: on: Conditional Trigger Silently Ignored
**Root cause:** Sonic Pi's `should_trigger?` checks the `on:` param and skips the synth/sample trigger entirely if falsy. Our SoundLayer stripped `on:` from params (correct — scsynth doesn't know it) but never checked its value. Every trigger fired regardless of `on:`.
**Detection signal:** `play 60, on: spread(3,8).tick` plays on ALL beats instead of the Euclidean pattern. `sample :hat_snap, on: false` still plays.
**The trap:** Treat `on:` as just another non-scsynth param to strip. Root fix: check `on` value in AudioInterpreter BEFORE triggering. If `on` is present and falsy (0, false), skip the play/sample entirely. Strip happens later in SoundLayer.
**How it manifested:** Discovered during desktop vs web comparison — spread() patterns are a core Sonic Pi idiom used in every tutorial. The pattern played a flat stream of notes instead of the rhythmic Euclidean pattern.
**Status:** FIXED — AudioInterpreter.ts checks `step.opts.on` before triggering (#53).

## SP16: WASM scsynth Output Level Difference (CONFIRMED)

**Root cause:** SuperSonic's scsynth WASM produces ~2x louder raw output than desktop scsynth for identical inputs. Desktop scsynth outputs through native audio drivers (CoreAudio/ALSA) which include driver-level processing. WASM scsynth writes float32 directly to AudioWorklet memory with zero attenuation. Emscripten docs warn: "scale down audio volume by factor of 0.2."
**Detection signal:** Output RMS ~2x desktop, clipping 3%+ vs 0%, crest factor lower (squashed dynamics).
**The trap:** Assume it's a simple constant gain factor. The factor varies somewhat by signal content due to the mixer's non-linear Limiter.ar + clip2.
**How it was confirmed:** Raw OSC isolation test (`tools/raw-osc-test.ts`) bypasses the ENTIRE engine — loads SuperSonic directly from CDN, sends raw OSC with desktop-identical settings (pre_amp=0.2, amp=6). Per-second RMS consistently 2.0-2.2x louder than desktop. This proves the difference is in scsynth WASM, not our engine.
**Note on clap+FX ratio:** The original 1.8x ratio for clap+FX was LOWER than drums (2.2x) partly because FX time params weren't BPM-scaled (SP10/issue #66) — echo was 2.17x too slow, spreading energy over more time and reducing RMS.
**Workaround:** WASM_COMPENSATED_PRE_AMP = 0.2/2.3 in mixer.
**Full investigation:** artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md, tools/audio_comparison/wasm_output_level_analysis.ipynb, tools/audio_comparison/raw_osc_test/RESULTS.md

## SP17: Wrong Assumption Encoded as Truth (Meta-Pattern)
**Root cause:** A wrong claim about desktop Sonic Pi's behavior ("FX params are NOT BPM-scaled, arg_bpm_scaling: false") was written in a code comment, propagated into unit tests (asserting the wrong behavior), and recorded in catalogue entries (SV12, dharana). No mechanism caught the divergence from the reference implementation until WAV temporal analysis revealed echo timing was 2.17x too slow.
**Detection signal:** Spectrogram comparison shows TEMPORAL structure differs between platforms (not just level). Any time a structural pattern (rhythm, echo spacing, slicer rate) differs between desktop and web, suspect a wrong assumption about how desktop transforms params.
**The trap:** Trust code comments and unit tests as "verified" because they pass. The comment "matches desktop Sonic Pi's trigger_fx" was never verified against the actual desktop source — it was an inference that happened to be wrong. Tests encoded the wrong assumption, so they passed while the behavior was incorrect.
**Root fix:** Before claiming any normalization step "matches desktop," verify against the ACTUAL desktop source code (synthinfo.rb for param tags, sound.rb for the normalization chain). Never write "Sonic Pi does X" from inference — read the source. When A/B spectrogram analysis reveals temporal differences, check the param transformation pipeline for the specific FX/synth involved.
**How it manifested:** Issue #66. `with_fx :echo, phase: 0.25` at 130 BPM produced echoes at 250ms (raw seconds) instead of 115ms (0.25 beats × 60/130). Discovered via spectrogram analysis showing clap+FX spectrograms looked "wildly different" while drums (no FX) matched.
**Prevention:** Added to dharana observation targets: "For EVERY normalization rule, verify the claim against desktop source code (synthinfo.rb :bpm_scale tags, sound.rb normalization chain). Code comments are claims, not evidence."

## SP18: Exotic Diagnosis Before Simple Observation (Meta-Pattern)
**Root cause:** Console.rebuild() recreated 500 DOM elements on every log entry after the 500-entry buffer filled (~6 seconds at 86 entries/sec). This caused 43,000 DOM ops/sec, blocking the main thread for 430-860ms/sec. The rebuild() path bypassed the rAF batching we had JUST ADDED in the same session — we added batching to the normal path but never checked the overflow path.
**Detection signal:** Progressive main thread stalls starting at a fixed time after playback begins (correlating with log buffer filling, not audio complexity). Thread monitor shows 200ms+ event loop lag, 4fps, 20+ long tasks — but ONLY after enough time for the log buffer to fill.
**The trap:** When a performance problem appears at ~20 seconds, assume it's caused by something that ACCUMULATES over 20 seconds (GC pressure, node count, WASM processing). Run 12 experiments eliminating exotic causes (SharedArrayBuffer contention, V8 Major GC, timer strategies, allocation pressure, OSC encoding) while missing a basic DOM rebuild loop in code you JUST EDITED. The symptom (progressive degradation) matched the mental model (accumulation) so strongly that simpler explanations (DOM thrashing from a missed code path) weren't checked.
**Root fix:** Two rules:
1. **Check ALL code paths, especially overflow/error paths.** When adding optimization (rAF batching), verify EVERY entry point uses it — especially overflow, rebuild, error, and edge-case paths. The normal path being fast doesn't mean the system is fast.
2. **Before theorizing about exotic causes, measure the actual hot function.** A single `performance.now()` wrapper around `Console.log()` would have found the 5-10ms per call immediately. Instead, 12 experiments over hours investigated scsynth WASM, V8 GC, SharedArrayBuffer, and allocation rates — all wrong.
**How it manifested:** Issue #75. DJ Dave full code (7 loops, 86 log entries/sec). After ~6 seconds, every log entry triggered rebuild() → innerHTML='' → 500×createElement → 500×appendChild → 500×scrollTop. The rAF batching in scheduleFlush() was completely bypassed because rebuild() returned early.
**Prevention:** Added to dharana observation targets: "When adding a performance optimization to a hot path, grep for ALL callers of the unoptimized path. If any bypass the optimization (overflow, rebuild, error handlers), they become the new bottleneck the moment the optimized path succeeds."
**The 12 experiments that missed it:** (1) Raw OSC isolation, (2) FX BPM scaling, (3) Inner FX stacking, (4) Timer strategy, (5) schedAheadTime, (6) Async fast-path, (7) Tick instrumentation, (8) Node freeing, (9) OSC bundle routing, (10) DOM rAF batching (added the fix but missed the bypass!), (11) SuperSonic metrics, (12) V8 GC analysis. All wrong. The answer was in the code we had just edited.

## SP19: Track Bus Mixer Bypass (was SP18)
**Root cause:** allocateTrackBus assigned synth out_bus to buses 2,4,6... (track buses for per-loop visualization). The mixer only reads bus 0. All audio bypassed the mixer (Limiter.ar, gain staging) and reached speakers raw through the Web Audio ChannelMerger summing all 14 channels.
**Detection signal:** RMS unchanged regardless of mixer settings. Clipping from hard clip at Web Audio output (not Limiter.ar).
**The trap:** Assume the mixer processes all audio. Root fix: set task.outBus = 0 for all loops. Track buses used only for AnalyserNode taps, not audio routing. ChannelMerger connects only channels 0-1.
**How it manifested:** Discovered during WASM output level investigation. Mixer amp=1 test would have shown no change if track buses were still active.
