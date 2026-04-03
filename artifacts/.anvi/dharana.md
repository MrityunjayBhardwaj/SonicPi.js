# Dharana — Focused Attention: Sonic Pi Web

Project-specific instantiation of global principles. Every entry carries ORIGIN/WHY/HOW.
Derived from hetvabhasa (22 patterns, SP22 updated, SP21 partially invalidated), vyapti (15 invariants, SV15 SUPERSEDED), krama (10 lifecycles).

> Every entry references the Ground Truth interpretation layer.
> Internal: `artifacts/ref/GROUND_TRUTH_SONIC_PI_WEB.md` — our engine pipeline
> External: `artifacts/ref/GROUND_TRUTH_{SUPERSONIC,DESKTOP_SP,SONIC_TAU}.md`
> Source code: `artifacts/ref/sources/{supersonic,desktop-sp,sonic-tau}/`
> Meta-prompt that generated Ground Truth docs: `artifacts/ref/GROUND_TRUTH_META_PROMPT.md`
> Chain: dharana entry → REF → Ground Truth doc#stage → REF → source file:line

---

## 1. Project Boundaries

### B1: Transpiler ↔ Engine
FILES: src/engine/TreeSitterTranspiler.ts, src/engine/RubyTranspiler.ts, src/engine/Transpiler.ts, src/engine/Sandbox.ts
ORIGIN: SP7 (browser engine differences in strict mode variable binding).
WHY: Transpiled JS must be valid across Chrome, Firefox, and Node. If transpiler output uses constructs one engine rejects, the failure is silent (syntax error inside `new Function()`). Removing this entry means transpiler regressions bypass detection until a user reports "works in Chrome, broken in Firefox."
HOW: Transpiler outputs JS consumed by Sandbox. Observation targets: run transpiled output through Firefox AND Chrome. Check that `new Function()` doesn't throw.

**Known silent-failure modes:** `var eval` / `let eval` silently fails in Firefox. Bare assignment semantics differ between strict and sloppy mode.
**Observe THEIR side:** Execute the transpiled code in the target engine. Syntax errors inside `new Function()` are swallowed unless you catch them.
**REF:** `Sandbox.ts:5-16` design: new Function + with() proxy, Firefox note; `Sandbox.ts:120-124` sloppy mode construction; `TreeSitterTranspiler.ts` + `RubyTranspiler.ts` transpiler implementations

### B2: AudioInterpreter ↔ SuperSonicBridge (was FATALITY — RESOLVED by SoundLayer)
FILES: src/engine/interpreters/AudioInterpreter.ts, src/engine/SuperSonicBridge.ts, src/engine/SoundLayer.ts, src/engine/osc.ts
ORIGIN: SP8, SP9, SP10, SP11, SP12 all cluster at this boundary. 5 patterns exceeds the 3+ fatality threshold.
WHY: This is the single highest-concentration error boundary. Parameter names change meaning across it (SP9). Time units change across it (SP10). Observation granularity drops across it — event log (our side) diverges from audio output (their side) (SP8). Compiled defaults diverge from documented defaults (SP12). FX lifecycle semantics differ (SP11). Without this boundary tracked as fatality-level, each bug is diagnosed from scratch instead of recognized as a structural class.
HOW: Consolidated into SoundLayer module (src/engine/SoundLayer.ts). All parameter transformation in one module. SuperSonicBridge is now pure OSC transport. Observation targets: for EVERY param change, verify the receiver's actual vocabulary and defaults.

**Known silent-failure modes:** scsynth ignores unrecognized params without error. Compiled synthdef defaults differ from synthinfo.rb documentation. Missing params use compiled defaults, not Sonic Pi's intended defaults.
**Observe THEIR side:** Capture WAV output and analyze. The event log is OUR side (inference). The audio is THEIR side (observation).
**REF:** `SoundLayer.ts` — full normalization pipeline; `AudioInterpreter.ts:4` interpreter description; `SuperSonicBridge.ts:367-401` queueMessage + flushMessages

