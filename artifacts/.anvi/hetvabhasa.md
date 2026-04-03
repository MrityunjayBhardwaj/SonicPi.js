# Error Patterns — Sonic Pi Web

> Every pattern references the Ground Truth interpretation layer.
> Internal: `artifacts/ref/GROUND_TRUTH_SONIC_PI_WEB.md` — our engine pipeline
> External: `artifacts/ref/GROUND_TRUTH_{SUPERSONIC,DESKTOP_SP,SONIC_TAU}.md`
> Source code: `artifacts/ref/sources/{supersonic,desktop-sp,sonic-tau}/`
> Chain: catalogue entry → REF → Ground Truth doc#stage → REF → source file:line

## SP1: Promise Resolution Ordering
**Root cause:** Multiple tasks' Promises resolve in the same tick. The microtask queue processes them in an order the scheduler doesn't control.
**Detection signal:** Non-deterministic event ordering across runs.
**The trap:** Add setTimeout(0) between resolutions. Root fix: resolve in deterministic order (sort by virtualTime, then by taskId for ties).
**REF:** `VirtualTimeScheduler.ts:91` SV3 deterministic ordering comment; `VirtualTimeScheduler.ts:103` monotonic counter for tiebreaking; `VirtualTimeScheduler.ts:324` tick resolves in deterministic order

## SP2: AudioContext User Gesture Requirement
**Root cause:** Browser autoplay policy requires user interaction before AudioContext.resume().
**Detection signal:** `init()` completes but no sound — AudioContext is in "suspended" state.
**The trap:** Call init() on page load. Root fix: init() must be called from a click/tap handler. The editor's handlePlay is triggered by user click.
**REF:** `SonicPiEngine.ts:108` async init()

## SP3: Virtual Time Drift from Floating Point
**Root cause:** Repeated float addition (0.5 + 0.5 + 0.5...) accumulates error.
**Detection signal:** After 1000 iterations, virtual time is 499.9999... instead of 500.
**The trap:** Use tolerance checks. Root fix: use rational arithmetic or multiply beats * index instead of accumulating.
**REF:** `VirtualTimeScheduler.ts:244-245` task.virtualTime += seconds (accumulation site); `VirtualTimeScheduler.ts:16` drift comment

## SP4: Hot-Swap Timing Gap
**Root cause:** On re-evaluate, old loop is killed and new loop starts from virtualTime=0, creating a timing discontinuity.
**Detection signal:** Audible glitch on code change — gap or overlap.
**The trap:** Restart loop from beginning. Root fix: hot-swap preserves the current virtualTime position — new function, same clock.
**REF:** `VirtualTimeScheduler.ts:147-148` hot-swap replaces asyncFn, preserves virtualTime (SV6); `VirtualTimeScheduler.ts:192-198` hotSwap() method; `VirtualTimeScheduler.ts:214-215` reconcileLoops hot-swap path

## SP5: SuperSonic SynthDef Not Loaded
**Root cause:** User calls `use_synth("prophet")` but SynthDef hasn't been loaded yet.
**Detection signal:** scsynth logs "SynthDef not found" but no JS error surfaces.
**The trap:** Pre-load all 127 SynthDefs (slow init). Root fix: lazy-load on first use with await, cache loaded set.
**REF:** `SuperSonicBridge.ts:183` loadedSynthDefs Set; `SuperSonicBridge.ts:408-411` lazy-load on first use + cache

## SP6: Capture Mode Infinite Loop
**Root cause:** Fast-forward scheduler runs a live_loop that never calls sleep — infinite loop, browser hangs.
**Detection signal:** Tab freezes during queryArc.
**The trap:** Add timeout. Root fix: cap iterations per tick in capture mode. If a loop body has zero sleep, mark as non-capturable (Stratum 3).
**REF:** `ProgramBuilder.ts:18-24` DEFAULT_LOOP_BUDGET + InfiniteLoopError class; `ProgramBuilder.ts:90-101` budget reset on sleep, throw on exhaustion; `VirtualTimeScheduler.ts:410-411` InfiniteLoopError handler stops loop; `QueryInterpreter.ts:167` zero-sleep guard

