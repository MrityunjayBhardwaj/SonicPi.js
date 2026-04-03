# Invariants — Sonic Pi Web

> Every invariant references the Ground Truth interpretation layer.
> Internal: `artifacts/ref/GROUND_TRUTH_SONIC_PI_WEB.md` — our engine pipeline
> External: `artifacts/ref/GROUND_TRUTH_{SUPERSONIC,DESKTOP_SP,SONIC_TAU}.md`
> Source code: `artifacts/ref/sources/{supersonic,desktop-sp,sonic-tau}/`
> Chain: catalogue entry → REF → Ground Truth doc#stage → REF → source file:line

## SV1: Virtual Time Monotonicity
**Statement:** For each task T, virtualTime(T) is non-decreasing and advances only on sleep() or sync().
**Causal status:** STRUCTURAL — defines the temporal model.
**Breaks when:** Never (by construction).
**Implication:** All events between two sleeps share the same virtual timestamp (chord semantics).
**REF:** `VirtualTimeScheduler.ts:89` SV1 comment; `VirtualTimeScheduler.ts:244-245` virtualTime advances only on sleep; `VirtualTimeScheduler.ts:293` virtualTime set on sync

## SV2: Scheduler-Exclusive Promise Resolution
**Statement:** A Promise returned by sleep() can ONLY be resolved by the scheduler's tick() method.
**Causal status:** CAUSAL — the Promise has no timeout, no microtask trigger.
**Breaks when:** Someone adds a setTimeout fallback or resolves outside tick().
**Implication:** The scheduler has complete control over when async functions resume.
**REF:** `VirtualTimeScheduler.ts:85` core innovation comment; `VirtualTimeScheduler.ts:90` SV2 comment; `VirtualTimeScheduler.ts:235,247` sleep() returns Promise only tick() resolves; `VirtualTimeScheduler.ts:40` resolver only called by tick

## SV3: Determinism Under Same Inputs
**Statement:** Given same code + same random seeds + same initial state, the event trace is identical across runs.
**Causal status:** STRUCTURAL — follows from SV1 + seeded random + deterministic priority queue.
**Breaks when:** Code uses Date.now(), Math.random(), or external I/O (Stratum 3).
**Implication:** Capture mode produces identical events to real-time execution for Stratum 1-2.
**REF:** `VirtualTimeScheduler.ts:91,103` deterministic ordering by (time, insertionOrder); `SeededRandom.ts:17-24` SeededRandom MT19937 matches Ruby; `VirtualTimeScheduler.ts:324` tick resolves in deterministic order

## SV4: Three-Clock Separation
**Statement:** Wall clock (setInterval), audio clock (AudioContext.currentTime), and virtual clock (scheduler) are independent. Only schedAheadTime bridges virtual → audio.
**Causal status:** STRUCTURAL — architecture design.
**Breaks when:** Code reads wall clock directly or ties virtual time to real time.
**Implication:** Wall clock jitter does not affect audio timing.
**REF:** `VirtualTimeScheduler.ts:63` audioTime field on SchedulerEntry; `VirtualTimeScheduler.ts:99` schedAheadTime bridges virtual→audio; `VirtualTimeScheduler.ts:331` tick uses getAudioTime() + schedAheadTime; `VirtualTimeScheduler.ts:347` setInterval for wall clock tick

## SV5: sync Inherits Cue's Virtual Time
**Statement:** When a task calls sync(:name) and a matching cue fires, the syncing task's virtual time is set to the cue's virtual time.
**Causal status:** CAUSAL — this is how Sonic Pi keeps threads synchronized.
**Breaks when:** sync just resumes without updating virtual time.
**Implication:** After sync, the two tasks share the same beat position.
**REF:** `VirtualTimeScheduler.ts:284` cueMap.set with task.virtualTime; `VirtualTimeScheduler.ts:293` waiterTask.virtualTime = task.virtualTime on sync resolution

