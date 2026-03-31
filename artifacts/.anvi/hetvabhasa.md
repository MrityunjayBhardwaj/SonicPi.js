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
**Root cause:** Sonic Pi's `scale_time_args_to_bpm!` multiplies ALL time-based params (attack, decay, sustain, release, all slide times) by `60/BPM`. At 130 BPM, `release: 1` becomes 0.46 seconds. Our engine passes raw beat values as seconds.
**Detection signal:** Notes ring for much longer than expected at non-60 BPM. Overlapping envelopes. Higher sustained RMS. Washy, smeared sound instead of tight rhythm.
**The trap:** Assume time params are in seconds. Root fix: in the SoundLayer, multiply all time-based args by `60/currentBPM` before sending to scsynth. Only applies when `arg_bpm_scaling` is true (default).
**Impact:** At 130 BPM, every envelope is 2.17x too long. This is likely the single biggest remaining audio discrepancy.

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
