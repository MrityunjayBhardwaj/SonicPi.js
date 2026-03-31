# Invariants — Sonic Pi Web

## SV1: Virtual Time Monotonicity
**Statement:** For each task T, virtualTime(T) is non-decreasing and advances only on sleep() or sync().
**Causal status:** STRUCTURAL — defines the temporal model.
**Breaks when:** Never (by construction).
**Implication:** All events between two sleeps share the same virtual timestamp (chord semantics).

## SV2: Scheduler-Exclusive Promise Resolution
**Statement:** A Promise returned by sleep() can ONLY be resolved by the scheduler's tick() method.
**Causal status:** CAUSAL — the Promise has no timeout, no microtask trigger.
**Breaks when:** Someone adds a setTimeout fallback or resolves outside tick().
**Implication:** The scheduler has complete control over when async functions resume.

## SV3: Determinism Under Same Inputs
**Statement:** Given same code + same random seeds + same initial state, the event trace is identical across runs.
**Causal status:** STRUCTURAL — follows from SV1 + seeded random + deterministic priority queue.
**Breaks when:** Code uses Date.now(), Math.random(), or external I/O (Stratum 3).
**Implication:** Capture mode produces identical events to real-time execution for Stratum 1-2.

## SV4: Three-Clock Separation
**Statement:** Wall clock (setInterval), audio clock (AudioContext.currentTime), and virtual clock (scheduler) are independent. Only schedAheadTime bridges virtual → audio.
**Causal status:** STRUCTURAL — architecture design.
**Breaks when:** Code reads wall clock directly or ties virtual time to real time.
**Implication:** Wall clock jitter does not affect audio timing.

## SV5: sync Inherits Cue's Virtual Time
**Statement:** When a task calls sync(:name) and a matching cue fires, the syncing task's virtual time is set to the cue's virtual time.
**Causal status:** CAUSAL — this is how Sonic Pi keeps threads synchronized.
**Breaks when:** sync just resumes without updating virtual time.
**Implication:** After sync, the two tasks share the same beat position.

## SV6: Hot-Swap Preserves Virtual Time
**Statement:** When a live_loop's body is replaced (hot-swap), the task's virtual time position is preserved. Only the function changes.
**Causal status:** STRUCTURAL — defines live coding behavior.
**Breaks when:** Re-evaluate restarts loops from virtualTime=0.
**Implication:** No timing discontinuity on code change.

## SV7: SuperSonic Node is Standard AudioWorkletNode
**Statement:** sonic.node is a standard Web Audio AudioWorkletNode. It can be connected to any Web Audio node (AnalyserNode, GainNode, etc.).
**Causal status:** STRUCTURAL — SuperSonic's architecture.
**Breaks when:** N/A.
**Implication:** Motif visualization pipeline (AnalyserNode tap) works identically to superdough.

## SV8: WAV Observation Over Event Log Inference (Lokayata)
**Statement:** The event log shows what the scheduler INTENDED. The WAV shows what scsynth PRODUCED. When they disagree, the WAV is truth.
**Causal status:** EPISTEMIC — defines what counts as verification in this project.
**Breaks when:** Event log is treated as sufficient proof of audio correctness.
**Implication:** Every audio fix must be verified by capturing and analyzing the WAV file. Event log verification is necessary but not sufficient.

## SV9: Message Batching Per Sleep
**Statement:** All play/sample/control calls between sleeps are queued and dispatched as ONE OSC bundle with a single NTP timetag. Events between sleeps share the same audio timestamp.
**Causal status:** STRUCTURAL — matches Sonic Pi's `__schedule_delayed_blocks_and_messages!`.
**Breaks when:** Messages are sent individually instead of batched.
**Implication:** Chord notes (play 60; play 64; play 67; sleep 1) all trigger at the exact same sample boundary.

## SV10: Mixer Inside scsynth
**Statement:** The master mixer (limiter, gain staging, DC correction) runs as a synthdef INSIDE scsynth, not as Web Audio nodes outside.
**Causal status:** STRUCTURAL — matches Sonic Pi's sonic-pi-mixer.
**Breaks when:** Limiting/gain is done in Web Audio (different DSP, different latency).
**Implication:** Audio output characteristics match desktop Sonic Pi exactly (same limiter algorithm, same gain staging).

## SV11: sync Waits for Fresh Cue Only
**Statement:** `waitForSync(name)` always waits for a NEW cue event fired AFTER the sync call. It never resolves from stale cueMap entries.
**Causal status:** CAUSAL — matches Sonic Pi's `sync` which waits for events strictly AFTER the current position.
**Breaks when:** sync resolves from a pre-existing cueMap entry (stale cue).
**Implication:** Synced loops wait for the sync target's NEXT iteration, not the current one.

## SV12: BPM Scales Time Parameters
**Statement:** All time-based synth parameters (attack, decay, sustain, release, slide times) must be multiplied by `60/BPM` before sending to scsynth. scsynth interprets them as seconds.
**Causal status:** CAUSAL — matches Sonic Pi's `scale_time_args_to_bpm!`.
**Breaks when:** Raw beat values are sent to scsynth as seconds.
**Implication:** At BPM 130, `release: 1` (1 beat) becomes 0.4615 seconds, not 1.0 seconds. Without this, all envelopes are ~2x too long at typical BPMs.
**Status:** IMPLEMENTED — SoundLayer.scaleTimeParamsToBpm() in src/engine/SoundLayer.ts.

## SV13: Top-Level FX Persists Across Loop Iterations
**Statement:** A `with_fx` block wrapping a `live_loop` at the top level creates the FX node ONCE. The node persists for the lifetime of the live_loop. It is NOT recreated per iteration.
**Causal status:** STRUCTURAL — matches Sonic Pi's GC thread pattern where subthread.join blocks forever on the live_loop.
**Breaks when:** FX is wrapped inside the loop body (recreated every iteration).
**Implication:** One echo/reverb/etc. node, not hundreds. No FX zombie accumulation.
**Status:** IMPLEMENTED — persistentFx in SonicPiEngine creates FX on first iteration, reuses across subsequent.

## SV14: Symbol References Resolve Before Normalization
**Statement:** Symbolic defaults in synth params (e.g., `decay_level: :sustain_level`) resolve to their target param's value before BPM scaling or any other normalization.
**Causal status:** CAUSAL — matches Sonic Pi's `normalise_args!` which resolves symbols before `scale_time_args_to_bpm!`.
**Breaks when:** BPM scaling runs before symbol resolution (would scale a missing value instead of the resolved one).
**Implication:** With `sustain_level: 0.5`, `decay_level` resolves to 0.5 (not the compiled default of 1.0). Order: resolve → inject defaults → alias → munge → BPM scale.
**Status:** IMPLEMENTED — SoundLayer.resolveSymbolDefaults() in src/engine/SoundLayer.ts.