### B3: SuperSonicBridge ↔ scsynth WASM
FILES: src/engine/SuperSonicBridge.ts, src/engine/osc.ts, src/engine/cdn-manifest.ts
ORIGIN: SP5 (synthdef not loaded), SP9 (param name mismatch at synthdef level), SP12 (compiled default divergence).
WHY: scsynth is a black box — no error on unrecognized params, no error on wrong defaults, no error on missing synthdefs until runtime. Without observation at this boundary, every audio discrepancy requires end-to-end debugging instead of boundary isolation.
HOW: Observation targets: verify synthdef is loaded before `/s_new`. Verify param names match synthdef's actual params (not the DSL aliases). Compare our sent values against synthinfo.rb's documented defaults.

**Known silent-failure modes:** `/s_new` with unloaded synthdef: scsynth logs "SynthDef not found" but JS gets no error. Unrecognized param names: silently ignored. Wrong bus routing: audio plays but doesn't reach output.
**Observe THEIR side:** WAV analysis is the only observation of scsynth's actual output. No other tap point exists.
**REF:** `SuperSonicBridge.ts:4` CDN note; `SuperSonicBridge.ts:477,561,657` /s_new calls to groups 100/101; `SuperSonicBridge.ts:183` loadedSynthDefs

### B4: SonicPiEngine ↔ VirtualTimeScheduler
FILES: src/engine/SonicPiEngine.ts, src/engine/VirtualTimeScheduler.ts
ORIGIN: SP1 (Promise resolution ordering), SP4 (hot-swap timing gap).
WHY: Scheduler controls when async functions resume. If resolution ordering is non-deterministic (SP1) or hot-swap breaks timing continuity (SP4), the symptom is audio glitches — hard to distinguish from other audio bugs without isolating this boundary.
HOW: Observation targets: verify task.virtualTime is monotonic after hot-swap. Verify resolution order is deterministic (sorted by virtualTime, then taskId).

**Known silent-failure modes:** Non-deterministic ordering manifests as subtle timing drift — not an error, just wrong music. Hot-swap gap manifests as audible glitch on code change.
**Observe THEIR side:** Compare event timestamps across runs (determinism check). Listen for glitch on re-evaluate.
**REF:** `VirtualTimeScheduler.ts:89-103` deterministic ordering (SV1, SV3); `VirtualTimeScheduler.ts:147-148,192-198` hot-swap preserves virtualTime (SV6); `SonicPiEngine.ts:108` init lifecycle

### B5: SonicPiEngine.init() ↔ AudioWorklet First process() — DOWNGRADED (was wrongly elevated)
FILES: src/engine/SonicPiEngine.ts, src/engine/SuperSonicBridge.ts, src/app/App.ts
ORIGIN: Silent prophet diagnosis v2 (SP22). 9 failed experiments led to wrong conclusion.
**STATUS: DOWNGRADED.** The "cold-start timing gap" was not the actual bug. The real cause was `env_curve: 2` injection at B2 (SoundLayer). This boundary was elevated based on a misdiagnosis — the "poison node" model, CDP asymmetry, and WASM stabilization theory were all wrong. The init↔AudioWorklet boundary is not a fatality concern.
WHY (revised): This boundary still exists (init timing matters for other reasons) but the specific cold-start failure attributed to it was actually a B2 issue (parameter content, not execution timing). Keeping as reference for investigation history.
HOW (revised): No specific observation targets needed for cold-start. The original targets (measure init-to-process timing, warmup gates) would have been unnecessary complexity.

**Lesson:** A misdiagnosed bug can elevate the wrong boundary. SP22's actual root cause was at B2 (SoundLayer param injection), not B5 (init timing). Always verify the boundary attribution before creating structural responses.

