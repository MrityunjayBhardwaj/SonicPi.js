# SonicPi.js Roadmap

> Live at [sonicpi.cc](https://sonicpi.cc) | npm: `@mjayb/sonicpijs` | [Docs](https://sonicpi.cc/docs)

---

## P0 — Ship Blockers

These must be fixed before community launch. They are correctness or safety issues.

### ~~Execution Budget (System-Wide)~~ DONE
### ~~Silent Parser Fallback~~ DONE
### ~~Per-Loop Scope Isolation~~ DONE
### ~~Verify DSL Compatibility~~ DONE (82% on real community code — motivates tree-sitter)

### ~~Tree-sitter Ruby Transpiler~~ DONE (#21, PR #35)
Partial fold over Sonic Pi subset of Ruby grammar (~60 semantic handlers).
100% transpile compatibility on community programs. Falls back to regex with warning.

---

## P1 — First Impressions

These affect how the app feels on first use. Fix before sharing widely.

### WASM Boot Experience
- [ ] Show loading progress during SuperSonic initialization
- [ ] Display estimated time remaining
- [ ] Pre-warm AudioContext on first user interaction

### ~~Sample-Accurate Audio Scheduling~~ DONE (PR #40)
OSC bundle timestamps with NTP timetags. Message batching per sleep. sonic-pi-mixer inside scsynth.
FX group lifecycle. sync: first-iteration-only. Hot-swap preserves phase. cutoff→lpf aliasing.
0% jitter confirmed via spectrogram. See `feat/osc-bundle-timestamps` branch.

### SoundLayer — Match Desktop Sonic Pi Audio Pipeline (P0, NEXT)
Root cause of remaining audio discrepancy: missing equivalent of Sonic Pi's `sound.rb` (4000 lines).
Research complete — 27 gaps cataloged in `artifacts/ref/GAP_ANALYSIS_COMPLETE.md`.

**4 P0 gaps (must fix):**
- [ ] **BPM scales time params** — `scale_time_args_to_bpm!`: multiply attack/decay/sustain/release/slide by 60/BPM. At 130 BPM, release:1 = 0.46s not 1.0s. (#44 follow-up)
- [ ] **Top-level FX persistence** — create FX node ONCE at registration, not per iteration. GC blocked by subthread.join. (#45 follow-up)
- [ ] **Symbol resolution** — `decay_level: :sustain_level` for 37 synths. Generic normalise_args. (#47 follow-up)
- [ ] **env_curve: 2** — send explicitly for all synths. Compiled default=1 (linear), Sonic Pi=2 (exponential). (new issue needed)

**P1 gaps (should fix):**
- [ ] Inner synths in FX group (not group 100)
- [ ] Note transposition chain (use_transpose, use_octave, use_cent_tuning)
- [ ] sc808 cutoff→lpf aliasing
- [ ] Per-FX kill_delay (reverb: room*10+1, echo: decay, ping_pong: log formula)
- [ ] FX t_minus_delta timing
- [ ] Control delta staggering
- [ ] spread rotate: strong-beat counting
- [ ] Bus exhaustion graceful degradation

**Reference docs:**
- `artifacts/ref/GAP_ANALYSIS_COMPLETE.md` — full gap details with code references
- `artifacts/ref/RESEARCH_SONIC_PI_DEEP_INTERNALS.md` — 14 sections covering all internals

### Tab Backgrounding
- [ ] Detect `visibilitychange` event
- [ ] Warn user when tab is backgrounded during playback
- [ ] Investigate `Web Locks API` or `Wake Lock API` for prevention

### Compile-Once Caching
- [ ] Cache compiled `new Function()` result per code string
- [ ] Reuse on hot-swap iterations instead of recompiling

---

## P2 — Community Credibility

These make the project look maintained and trustworthy to developers evaluating it.

### Testing & Coverage
- [ ] Add test coverage reporting (Vitest coverage + badge)
- [ ] Run tests against real Sonic Pi tutorial examples
- [ ] Add CI badge to README

### Dependency Management
- [ ] Add Renovate or Dependabot config for automated dependency updates
- [ ] Pin SuperSonic CDN version explicitly

### Documentation
- [ ] Add inline JSDoc to all public API exports
- [ ] Add architecture diagram to docs site
- [ ] Add "Known Limitations" page to docs

---

## P3 — Features

### Recording / Export
- [ ] Capture AudioContext output to WAV
- [ ] Download button in toolbar
- [ ] Duration selection (4/8/16/32 bars)

### Sample Preview
- [ ] List available samples from CDN
- [ ] Click to preview
- [ ] Search/filter

### Monorepo Split
- [ ] `@mjayb/sonicpijs` — pure engine
- [ ] `@mjayb/sonicpijs-sandbox` — sandbox + session logging
- [ ] `sonicpijs` CLI — app + editor

### Code Provenance (v2)
- [ ] Sign individual code snapshots
- [ ] Prove: student X wrote code Y at time Z
- [ ] Export signed submission for LMS integration

---

## P4 — Extensions

### MIDI I/O
- [ ] Web MIDI API output
- [ ] MIDI input as cue source
- [ ] Device selector in toolbar

### Ableton Link
- [ ] WebRTC DataChannel bridge
- [ ] Tempo/beat/phase sync
- [ ] Auto-discover on localhost

### Collaborative Editing
- [ ] CRDT sync (Yjs) for shared buffer
- [ ] WebRTC peer-to-peer
- [ ] Cursor presence

---

## Completed

<details>
<summary>Engine (Phases A-H) + Standalone App + DSL + Security</summary>

- VirtualTimeScheduler (scheduler-controlled Promise resolution)
- DSL Context (play, sleep, sample, live_loop, cue, sync, with_fx)
- SuperSonic Bridge (scsynth WASM, 127 SynthDefs, samples)
- JS Transpiler + Ruby Transpiler (recursive descent parser)
- sync/cue, hot-swap, capture mode, stratum detection
- SonicPiEngine (LiveCodingEngine implementation)
- Chord/Scale system (30+ chord types, 50+ scales)
- Friendly errors, session logging, Ed25519 signing
- Proxy-based sandbox (blocked globals)
- CodeMirror 6 editor, scope visualization, console
- 10 built-in examples, CLI launcher
- Content Security Policy documentation
- 489 tests passing (479 unit + Playwright E2E)

</details>

<details>
<summary>Audio Parameter Pipeline (PR #29, #35) — 2026-03-30</summary>

- Notes sent to SuperSonic — `step.note` included in synth params (#23)
- QueryInterpreter tick advancement via ProgramFactory (#22)
- Redundant `freq` removed — synthdefs convert MIDI internally (#24)
- Recursive FX duration calculation (#26)
- BPM propagation out of FX blocks (#34)
- Sample duration → null instead of misleading 1s (#27)
- ProgramFactory seed advances per iteration (#30)
- Note override protection — step.note wins over opts (#31)
- Diagnose tool: seconds not beats, top-level use_bpm/use_synth captured (#33)
- Diagnostic tools: capture.ts, diagnose-audio.ts, spectrogram.ts
- 622 tests passing (578 unit + 44 Playwright E2E)

</details>
