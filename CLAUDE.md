## Project: Sonic Web

Browser-native reimplementation of Sonic Pi's temporal scheduling model in JavaScript.
This has never been done before. You are building the first one.

### Required Reading (in order)
> **Note:** Reference docs live in `~/.anvideck/projects/sonicPiWeb/ref/` (not in the repo).
1. `ref/THESIS.md` — Full build thesis (architecture, math, implementation outline)
2. `ref/SESSION_PROMPT.md` — Implementation guide with phase breakdown and time budget
3. `ref/RESEARCH_SONIC_PI_INTERNALS.md` — How desktop Sonic Pi works internally
4. `ref/RESEARCH_JS_SCHEDULING.md` — JS async patterns for the scheduler
5. `ref/RESEARCH_SUPERSONIC.md` — SuperSonic (scsynth WASM) API reference
6. `ref/RESEARCH_MATH_FOUNDATIONS.md` — Formal math (temporal monad, free monad, stratified isomorphism)

### Ground Truth Documents (code-level pipeline traces with file:line citations)
7. `ref/GROUND_TRUTH_SONIC_PI_WEB.md` — **Our engine** end-to-end: Ruby code → transpile → sandbox → ProgramBuilder → AudioInterpreter → SoundLayer → OSC → audio
8. `ref/GROUND_TRUTH_SUPERSONIC.md` — SuperSonic end-to-end: send() → transport → AudioWorklet → WASM → audio
9. `ref/GROUND_TRUTH_DESKTOP_SP.md` — Desktop Sonic Pi end-to-end: eval → normalize → sleep → OSC → scsynth
10. `ref/GROUND_TRUTH_SONIC_TAU.md` — Sonic Tau end-to-end: editor → compiler → SPSC → AudioWorklet VM → OSC → audio
11. `ref/GROUND_TRUTH_META_PROMPT.md` — The meta-prompt that generated Ground Truth docs

### Reference Source Code (downloaded locally)
- `ref/sources/supersonic/` — SuperSonic JS source from GitHub (22 files, ~11K lines)
- `ref/sources/desktop-sp/` — Desktop Sonic Pi Ruby source (7 files, ~17K lines)
- `ref/sources/sonic-tau/` — Sonic Tau demo JS source (7 files, ~25K lines)

> All `ref/` paths above resolve to `~/.anvideck/projects/sonicPiWeb/ref/`.

### The Core Innovation
`sleep()` returns a Promise that ONLY the VirtualTimeScheduler can resolve.
This gives JavaScript cooperative concurrency with virtual time.
Previous attempts tried to make sleep block the JS thread (impossible).
Our insight: you don't need blocking, you need scheduler-controlled Promise resolution.

### Architecture Principle: Match the Reference, Not the Shortcut

When deciding where to place a fix or feature, optimize for **structural parity with desktop Sonic Pi**, not for the smallest diff. If Sonic Pi has a dedicated layer (e.g., `sound.rb` for param normalization), we need an equivalent standalone module (`SoundLayer.ts`), not inline patches scattered across existing files.

**Why:** Inline fixes are faster to ship but create diminishing returns — each new gap requires inspecting disentangled code areas across multiple files. A standalone module that mirrors the reference 1:1 gives us:
- One place to audit against `sound.rb` line by line
- Visible, explicit divergences (not hidden in unrelated functions)
- A surface area that scales: future gaps are additions to one module, not hunts across many

**The rule:** If Sonic Pi solves a class of problems in a single layer, we solve it in a single module. Don't scatter it just because the individual fixes are small. The right abstraction boundary comes from the reference architecture, not from implementation convenience.

### Architecture Decisions — Don't Revisit Without Understanding Why

These decisions were validated through debugging. Don't change them unless the underlying assumption changes.

**Free Monad / Algebraic Effects:**
ProgramBuilder builds `Step[]` data (the free monad). Two interpreters:
- AudioInterpreter — real-time execution via scheduler Promises
- QueryInterpreter — instant O(n) array walk for capture/visualization
The system IS algebraic effects: Step = operation signature, Program = free model, interpreters = effect handlers, scheduler = cofree comonad dual, await = perform, tick() = handler resume.

**Stratified Isomorphism:**
- S1 (deterministic) → AudioHandler ≅ QueryHandler (full isomorphism)
- S2 (seeded random) → isomorphic per-seed (randomness resolves at build time)
- S3 (sync/cue) → non-isomorphic (sync is non-algebraic, needs global handler)