**REF:** SP22 (updated — env_curve: 2, not cold-start); `artifacts/investigations/silent-prophet-diagnosis-v2.md` (conclusions invalidated)

---

## 2. Active Invariant Spans

### SV12: BPM Scales Time Parameters — ALIGNED
**Span:** SoundLayer (normalizePlayParams, normalizeSampleParams, normalizeControlParams, normalizeFxParams)
**Current boundary:** SoundLayer receives raw params + BPM, outputs scaled params. ALL four normalize functions call scaleTimeParamsToBpm. AudioInterpreter and SonicPiEngine both pass currentBpm.
**Status:** ALIGNED — scaleTimeParamsToBpm scales TIME_PARAMS set + any `*_slide` suffix by 60/BPM. Covers synths, samples, control messages, AND FX.
**Lesson (SP17):** The original implementation claimed FX was exempt. This was wrong — verified against desktop source (synthinfo.rb tags FX phase/decay/max_phase with :bpm_scale => true). Fixed in #66.

### SV13: Top-Level FX Persists Across Iterations — ALIGNED
**Span:** SonicPiEngine (pendingFxChains + persistentFx state)
**Current boundary:** FX chain captured at registration. Nodes created on first iteration via persistentFx. Cleared on stop/re-evaluate.
**Status:** ALIGNED — FX nodes persist across iterations. No zombie accumulation.

### SV14: Symbol References Resolve Before Normalization — ALIGNED
**Span:** SoundLayer (resolveSymbolDefaults, first step after strip)
**Status:** ALIGNED — decay_level: :sustain_level resolved before BPM scaling.

### SV9: Message Batching — ALIGNED
**Span:** AudioInterpreter (calls flushMessages on sleep) + SuperSonicBridge (maintains queue, encodes bundle)
**Current boundary:** Clean split — interpreter controls timing, bridge controls encoding.
**Status:** ALIGNED

### SV10: Mixer Inside scsynth — ALIGNED
**Span:** SuperSonicBridge only (creates mixer node, sets params)
**Status:** ALIGNED — contained in single module.

### SV8: WAV Over Event Log — EPISTEMIC (cross-cutting)
**Span:** All observation code. Not a module boundary — an observation discipline.
**Status:** ALIGNED as practice, enforced by Testing Protocol Level 3.

### SV15: Cold-Start Warmup Required — SUPERSEDED
**Status:** SUPERSEDED — the cold-start model was wrong. See vyapti SV15 (SUPERSEDED) and hetvabhasa SP22 (updated root cause: env_curve: 2, not timing).
**Lesson:** A misalignment diagnosis based on an ungrounded hypothesis creates false architectural requirements. The "warmup gap" would have been unnecessary complexity.
**REF:** SP22 (updated); SV15 (SUPERSEDED)

---

## 3. Lens Configuration

### Active Axes (ordered by frequency in this project)
1. **Boundary** — 7 hetvabhasa patterns (SP8, SP9, SP10, SP11, SP12, SP21, SP22). Primary axis.
2. **Content-vs-context** — 3 patterns (SP20, SP21, SP22). NEW axis replacing "cold-start". When path A works and path B doesn't, diff the MESSAGE CONTENT at the boundary before diffing the execution CONTEXT. The silent prophet investigation spent 20+ experiments on context (timing, CDP, Worker) when the answer was content (env_curve: 2 present vs absent).
3. **Timing/lifecycle** — 3 patterns (SP1, SP4, SP11). Secondary axis. (SP22 removed — was not a timing issue.)
4. **Data-flow** — 2 patterns (SP3, SP14). Tertiary.
5. **Ownership** — 2 patterns (SP11, SP13). Tertiary.

### Instantiated Lens Steps