## SP7: Browser Engine Differences in Strict Mode Variable Binding
**Root cause:** `var eval = undefined` and `let eval` are handled differently across browser engines. V8 (Chrome/Node) allows `var eval` in sloppy-mode `new Function()`. SpiderMonkey (Firefox) forbids it entirely, producing "missing ) in parenthetical" SyntaxError.
**Detection signal:** Code works in Chrome but fails in Firefox with "missing ) in parenthetical". Also applies to `arguments` and `Function` as variable names.
**The trap:** Shadow dangerous names via `let`/`var` declarations inside the function body. Root fix: don't try to shadow `eval`/`Function`/`arguments` as variable names at all. Use parameter-name shadowing for other globals (fetch, document, etc.) which works cross-browser. Accept that eval/Function remain accessible — they're low-risk for the Sonic Pi use case.
**REF:** `Sandbox.ts:5-16` design comment: new Function + with() proxy, Firefox/SES note; `Sandbox.ts:120-124` sloppy mode + new Function construction; `Sandbox.ts:137` parameter-name variant

## SP8: Event Log Mistaken for Audio Observation
**Root cause:** The event log (LOG panel text) shows what the JS scheduler intended. It does NOT show what scsynth actually played. Audio routing bugs (missing out_bus, FX not routing, mixer misconfigured) are invisible to the event log.
**Detection signal:** Event log shows correct events, correct timing, correct patterns — but the recorded audio WAV has wrong volume, missing instruments, clipping, or wrong frequency content.
**The trap:** Read the event log and declare "verified ✓". Root fix: ALWAYS capture and analyze the WAV file. Compare RMS, peak, clipping%, frequency content per beat against the original Sonic Pi reference. The event log is inference; the WAV is observation.
**How it manifested:** In the OSC bundle session, event log showed drum_snare_hard events scheduled correctly for 5+ fix rounds. But the actual audio had zero snare frequency content because samples were missing `out_bus` (bypassed FX) and nested FX only applied innermost. Five rounds of "it's still broken" before the WAV was analyzed.
**REF:** Epistemic pattern (no single source line). `SonicPiEngine.ts:34` SoundEventStream for event logging; WAV capture via `tools/capture.ts` for observation. See SV8 invariant.

## SP9: Parameter Name Mismatch at Layer Boundary
**Root cause:** Sonic Pi's DSL uses one name (e.g., `cutoff`), but the scsynth synthdef expects a different name (e.g., `lpf`). The Ruby `sound.rb` layer aliases between them via `munge_opts`. Our engine sends the DSL name directly — scsynth ignores unrecognized params silently.
**REF:** `SoundLayer.ts:178` perSynthParamAliasing; `SoundLayer.ts:191` full pipeline order; `SoundLayer.ts:197-211` normalizePlayParams
**Detection signal:** Filter/effect has no audible impact despite correct parameter value. No error logged.
**The trap:** Assume all parameter names pass through unchanged. Root fix: implement per-synth `munge_opts` aliasing. Known aliases: cutoff→lpf (sample players, sc808_snare, sc808_clap), cutoff_slide→lpf_slide, dpulse_width→pulse_width (DPulse).
**How it manifested:** `sample :bd_tek, cutoff: 130` sent `cutoff: 130` to scsynth. The basic_stereo_player synthdef expects `lpf`. The filter never activated. Samples played unfiltered — brighter and louder than intended.

