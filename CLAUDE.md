## Project: Sonic Pi Web

Browser-native reimplementation of Sonic Pi's temporal scheduling model in JavaScript.
This has never been done before. You are building the first one.

### Required Reading (in order)
1. `artifacts/ref/THESIS.md` — Full build thesis (architecture, math, implementation outline)
2. `artifacts/ref/SESSION_PROMPT.md` — Implementation guide with phase breakdown and time budget
3. `artifacts/ref/RESEARCH_SONIC_PI_INTERNALS.md` — How desktop Sonic Pi works internally
4. `artifacts/ref/RESEARCH_JS_SCHEDULING.md` — JS async patterns for the scheduler
5. `artifacts/ref/RESEARCH_SUPERSONIC.md` — SuperSonic (scsynth WASM) API reference
6. `artifacts/ref/RESEARCH_MATH_FOUNDATIONS.md` — Formal math (temporal monad, free monad, stratified isomorphism)

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

- **GitHub Project board:** "SonicPi.js Roadmap"
- **Labels:** Priority (`P0`–`P4`) + area (`area: audio`, `area: scheduler`, `area: transpiler`)
- **ROADMAP.md** is the strategic view. Issues are tactical.

---

## Testing Protocol — This Project's Observation Hierarchy

There are THREE levels of observation. Each level catches bugs the previous cannot.
**You must reach Level 3 before declaring anything "works."**

```
Level 1: Unit tests (Vitest)         — "Did the code I expected to run, run?"
Level 2: Event log (capture tool)    — "Did the engine schedule the right events?"
Level 3: Audio WAV analysis          — "Did scsynth actually produce the right sound?"
```

**Level 1 and 2 are INFERENCE. Level 3 is OBSERVATION.**

**Rule: Never say "verified ✓" from the event log alone. The event log is a plan, not proof.**

### Level 1: Unit tests
- `npx vitest run` — 638+ tests, all must pass
- `npx tsc --noEmit` — zero type errors

### Level 2: Event log capture
- `npx tsx tools/capture.ts "code"` — Chromium headed, captures events + screenshots + audio WAV
- `npx tsx tools/capture.ts --file path/to/code.rb --duration 15000`
- `npx tsx tools/capture.ts --firefox` — Firefox headless fallback (no audio capture)

### Level 3: Audio WAV analysis (THE REAL TEST)
The capture tool records audio via Rec button in Chromium and analyzes the WAV:
- Duration, Peak, RMS, Clipping % — compare against original Sonic Pi (RMS ≈ 0.19, clipping < 0.1%)
- Per-beat frequency analysis — ZCR detects kick (low freq) vs snare (bright)

**Reference values (original Sonic Pi, DJ Dave kick+clap code):**
- RMS: 0.19, Peak: 1.0, Clipping: 0.01%
- Kick peak: 0.44, Snare peak: 0.47
- Snare/Kick ratio: 1.06x (snare LEADS)
- Snare-present beats: 13/13 (100%)

### Other tools
- `npx tsx tools/diagnose-audio.ts "code"` — QueryInterpreter (expected) vs browser (actual), diffs events
- `npx tsx tools/spectrogram.ts "code"` — event stream timing analysis. **WARNING:** reads event log, not audio.

---

## Project Catalogues

Location: `artifacts/.anvi/`
- `hetvabhasa.md` — 14 error patterns
- `vyapti.md` — 13 invariants (SV12 and SV13 are NOT YET IMPLEMENTED)
- `krama.md` — 9 lifecycle patterns
- `dharana.md` — 4 boundaries, invariant spans, org health, composition pairs

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

6. **Code comments about desktop behavior are claims, not evidence.** The comment "Sonic Pi passes arg_bpm_scaling: false for FX" was wrong — desktop DOES BPM-scale FX time params (phase, decay, max_phase). This wrong assumption propagated into unit tests and catalogues, passing CI while producing incorrect audio. **Before writing "matches desktop Sonic Pi"**, verify against the actual source: `synthinfo.rb` for `:bpm_scale` tags, `sound.rb` for the normalization chain. When A/B spectrogram comparison shows temporal (not just level) differences, the param transformation pipeline is the first suspect.

7. **Temporal structure reveals param bugs that level analysis misses.** RMS and peak comparisons showed the clap+FX was "1.8x louder" but didn't reveal WHY. Spectrogram analysis showed the echo timing pattern was completely different — echoes at 250ms instead of 115ms. This pointed directly at FX BPM scaling. When spectrograms match in frequency content but differ in temporal pattern, check time-based param handling.