**Diagnose phase 3 (scan boundaries) → for this project:**
- B1 (transpiler↔engine): Does transpiled output parse in all target engines?
- B2 (interpreter↔bridge): Do param names match synthdef vocabulary? Are time params scaled by BPM? Is env_curve: 2 **NOT** sent (SP22 — causes silence for overlapping synths in WASM scsynth)? Are FX time params (phase, decay, max_phase) ALSO scaled?
- B3 (bridge↔scsynth): Is synthdef loaded? Do sent values match synthinfo.rb expectations?
- B4 (engine↔scheduler): Is virtual time monotonic? Is resolution order deterministic?

**Review check 5 (error susceptibility) → for this project:**
- At B2: SP9 trap (assume param names pass through unchanged). SP12 trap (assume compiled default matches intent). **SP17 trap (assume a code comment about desktop behavior is correct without verifying against desktop source).**
- At B3: SP5 trap (assume synthdef is pre-loaded). Silent failure if not.
- At B1: SP7 trap (assume JS runs identically across engines).

**Design phase 2 (invariants) → for this project:**
- SV12 ALIGNED: BPM scaling consolidated in SoundLayer for ALL param types (synth, sample, control, FX). New designs touching params inherit correct scaling.
- SV13 ALIGNED: Persistent FX via scope-based sharing. New designs touching FX inherit persistence.

**Reference verification gate (SP17 prevention) → for this project:**
- For EVERY normalization rule claiming to "match desktop," verify against the ACTUAL source:
  - `synthinfo.rb` for `:bpm_scale` tags on each param
  - `sound.rb` for the `normalise_and_resolve_synth_args` chain
  - `sound.rb` for `trigger_fx` vs `trigger_synth` differences
- Code comments are CLAIMS, not EVIDENCE. A comment saying "Sonic Pi does X" must cite the source file and line.
- When A/B spectrogram comparison shows temporal (not just level) differences, the param transformation pipeline is the first suspect.

### Observation Tools and Gaps

| Assertion level | Tool | Status |
|----------------|------|--------|
| Logic (correct transforms) | Vitest — 699+ tests | EXISTS |
| Data flow (param pipeline) | Unit tests for SoundLayer (61 tests) | EXISTS |
| Integration (engine E2E) | `tools/capture.ts` — Chromium + events | EXISTS |
| System boundary (both sides) | WAV analysis in capture tool | EXISTS |
| Runtime output (actual audio) | WAV frequency/RMS analysis | EXISTS |
| Temporal (timing correctness) | Spectrogram + temporal envelope analysis (scipy) | EXISTS |
| Temporal (FX timing) | A/B echo/delay spacing comparison vs desktop | EXISTS (notebook Step 9) |
| Reference verification | Desktop source audit (synthinfo.rb, sound.rb) | MANUAL (see SP17 gate) |
| Composition (changes together) | E2E capture with all fixes active | TO BUILD |
| Resource (no leaks) | No tool — count scsynth nodes over time | BLIND SPOT |
| Isolation (bypass engine) | `tools/raw-osc-test.ts` — raw OSC to SuperSonic | EXISTS |

**Blind spot (resolved): reference assumption verification.** SP17 — wrong claim about desktop behavior encoded in comments, tests, and catalogues. Caught by temporal envelope analysis showing FX timing diverged. Prevention: reference verification gate added above. Every "matches desktop" claim must cite desktop source.

**Blind spot: resource leak detection.** No tool currently counts scsynth node accumulation over time. SP11 (FX zombie nodes) was caught by ear (audio gets washy), not by measurement. ORIGIN: SP11 diagnosis required observation but no tool existed. WHY: without this, resource leaks are detected by symptom (degraded audio, CPU spike), not by direct measurement. HOW: tool that queries scsynth node count at intervals during capture, flags monotonic growth.

---

## 4. Organizational Health

### Fatality Test Results

