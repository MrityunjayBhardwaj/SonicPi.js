# SonicPi.js Roadmap

> Live at [sonicpi.cc](https://sonicpi.cc) | npm: `@mjayb/sonicpijs` | [Docs](https://sonicpi.cc/docs)

---

## P0 — Ship Blockers

These must be fixed before community launch. They are correctness or safety issues.

### Execution Budget (System-Wide)
- [ ] AST-level operation counting at every loop back-edge (Luerl-inspired reduction model)
- [ ] Per-loop iteration budget — resets on each `sleep()` call
- [ ] ReDoS guard on transpiler regex patterns
- [ ] Iterator guard on DSL helpers (`note_range`, `ring`, `spread` with degenerate inputs)
- [ ] Scheduler internal loop guard (`tick`, `runLoop`)

### Silent Parser Fallback
- [ ] When recursive descent parser fails, emit a visible warning to the user
- [ ] Log which constructs caused the fallback
- [ ] Track fallback rate in Plausible as a custom event

### Per-Loop Scope Isolation
- [ ] Each `live_loop` gets its own Proxy scope (no shared `scopeBase`)
- [ ] Variables set in one loop cannot bleed into another
- [ ] `get`/`set` global store remains the explicit cross-loop channel

### Verify DSL Compatibility
- [ ] Collect 50+ real Sonic Pi programs from the community/tutorials
- [ ] Run each through the transpiler and record pass/fail
- [ ] Publish actual compatibility % (replace "~95%" with measured number)
- [ ] Document unsupported constructs explicitly

---

## P1 — First Impressions

These affect how the app feels on first use. Fix before sharing widely.

### WASM Boot Experience
- [ ] Show loading progress during SuperSonic initialization
- [ ] Display estimated time remaining
- [ ] Pre-warm AudioContext on first user interaction

### Audio Latency Optimization
- [ ] Verify SuperSonic creates AudioContext with `latencyHint: 'interactive'`
- [ ] Expose `ctx.baseLatency + ctx.outputLatency` in console on init
- [ ] Evaluate reducing `schedAheadTime` from 100ms to 50ms
- [ ] Evaluate tightening tick interval from 25ms to 10ms
- [ ] Document actual latency per platform in docs

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
- 406 tests passing

</details>