## SV6: Hot-Swap Preserves Virtual Time
**Statement:** When a live_loop's body is replaced (hot-swap), the task's virtual time position is preserved. Only the function changes.
**Causal status:** STRUCTURAL — defines live coding behavior.
**Breaks when:** Re-evaluate restarts loops from virtualTime=0.
**Implication:** No timing discontinuity on code change.
**REF:** `VirtualTimeScheduler.ts:147-148` hot-swap replaces asyncFn, preserves virtualTime; `VirtualTimeScheduler.ts:192-198` hotSwap() method preserves state (SV6)

## SV7: SuperSonic Node is Standard AudioWorkletNode
**Statement:** sonic.node is a standard Web Audio AudioWorkletNode. It can be connected to any Web Audio node (AnalyserNode, GainNode, etc.).
**Causal status:** STRUCTURAL — SuperSonic's architecture.
**Breaks when:** N/A.
**Implication:** Motif visualization pipeline (AnalyserNode tap) works identically to superdough.
**REF:** `SuperSonicBridge.ts:26` sonic.node typed as AudioWorkletNode; `SuperSonicBridge.ts:189` analyserNode field; `SuperSonicBridge.ts:291-301` node connection chain

## SV8: WAV Observation Over Event Log Inference (Lokayata)
**Statement:** The event log shows what the scheduler INTENDED. The WAV shows what scsynth PRODUCED. When they disagree, the WAV is truth.
**Causal status:** EPISTEMIC — defines what counts as verification in this project.
**Breaks when:** Event log is treated as sufficient proof of audio correctness.
**Implication:** Every audio fix must be verified by capturing and analyzing the WAV file. Event log verification is necessary but not sufficient.
**REF:** Epistemic invariant (no single source line). Enforced by Testing Protocol Level 3 in CLAUDE.md. `tools/capture.ts` implements WAV capture + analysis.

## SV9: Message Batching Per Sleep
**Statement:** All play/sample/control calls between sleeps are queued and dispatched as ONE OSC bundle with a single NTP timetag. Events between sleeps share the same audio timestamp.
**Causal status:** STRUCTURAL — matches Sonic Pi's `__schedule_delayed_blocks_and_messages!`.
**Breaks when:** Messages are sent individually instead of batched.
**Implication:** Chord notes (play 60; play 64; play 67; sleep 1) all trigger at the exact same sample boundary.
**REF:** `SuperSonicBridge.ts:367-401` queueMessage + flushMessages; `SuperSonicBridge.ts:218` OSC bundle on sleep comment

## SV10: Mixer Inside scsynth
**Statement:** The master mixer (limiter, gain staging, DC correction) runs as a synthdef INSIDE scsynth, not as Web Audio nodes outside.
**Causal status:** STRUCTURAL — matches Sonic Pi's sonic-pi-mixer.
**Breaks when:** Limiting/gain is done in Web Audio (different DSP, different latency).
**Implication:** Audio output characteristics match desktop Sonic Pi exactly (same limiter algorithm, same gain staging).
**REF:** `SuperSonicBridge.ts:265-284` mixer group creation + sonic-pi-mixer synthdef; `SuperSonicBridge.ts:273` signal chain: pre_amp→HPF→LPF→Limiter.ar→LeakDC→amp→ReplaceOut

## SV11: sync Waits for Fresh Cue Only
**Statement:** `waitForSync(name)` always waits for a NEW cue event fired AFTER the sync call. It never resolves from stale cueMap entries.
**Causal status:** CAUSAL — matches Sonic Pi's `sync` which waits for events strictly AFTER the current position.
**Breaks when:** sync resolves from a pre-existing cueMap entry (stale cue).
**Implication:** Synced loops wait for the sync target's NEXT iteration, not the current one.
**REF:** `VirtualTimeScheduler.ts:305-307` waitForSync always waits for FRESH cue, comment explains never resolves from stale cueMap