| Test | Result | Detail |
|------|--------|--------|
| Hetvabhasa clustering (3+ at boundary) | **RESOLVED (was FATALITY at B2)** | SoundLayer consolidates SP9/SP10/SP12. SP11 fixed by persistentFx. SP8 mitigated by Level 3 testing protocol. SP15/SP16/SP17 at B2/B3 boundary — all fixed. SP17 (wrong assumption) added reference verification gate to prevent recurrence. |
| Vyapti spanning (invariant across 3+ modules) | **RESOLVED (was FATALITY at SV12)** | SV12 now ALIGNED — single module (SoundLayer) owns BPM scaling. |
| Krama crossing (lifecycle crosses 3+ boundaries) | **WARNING at SK4** | Audio message pipeline crosses 4 boundaries: DSL → ProgramBuilder → AudioInterpreter → SuperSonicBridge → scsynth |

### Approaching Threshold (watch list)
- B4 (engine↔scheduler): 2 patterns (SP1, SP4). One more → fatality.
- B1 (transpiler↔engine): 1 pattern (SP7). Currently safe.

### Completed Interventions
- **SoundLayer module** (src/engine/SoundLayer.ts) resolves B2 fatality + SV12 span mismatch + SV13 span mismatch.
- B2 patterns SP9/SP10/SP12 addressed by normalizePlayParams pipeline (aliasing, BPM scaling, env_curve injection).
- SP11 addressed by persistentFx in SonicPiEngine (top-level FX created once, not per iteration).
- SK4 crossing count reduced by 1 — SoundLayer absorbs the normalization boundary.

---

## 5. Composition Pairs — SoundLayer Phase

The 4 P0 fixes interact. These pairs need composition verification:

| Fix A | Fix B | Interaction | Observation needed |
|-------|-------|-------------|-------------------|
| BPM scaling (G_NEW.1) | Symbol resolution (G_NEW.4) | Symbol resolves `decay_level: :sustain_level` THEN BPM scales the resolved value. Order matters. | Unit test: resolve symbols first, then scale. Verify scaled value = resolved_value × 60/BPM. |
| BPM scaling (G_NEW.1) | env_curve injection (G_NEW.13) | env_curve injection DISABLED (SP22 — causes silence for overlapping synths in WASM scsynth). Compiled default (linear) used instead. BPM scaling interaction no longer relevant. | Verify env_curve: 2 is NOT sent in OSC messages. |
| BPM scaling (G_NEW.1) | FX persistence (G_NEW.2) | Persistent FX node created with BPM at creation time. FX time params (phase, decay, max_phase) ARE BPM-scaled — desktop Sonic Pi tags them :bpm_scale => true. Non-time FX params (room, damp, mix) are NOT scaled. | Capture: set BPM 130, verify echo phase is 0.25*60/130=0.115s, not 0.25s raw. |
| FX persistence (G_NEW.2) | Symbol resolution (G_NEW.4) | FX params might contain symbol references. Resolution must happen before FX creation. | Unit test: FX opts with symbol refs resolve correctly at creation time. |

---

## 6. Ground Truth Inventory

| System | Ground Truth Doc | Source Location | Last Verified | Opaque Regions |
|--------|-----------------|-----------------|---------------|----------------|
| **Sonic Pi Web** | GROUND_TRUTH_SONIC_PI_WEB.md | src/engine/ | 2026-04-03 | None (our code) |
| SuperSonic | GROUND_TRUTH_SUPERSONIC.md | artifacts/ref/sources/supersonic/ | 2026-04-02 | WASM scsynth internals, AudioWorklet stabilization timing |
| Desktop SP | GROUND_TRUTH_DESKTOP_SP.md | artifacts/ref/sources/desktop-sp/ | 2026-04-02 | scsynth C++ internals, SuperCollider UGen execution |
| Sonic Tau | GROUND_TRUTH_SONIC_TAU.md | artifacts/ref/sources/sonic-tau/ | 2026-04-02 | WASM VM internals, bytecode format |

Catalogue REFs point to internal source (our code). External GT docs consulted on demand for parity verification.