**Sandbox: Proxy-Based `with()` Scope:**
Parameter shadowing failed cross-browser (Firefox + SES). Proxy wraps user code in `with(__scope__)` where scope intercepts all lookups. `has()` returns true for everything → bare assignments go through `set` trap into scope-isolated storage. `let`/`const` bypass the proxy entirely — that's why the transpiler emits bare assignments (Opal/CoffeeScript pattern).

**FX Bus Routing:**
`with_fx` allocates private audio bus, runs inner program with modified outBus, restores on exit. FX step contains sub-Program + nodeRef for control(). AudioInterpreter stores applyFx() node ID in nodeRefMap.

**Transpiler: Tree-sitter Partial Fold (NOT a catamorphism):**
Partial fold over the Sonic Pi subset of the Ruby grammar (~60 semantic handlers, recursive traversal for structural wrappers, warning for unrecognized leaves). NOT exhaustive over all ~150 Ruby node types — that's the wrong goal for a CST. Falls back to regex transpiler if tree-sitter fails.

**Variable Assignment:** Bare assignment (no `let`/`const`) so the Sandbox Proxy captures writes. Matches Ruby's mutable semantics and Opal's approach.

### Build Target
Implementation lives in `src/engine/` (this is a standalone package).
The engine implements `LiveCodingEngine` from the Motif editor package (`@motif/editor`).
The Motif monorepo is at `../struCode/` — reference `DemoEngine.ts` and `StrudelEngine.ts` there.

### Phase Order: A → B → C → D → E → F → G → H (skip I, J for v1)
Phase A (VirtualTimeScheduler) is the hard part. Get it rock-solid before moving on.

### Constraints
- SuperSonic GPL core: load via CDN, never bundle
- Atomic commits per phase
- Tests via Vitest
- This is a SEPARATE package — does not modify struCode

---

## Project-Specific Workflow Additions

Global AnviDev workflow applies. These are the project-specific additions:

- **GitHub Project board:** "SonicWeb Roadmap"
- **Labels:** Priority (`P0`–`P4`) + area (`area: audio`, `area: scheduler`, `area: transpiler`)
- **ROADMAP.md** is the strategic view. Issues are tactical.

---

## Testing Protocol — This Project's Observation Hierarchy

Levels 1–2 are INFERENCE; Level 3 (audio) is OBSERVATION. **You must reach Level 3 before declaring anything "works."** Never say "verified ✓" from the event log alone — the event log is a plan, not proof.

- **Level 1 — Unit tests:** `npx vitest run` (all pass) + `npx tsc --noEmit` (zero errors).
- **Level 2 — Event log:** `npx tsx tools/capture.ts --file x.rb --duration 15000` (Chromium; `--firefox` = headless, no audio).
- **Level 3 — Audio:** `npx tsx tools/compare-desktop-vs-web.ts --file x.rb` (desktop SP via OSC + web + analysis) or `tools/capture.ts` for web-only WAV. **Diagnostic tools:** `tools/pitchtrack.py <wav>` (Tier-1 sequence), `tools/diagnose-audio.ts` (expected vs actual events), `tools/spectrogram.ts` (⚠ event log, not audio).

### MANDATORY: The 6-Tier Audio Analysis Standard (issue #346, vyapti SV46)

**Every Level-3 audio analysis MUST cover all six tiers. No silent omission — a tier the tool can't compute prints `not analysed` explicitly.** `compare-desktop-vs-web.ts` emits all six.

```
Tier 0  Validity gates   HARD fail (missing WAV / SR mismatch) ⇒ verdict INVALID,
                          pitch unreliable. SOFT fail (window misalign >0.5s) ⇒
                          Tier-3 + onset-count unreliable; Tier-1 pitch STILL VALID
                          (it is prefix-compared, robust to misalignment).
Tier 1  Musical correctness — THE VERDICT. Pitch-track / note progression, tempo
                          (inter-onset), rhythm, note duration, polyphony,
                          determinism. Energy/MFCC are BLIND to wrong melody (SP93).
Tier 2  Spectral/timbral (SUPPORTING ONLY). mel-L2, MFCC (mandatory caveat:
                          confounded by ~0.5× gain + reverb tail), per-band, peak
                          freq, spectral TEMPORAL pattern (echo ms reveals FX bpm).
Tier 3  Level/gain (reported, NOT a musical blocker). RMS/peak/clip + ratios,
                          per-beat gain. Ref: RMS≈0.19, clip<0.1%.
Tier 4  FX/routing. Tail decay, FX timing ms (bpm-scaled), accumulation-vs-
                          suppression 200ms boundary scan, per-FX-scope energy.
Tier 5  Stability/lifecycle. Run/Stop/hot-swap, cold-start, long-run drift.
```