## SV12: BPM Scales Time Parameters
**Statement:** All time-based parameters — synth ADSR (attack, decay, sustain, release), ALL `*_slide` params, AND FX time params (phase, max_phase, delay, pre_delay) — must be multiplied by `60/BPM` before sending to scsynth. scsynth interprets them as seconds.
**Causal status:** CAUSAL — matches Sonic Pi's `scale_time_args_to_bpm!`. Desktop tags every time param with `:bpm_scale => true` in synthinfo.rb. FX are NOT exempt — `trigger_fx` calls `scale_time_args_to_bpm!` when `arg_bpm_scaling` is true (default).
**Breaks when:** Raw beat values are sent to scsynth as seconds. For FX: echo/delay phase is too slow, slicer/wobble/tremolo period is too wide.
**Implication:** At BPM 130, `release: 1` becomes 0.4615 seconds; echo `phase: 0.25` becomes 0.115 seconds. Without this, all timing is ~2.17x too slow.
**Status:** IMPLEMENTED — SoundLayer.scaleTimeParamsToBpm() for synths, samples, control, AND FX (#66).
**REF:** `SoundLayer.ts:20-28` TIME_PARAMS set; `SoundLayer.ts:466-482` scaleTimeParamsToBpm; `SoundLayer.ts:211,228,243,271` called from all four normalize functions

## SV13: Top-Level FX Persists Across Loop Iterations
**Statement:** A `with_fx` block wrapping a `live_loop` at the top level creates the FX node ONCE. The node persists for the lifetime of the live_loop. It is NOT recreated per iteration.
**Causal status:** STRUCTURAL — matches Sonic Pi's GC thread pattern where subthread.join blocks forever on the live_loop.
**Breaks when:** FX is wrapped inside the loop body (recreated every iteration).
**Implication:** One echo/reverb/etc. node, not hundreds. No FX zombie accumulation.
**Status:** IMPLEMENTED — persistentFx in SonicPiEngine creates FX on first iteration, reuses across subsequent.
**REF:** `SonicPiEngine.ts:73` persistentFx Map; `SonicPiEngine.ts:305-332` first-iteration creation + reuse

## SV14: Symbol References Resolve Before Normalization
**Statement:** Symbolic defaults in synth params (e.g., `decay_level: :sustain_level`) resolve to their target param's value before BPM scaling or any other normalization.
**Causal status:** CAUSAL — matches Sonic Pi's `normalise_args!` which resolves symbols before `scale_time_args_to_bpm!`.
**Breaks when:** BPM scaling runs before symbol resolution (would scale a missing value instead of the resolved one).
**Implication:** With `sustain_level: 0.5`, `decay_level` resolves to 0.5 (not the compiled default of 1.0). Order: resolve → inject defaults → alias → munge → BPM scale.
**Status:** IMPLEMENTED — SoundLayer.resolveSymbolDefaults() in src/engine/SoundLayer.ts.
**REF:** `SoundLayer.ts:331` resolveSymbolDefaults; `SoundLayer.ts:191` pipeline order comment; `SoundLayer.ts:206` resolve called before scale in normalizePlayParams

## SV15: Cold-Start Warmup Required for Heavy Synths — SUPERSEDED
**Original statement:** Heavy synth nodes require a warmup window after SuperSonic init.
**Status:** SUPERSEDED — the "cold-start" model was wrong. The actual root cause was `env_curve: 2` (exponential) causing silence for overlapping synths in WASM scsynth (SP22 updated). Heavy synths do NOT need warmup. They need env_curve: 1 (linear, compiled default) instead of env_curve: 2 (exponential, injected by SoundLayer).
**What invalidated this:** Re-investigation showed that removing env_curve: 2 injection fixed the "cold-start" bug entirely, regardless of timing or warmup. CDP tests worked because they bypassed SoundLayer (no env_curve injection), not because of execution context timing.
**Lesson:** An invariant based on an ungrounded hypothesis (SP20) produces a false structural requirement. The "warmup window" would have been unnecessary complexity solving a non-existent problem.
**REF:** SP22 (updated root cause); `SoundLayer.ts:346-349` injectMandatoryDefaults