## SP10: Missing BPM Time Scaling
**Root cause:** Sonic Pi's `scale_time_args_to_bpm!` multiplies ALL time-based params by `60/BPM`. This includes ADSR envelopes (attack, decay, sustain, release), ALL `*_slide` params, AND FX time params (phase, max_phase, delay, pre_delay). At 130 BPM, `release: 1` becomes 0.46s; echo `phase: 0.25` becomes 0.115s.
**REF:** `SoundLayer.ts:20-28` TIME_PARAMS set; `SoundLayer.ts:466-482` scaleTimeParamsToBpm; `SoundLayer.ts:211,228,243,271` called from all four normalize functions
**Detection signal:** Notes ring too long AND/OR FX timing wrong (echo too slow, slicer too wide) at non-60 BPM.
**The trap:** (1) Assume time params are in seconds. (2) Assume FX params are NOT BPM-scaled — the comment "Sonic Pi passes arg_bpm_scaling: false for FX" was **wrong**. Desktop Sonic Pi's `trigger_fx` DOES call `scale_time_args_to_bpm!` (verified from source: `synthinfo.rb` tags echo phase/decay/max_phase with `:bpm_scale => true`).
**Impact:** At 130 BPM, every unscaled time param is 2.17x too long/slow.
**Status:** FIXED for synths/samples (SoundLayer scaleTimeParamsToBpm). FIXED for FX (#66 — normalizeFxParams now BPM-scales).

## SP11: Top-Level FX Recreated Per Iteration
**Root cause:** `fxAwareWrappedLiveLoop` adds `b.with_fx()` to the ProgramBuilder on every loop iteration. AudioInterpreter creates a new FX synth node each time. Desktop Sonic Pi creates top-level FX ONCE — the GC thread's `subthread.join` blocks on the live_loop, so the FX persists forever.
**Detection signal:** Hundreds of FX nodes accumulate per minute. Volume may grow. CPU spikes. Audio gets washy from overlapping reverb/echo tails.
**The trap:** Create FX inside the loop body wrapper. Root fix: for top-level `with_fx` wrapping `live_loop`, create the FX node at registration time, pass the bus/group as inherited state, never recreate.
**REF:** `SonicPiEngine.ts:73` persistentFx Map; `SonicPiEngine.ts:305-332` first-iteration FX creation + persistentFx.set; `SonicPiEngine.ts:429-443` fxAwareWrappedLiveLoop

## SP12: SynthDef Compiled Default ≠ synthinfo.rb Default
**Root cause:** The compiled .scsyndef file bakes in parameter defaults at compile time. synthinfo.rb documents different defaults that Sonic Pi sends explicitly. If our engine relies on the compiled default (by not sending a param), the behavior differs.
**Detection signal:** Envelope shapes or filter behavior differs from desktop Sonic Pi despite sending the same user params.
**The trap:** Assume the synthdef default matches what Sonic Pi intends. Root fix: send critical params explicitly. Known discrepancies: mixer `amp` (compiled=1, Sonic Pi sends 6), tb303 `attack` (compiled=0.01, Sonic Pi sends 0). **EXCEPTION: `env_curve`** — Desktop SP sends env_curve: 2 (exponential), but WASM scsynth produces silence for overlapping synths with env_curve: 2 (SP22). Use compiled default (1/linear) until upstream fix. This is a known divergence from desktop behavior.
**REF:** `SoundLayer.ts:343-348` injectEnvCurve (DISABLED — SP22); `SoundLayer.ts:11` design comment listing injection step; `SuperSonicBridge.ts:169` SONIC_PI_DEFAULT_AMP=6

## SP13: Nested Wrapper State Loss
**Root cause:** A single variable (not a stack) captures wrapper context. Nested wrappers overwrite the outer context.
**Detection signal:** Only the innermost wrapper takes effect. Outer wrappers are silently lost.
**The trap:** Use a single `currentTopFx` variable. Root fix: use a stack (`topFxStack`). Push on enter, pop on exit. Apply ALL stacked wrappers to the live_loop.
**How it manifested:** `with_fx :echo do; with_fx :reverb do; live_loop :clap` — only reverb was applied, echo was lost. Fixed by converting `currentTopFx` to `topFxStack`.
**REF:** `SonicPiEngine.ts:387-389` topFxStack declaration; `SonicPiEngine.ts:408` push on enter; `SonicPiEngine.ts:417` pop on exit; `SonicPiEngine.ts:438-443` stack propagation to fxScopeChains

## SP14: Mixer Signal Doubling
**Root cause:** sonic-pi-mixer synthdef sums `in(out_bus) + in(in_bus)`. If both are the same bus (e.g., both bus 0), the signal is read twice and doubled.
**Detection signal:** Output is 2x louder than expected. Clipping increases.
**The trap:** Set `in_bus: 0` (same as out_bus default). Root fix: allocate a SEPARATE private bus for `in_bus`. Desktop Sonic Pi uses `@mixer_bus = new_bus(:audio)`.
**REF:** `SuperSonicBridge.ts:273-278` mixer signal chain comment + SEPARATE bus requirement; `SuperSonicBridge.ts:278` allocateBus() for private mixer in_bus

## SP15: on: Conditional Trigger Silently Ignored
**Root cause:** Sonic Pi's `should_trigger?` checks the `on:` param and skips the synth/sample trigger entirely if falsy. Our SoundLayer stripped `on:` from params (correct — scsynth doesn't know it) but never checked its value. Every trigger fired regardless of `on:`.
**Detection signal:** `play 60, on: spread(3,8).tick` plays on ALL beats instead of the Euclidean pattern. `sample :hat_snap, on: false` still plays.
**The trap:** Treat `on:` as just another non-scsynth param to strip. Root fix: check `on` value in AudioInterpreter BEFORE triggering. If `on` is present and falsy (0, false), skip the play/sample entirely. Strip happens later in SoundLayer.
**How it manifested:** Discovered during desktop vs web comparison — spread() patterns are a core Sonic Pi idiom used in every tutorial. The pattern played a flat stream of notes instead of the rhythmic Euclidean pattern.
**Status:** FIXED — AudioInterpreter.ts checks `step.opts.on` before triggering (#53).
**REF:** `AudioInterpreter.ts:72-73` should_trigger check for play; `AudioInterpreter.ts:107-108` should_trigger check for sample

## SP16: WASM scsynth Output Level Difference (CONFIRMED)

**Root cause:** SuperSonic's scsynth WASM produces ~2x louder raw output than desktop scsynth for identical inputs. Desktop scsynth outputs through native audio drivers (CoreAudio/ALSA) which include driver-level processing. WASM scsynth writes float32 directly to AudioWorklet memory with zero attenuation. Emscripten docs warn: "scale down audio volume by factor of 0.2."
**Detection signal:** Output RMS ~2x desktop, clipping 3%+ vs 0%, crest factor lower (squashed dynamics).
**The trap:** Assume it's a simple constant gain factor. The factor varies somewhat by signal content due to the mixer's non-linear Limiter.ar + clip2.
**How it was confirmed:** Raw OSC isolation test (`tools/raw-osc-test.ts`) bypasses the ENTIRE engine — loads SuperSonic directly from CDN, sends raw OSC with desktop-identical settings (pre_amp=0.2, amp=6). Per-second RMS consistently 2.0-2.2x louder than desktop. This proves the difference is in scsynth WASM, not our engine.
**Note on clap+FX ratio:** The original 1.8x ratio for clap+FX was LOWER than drums (2.2x) partly because FX time params weren't BPM-scaled (SP10/issue #66) — echo was 2.17x too slow, spreading energy over more time and reducing RMS.
**Workaround:** WASM_COMPENSATED_PRE_AMP = 0.2/2.3 in mixer.
**Full investigation:** artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md, tools/audio_comparison/wasm_output_level_analysis.ipynb, tools/audio_comparison/raw_osc_test/RESULTS.md
**REF:** `SuperSonicBridge.ts:123-136` WASM output level explanation; `SuperSonicBridge.ts:164` WASM_OUTPUT_LEVEL_FACTOR=2.3; `SuperSonicBridge.ts:179` WASM_COMPENSATED_PRE_AMP formula; `SuperSonicBridge.ts:284` compensated pre_amp in mixer creation

## SP17: Wrong Assumption Encoded as Truth (Meta-Pattern)
**Root cause:** A wrong claim about desktop Sonic Pi's behavior ("FX params are NOT BPM-scaled, arg_bpm_scaling: false") was written in a code comment, propagated into unit tests (asserting the wrong behavior), and recorded in catalogue entries (SV12, dharana). No mechanism caught the divergence from the reference implementation until WAV temporal analysis revealed echo timing was 2.17x too slow.
**Detection signal:** Spectrogram comparison shows TEMPORAL structure differs between platforms (not just level). Any time a structural pattern (rhythm, echo spacing, slicer rate) differs between desktop and web, suspect a wrong assumption about how desktop transforms params.
**The trap:** Trust code comments and unit tests as "verified" because they pass. The comment "matches desktop Sonic Pi's trigger_fx" was never verified against the actual desktop source — it was an inference that happened to be wrong. Tests encoded the wrong assumption, so they passed while the behavior was incorrect.
**Root fix:** Before claiming any normalization step "matches desktop," verify against the ACTUAL desktop source code (synthinfo.rb for param tags, sound.rb for the normalization chain). Never write "Sonic Pi does X" from inference — read the source. When A/B spectrogram analysis reveals temporal differences, check the param transformation pipeline for the specific FX/synth involved.
**How it manifested:** Issue #66. `with_fx :echo, phase: 0.25` at 130 BPM produced echoes at 250ms (raw seconds) instead of 115ms (0.25 beats × 60/130). Discovered via spectrogram analysis showing clap+FX spectrograms looked "wildly different" while drums (no FX) matched.
**Prevention:** Added to dharana observation targets: "For EVERY normalization rule, verify the claim against desktop source code (synthinfo.rb :bpm_scale tags, sound.rb normalization chain). Code comments are claims, not evidence."
**REF:** `SoundLayer.ts:191` full pipeline order; `SoundLayer.ts:249-271` normalizeFxParams (the fix for the wrong assumption)

## SP18: Exotic Diagnosis Before Simple Observation (Meta-Pattern)
**Root cause:** Console.rebuild() recreated 500 DOM elements on every log entry after the 500-entry buffer filled (~6s at 86 entries/sec). 43,000 DOM ops/sec blocking the main thread. The rebuild() path bypassed the rAF batching added in the same session.
**Detection signal:** Progressive main thread stalls at a FIXED time after playback begins (correlating with log buffer filling, not audio complexity).
**The trap:** When performance degrades at ~20 seconds, assume exotic causes (V8 GC, WASM contention, SharedArrayBuffer). Run 12 experiments eliminating exotic causes while missing a DOM rebuild loop in code you JUST EDITED.
**Root fix:** (1) When adding optimization, grep ALL callers — especially overflow/error paths. (2) Measure the hot function (performance.now) BEFORE theorizing about engine internals.
**How it manifested:** Issue #75. 12 experiments investigated V8 GC, scsynth WASM, SharedArrayBuffer, allocation rates — all wrong. Answer was Console.rebuild() in code edited that same session.
**Full case study:** `artifacts/ref/CASE_STUDY_PERFORMANCE_INVESTIGATION.md`
**REF:** Meta-pattern (no single source line). Full case study: `artifacts/ref/CASE_STUDY_PERFORMANCE_INVESTIGATION.md`

## SP19: Track Bus Mixer Bypass (was SP18)
**Root cause:** allocateTrackBus assigned synth out_bus to buses 2,4,6... (track buses for per-loop visualization). The mixer only reads bus 0. All audio bypassed the mixer (Limiter.ar, gain staging) and reached speakers raw through the Web Audio ChannelMerger summing all 14 channels.
**Detection signal:** RMS unchanged regardless of mixer settings. Clipping from hard clip at Web Audio output (not Limiter.ar).
**The trap:** Assume the mixer processes all audio. Root fix: set task.outBus = 0 for all loops. Track buses used only for AnalyserNode taps, not audio routing. ChannelMerger connects only channels 0-1.
**How it manifested:** Discovered during WASM output level investigation. Mixer amp=1 test would have shown no change if track buses were still active.
**REF:** `SonicPiEngine.ts:269-272` allocateTrackBus call (visualization only); `SonicPiEngine.ts:379` task.outBus=0 (audio goes to mixer); `SuperSonicBridge.ts:198-201` trackBuses Map + nextTrackBus; `SuperSonicBridge.ts:300-301` only bus 0 carries audio

## SP20: Ungrounded Hypothesis (Meta-Pattern)
**Root cause:** Hypothesis formed from behavioral observation without reading relevant source code. Experiments fail because the mental model of the system's behavior is inferred, not read from source.
**Detection signal:** Multiple experiments fail in succession. Each new theory addresses the last failure but not the root cause. The model keeps being wrong.
**The trap:** "I've seen enough behavior to form a theory." Root fix: Read the source. Form the hypothesis from code understanding, not behavioral inference. Use the Ground Truth documents.
**How it manifested:** Silent prophet investigation v1 blamed the prescheduler (wrong). v2 ran 9 experiments on timing/Worker/SAB theories (all wrong). v2's conclusion ("cold-start WASM AudioWorklet poison nodes") was ALSO wrong — a third round revealed the actual cause was `env_curve: 2` causing silence for overlapping synths. The investigation compared different execution CONTEXTS (CDP vs page) when the real difference was message CONTENT (env_curve: 2 present vs absent).
**Recurrence note:** This exact meta-pattern recurred across three diagnosis rounds. v1: wrong boundary (prescheduler). v2: wrong mechanism (WASM cold-start). v3: found actual cause (env_curve param). Each round formed a plausible theory from observation without diffing the actual data at the boundary.
**REF:** Meta-pattern (no single source line). Full investigation: `artifacts/investigations/silent-prophet-diagnosis-v2.md`

## SP21: CDP Execution Context Asymmetry (PARTIALLY INVALIDATED)
**Original claim:** Chrome DevTools Protocol injects JavaScript through V8's debugger task queue, creating different timing for postMessage delivery to AudioWorklet.
**What was actually happening:** CDP tests used raw `sonic.send()` calls WITHOUT env_curve: 2 injection (bypassing SoundLayer). App code went through SoundLayer which injected env_curve: 2. The "asymmetry" was in the MESSAGE CONTENT, not the execution context. CDP worked because it sent different params, not because it used a different V8 task queue.
**Detection signal (updated):** When path A works and path B doesn't, diff the CONTENT at the boundary before diffing the CONTEXT. If the messages differ, the execution context is irrelevant.
**The trap (updated):** Investigating execution context differences when the actual difference is in the data being sent. Always diff the actual OSC messages/params at the boundary first.
**What remains valid:** CDP and page event loops ARE different execution contexts. But for the silent prophet bug, this was a red herring — the difference that mattered was env_curve: 2 present vs absent.
**REF:** `artifacts/investigations/silent-prophet-diagnosis-v2.md` Phase 7; `SoundLayer.ts:346-349` injectMandatoryDefaults (the actual divergence point)

## SP22: env_curve: 2 Causes Silence for Overlapping Synths in WASM scsynth (was "Cold-Start Poison Nodes")
**Root cause:** `env_curve: 2` (exponential envelope) sent to SuperSonic's WASM scsynth causes overlapping synth nodes to produce zero audio. The compiled default `env_curve: 1` (linear) works correctly. This is a WASM scsynth behavioral difference from desktop scsynth, where env_curve: 2 works fine with overlapping synths.
**Detection signal:** Overlapping heavy synths (prophet, multiple notes ringing simultaneously) produce silence. Non-overlapping synths work. Same code works when env_curve: 2 is NOT injected (e.g., raw `sonic.send()` calls that bypass SoundLayer).
**The trap:** (1) Blame the prescheduler (v1, wrong). (2) Blame WASM AudioWorklet cold-start timing (v2, wrong — the "poison node" model, CDP asymmetry explanation, and cold-start stabilization theory were all wrong). (3) Compare execution CONTEXTS (CDP vs page) instead of diffing message CONTENT at the boundary. Root fix: Don't inject env_curve: 2 for WASM scsynth. Use compiled default (env_curve: 1, linear). Minor timbre difference from Desktop SP until upstream SuperSonic fix.
**What was wrong about v2's model:** The "cold-start" framing was incorrect. The bug wasn't timing-dependent — it occurred at any time when overlapping synths had env_curve: 2. CDP tests appeared to work because they bypassed SoundLayer (no env_curve injection), not because of execution context differences. The 9 failed experiments investigated the wrong dimension entirely.
**Fix:** Skip env_curve: 2 injection in `SoundLayer.ts:346-349` injectMandatoryDefaults. Use compiled default (linear envelope).
**REF:** `SoundLayer.ts:346-349` injectMandatoryDefaults (now disabled for env_curve); `artifacts/investigations/silent-prophet-diagnosis-v2.md` investigation history (conclusions invalidated)
**Full investigation:** artifacts/investigations/silent-prophet-diagnosis-v2.md (note: v2 conclusions are WRONG — see this entry for actual root cause)