**The iron rule (the SP93 / #344 lesson):** Tier 1 is the verdict. **Tiers 2–3 may NEVER override Tier 1.** A high MFCC with a Tier-1 PITCH-MATCH means timbre/gain, not wrong notes — report it as such, never as "unrelated / different synth." Tier 0 + Tier 1 are mandatory for *every* audio analysis; Tiers 4–5 mandatory when FX / multi-cycle is in scope.

**Reference values (original Sonic Pi, DJ Dave kick+clap):** RMS 0.19 · Peak 1.0 · Clip 0.01% · Kick peak 0.44 · Snare peak 0.47 · Snare/Kick 1.06× (snare LEADS) · Snare-present 13/13.

---

## Grounded Debugging Methodology

### Two-Track Grounding

**Internal (our code):** Catalogue entries describe our own patterns, invariants, lifecycles.
```
Catalogue entry (compact)     ← hetvabhasa, vyapti, krama, dharana
    ↓ REF: our-file.ts:line
Our source code (ground truth) ← src/engine/
    ↓ traced in
GROUND_TRUTH_SONIC_PI_WEB.md  ← full pipeline trace with file:line citations
```

**External (reference systems):** Ground Truth docs for systems we depend on or model after.
```
GROUND_TRUTH_SUPERSONIC.md    ← SuperSonic pipeline (external, opaque past WASM)
GROUND_TRUTH_DESKTOP_SP.md    ← Desktop Sonic Pi pipeline (the reference we match)
GROUND_TRUTH_SONIC_TAU.md     ← Sonic Tau pipeline (comparison architecture)
    ↓ cite
External source code          ← ~/.anvideck/projects/sonicPiWeb/ref/sources/{supersonic,desktop-sp,sonic-tau}/
```

Catalogue REFs point to our own source. External GT docs are consulted on demand when verifying parity claims or debugging at system boundaries. If a catalogue entry lacks a REF, it is ungrounded — add one.

### The Rule: Source Code First, Hypothesis Second
Before forming ANY hypothesis about a bug:
1. Read the relevant Ground Truth document (internal: `GROUND_TRUTH_SONIC_PI_WEB.md`, external: the relevant system's GT doc)
2. Cite the specific code block supporting your hypothesis
3. If no Ground Truth doc covers the area, create one using `~/.anvideck/projects/sonicPiWeb/ref/GROUND_TRUTH_META_PROMPT.md`

### Provenance Chain (every fix must trace back)
```
Fix → Experiment that proved it → Hypothesis → Source code line (cited in GT doc)
```
If any link is missing, the fix is ungrounded.

### When to Save Insights to Catalogues
Save ONLY when a finding:
1. Contradicts a current catalogue entry (update immediately)
2. Reveals a new error pattern with REF to Ground Truth (add to hetvabhasa)
3. Confirms or refutes an invariant with REF to Ground Truth (update vyapti)
Do NOT save routine experiment results. Save ONLY high-entropy findings that change the worldview.

---

## Project Catalogues

Location: `~/.anvideck/projects/sonicPiWeb/.anvi/`
- `hetvabhasa.md` — 22 error patterns (SP1-SP22), each with REF to our source code
- `vyapti.md` — 15 invariants (SV15 NOT YET IMPLEMENTED — cold-start warmup)
- `krama.md` — 10 lifecycle patterns (SK10 = cross-platform cold-start comparison)
- `dharana.md` — 5 boundaries (B5 = init↔AudioWorklet stability), invariant spans, org health

Catalogue REFs point to our own `src/engine/*.ts` files. For the full pipeline trace, read `GROUND_TRUTH_SONIC_PI_WEB.md`. For external system behavior, consult the external GT docs.

### Dhyana — Active During SoundLayer Work

**Boundaries in scope:** B2 (AudioInterpreter ↔ SuperSonicBridge) — fatality level, 5 error patterns.
**Invariants in scope:** SV12 (BPM scaling — MISALIGNED), SV13 (FX persistence — MISALIGNED).
**Traps to watch for:**
- SP9: param name on our side ≠ synthdef's param name. Check the receiver's vocabulary for EVERY param.
- SP10: time params are in beats, scsynth expects seconds. Scale by 60/BPM.
- SP12: don't rely on compiled synthdef defaults. Send critical params explicitly (env_curve:2).
- SP11: FX created per iteration. Top-level FX must persist.

**Composition pairs to verify:** BPM scaling × symbol resolution (order matters), BPM scaling × env_curve (must NOT scale env_curve), BPM scaling × FX persistence (FX params not BPM-scaled), FX persistence × symbol resolution (resolve before FX creation).

**On every code change during this phase:** Does this line touch B2? If yes → SP9/10/12 check fires.

### Lokayata Applied to This Project

- After ANY audio-related fix: capture the WAV, analyze frequency content, compare against reference
- After ANY FX routing change: verify the signal reaches bus 0 by checking the WAV, not the event log
- After ANY mixer/volume change: compare RMS and peak against original Sonic Pi reference (RMS ≈ 0.19)
- The sentence "events are correct ✓" is NEVER sufficient for audio work. The audio must be verified.

### Blind Spot Awareness — Learned From This Project

1. **Event log ≠ audio output.** Events can be scheduled correctly while audio is completely broken (wrong bus, missing out_bus, FX not routing). Always check the WAV.

2. **Boundary bugs hide at interfaces.** Every major bug in this project was at a boundary: JS↔scsynth (OSC encoding, NTP timestamps, bus routing), transpiler↔engine (sync: semantics), AudioInterpreter↔SuperSonicBridge (missing out_bus for samples). When debugging, scan EVERY boundary the signal crosses.

3. **Parameter names differ between layers.** Sonic Pi says `cutoff`, the synthdef says `lpf`. Sonic Pi says `basic_stereo_player`, complex opts need `stereo_player`. Always check the synthdef's actual parameter names, not the DSL's names.

4. **Nested wrappers lose outer context.** A single `currentTopFx` variable loses outer FX in nested `with_fx`. A closure-local `didInitialSync` flag doesn't survive hot-swap. Always ask: "does this state survive nesting? Does it survive re-evaluation?"

5. **scsynth group execution order matters.** Synths → FX → mixer must execute in that order. Groups at "head" execute first. `ReplaceOut` overwrites, `Out` adds. Getting the order wrong means the mixer processes an empty bus.

6. **Code comments about desktop behavior are claims, not evidence.** The comment "Sonic Pi passes arg_bpm_scaling: false for FX" was wrong — desktop DOES BPM-scale FX time params (phase, decay, max_phase). This wrong assumption propagated into unit tests and catalogues, passing CI while producing incorrect audio. **Before writing "matches desktop Sonic Pi"**, verify against the actual source: `synthinfo.rb` for `:bpm_scale` tags, `sound.rb` for the normalization chain. When A/B spectrogram comparison shows temporal (not just level) differences, the param transformation pipeline is the first suspect. Similarly, `env_curve: 2` injection to match Desktop SP causes silence in WASM scsynth for overlapping nodes — the WASM build handles this parameter differently from native scsynth.

7. **Temporal structure reveals param bugs that level analysis misses.** RMS and peak comparisons showed the clap+FX was "1.8x louder" but didn't reveal WHY. Spectrogram analysis showed the echo timing pattern was completely different — echoes at 250ms instead of 115ms. This pointed directly at FX BPM scaling. When spectrograms match in frequency content but differ in temporal pattern, check time-based param handling.

8. **Check ALL code paths when adding optimizations — especially overflow/error paths.** Adding rAF batching to Console.log() fixed the normal path but missed Console.rebuild() which ran on buffer overflow — recreating 500 DOM elements synchronously. 12 experiments investigated exotic causes before finding the bypass. **Rule: grep for ALL callers of the unoptimized function.** Full case study: `~/.anvideck/projects/sonicPiWeb/ref/CASE_STUDY_PERFORMANCE_INVESTIGATION.md`

9. **Measure the actual hot function before theorizing.** A single `performance.now()` wrapper would have found the bottleneck in minutes. Profile first, theorize second.

10. **Diff message content before investigating execution context.** The silent prophet bug was attributed to WASM AudioWorklet cold-start timing (SP22 v2) after 9 experiments. The actual cause was `env_curve: 2` injection by SoundLayer — a parameter that was present in engine messages but absent in raw test messages. When path A works and path B doesn't, diff the CONTENT at the boundary before diffing the CONTEXT. The investigation's raw tests lacked env_curve, so they worked — but the conclusion blamed execution context instead of message content.
