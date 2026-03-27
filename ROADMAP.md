# Sonic Pi Web — Roadmap

## Completed

### Engine (Phases A-H)
- [x] VirtualTimeScheduler (scheduler-controlled Promise resolution)
- [x] DSL Context (play, sleep, sample, live_loop, cue, sync, with_fx)
- [x] SuperSonic Bridge (scsynth WASM, 127 SynthDefs, samples)
- [x] JS Transpiler (add missing awaits, create executor)
- [x] Ruby Transpiler (real Sonic Pi syntax → JS)
- [x] sync/cue (inter-loop coordination, virtual time inheritance)
- [x] Hot-swap (replace loop body without stopping)
- [x] Capture Mode + Stratum Detection (fast-forward queryArc for S1/S2)
- [x] SonicPiEngine (LiveCodingEngine implementation)
- [x] Friendly Errors
- [x] Chord/Scale system
- [x] Basic Vite playground (index.html + textarea)

### Integration with struCode
- [x] Adapter (struCode imports engine, bridges types)
- [x] Dual-engine demo (Strudel ↔ Sonic Pi tabs)
- [x] Viz handled by adapter (engine is pure music, no viz knowledge)

---

## Phase 1: Standalone App [COMPLETE]

Turn the basic playground into a polished standalone experience that matches Sonic Pi desktop's familiar workspace. This is the open source product — "Sonic Pi in the browser."

### 1.1 App Shell
- [x] Responsive layout: editor (left) + scope + console (right)
- [x] Toolbar: Play, Stop, BPM display, example selector
- [x] Dark theme matching Sonic Pi's aesthetic
- [x] Mobile-friendly (works on tablets)
- [x] `npx sonic-pi-web` CLI launcher

### 1.2 Editor
- [x] CodeMirror 6 (NOT Monaco — lightweight, ~50KB vs ~2MB)
- [x] Ruby syntax highlighting
- [x] Ctrl+Enter to play, Ctrl+. to stop (Sonic Pi keybindings)
- [x] Line numbers, basic error highlighting
- [x] Auto-indent for do/end blocks

### 1.3 Scope Visualization
- [x] Single canvas waveform (raw Canvas API, no p5.js)
- [x] ~30 lines: `getByteTimeDomainData` + `lineTo`
- [x] Three modes matching Sonic Pi: combined stereo, L/R split, lissajous
- [x] Toggle between modes via click

### 1.4 Console / Log Pane
- [x] Show play events: `> Playing :bd_haus`
- [x] Show loop iterations: `> Loop :drums [4]`
- [x] Show errors with friendly messages (FriendlyErrors.ts)
- [x] Timestamp each line
- [x] Auto-scroll, max 500 lines
- [x] Clear button

### 1.5 Example Selector
- [x] 10 starter patterns: drums, melody, ambient, multi-loop, random,
      chords, arpeggios, generative, effects, sync-demo
- [x] Click to load into editor
- [x] Grouped by difficulty: beginner / intermediate / advanced

### 1.6 Constraints
- [x] Zero npm runtime dependencies (SuperSonic from CDN, CodeMirror from CDN or bundled)
- [x] Single HTML file deployable (can be hosted anywhere)
- [x] No React, no framework — vanilla TS
- [x] No p5.js — scope is raw canvas
- [x] Loads in <2 seconds on 3G (87KB gzipped 27KB)

---

## Phase 2: DSL Completion & Control Flow [COMPLETE]

Complete the DSL to cover ~95%+ of real Sonic Pi code.

### 2.1 Foundation (from engine phases)
- [x] chord() + scale() system (30+ chord types, 50+ scale types)
- [x] note() function, note_range(), chord_invert
- [x] Recursive descent parser (default transpiler, b. prefix)
- [x] Friendly error messages with line numbers
- [x] puts / print → console pane
- [x] with_fx framework (bus allocation, FX chaining)
- [x] Tick system (tick/look, named counters, per-builder)
- [x] Array/Ring methods (.reverse, .shuffle, .pick, .take, .drop, .stretch, .mirror)
- [x] rand, rand_i aliases
- [x] unless blocks (trailing + block form)
- [x] N.times do |i| ... end
- [x] loop do ... end
- [x] Bare code wrapping (implicit live_loop :main)

### 2.2 Control Flow
- [x] Block if/elsif/else/end
- [x] define :name do |args| ... end — reusable user functions
- [x] density N do...end — build-time sleep division
- [x] in_thread do...end — fire-and-forget concurrency via thread step

### 2.3 Parameter Sliding
- [x] `_slide` parameters on play/sample (note_slide, amp_slide, cutoff_slide)
- [x] control with node references (s = play 60; control s, note: 65)
- [x] Full pipeline pass-through to SuperSonic/scsynth

### 2.4 FX & Synth Documentation
- [x] KNOWN_FX list (33 FX) with edit-distance suggestions
- [x] Per-synth/FX parameter catalog (SynthParams.ts)
- [x] Friendly error for unknown FX/synth with suggestions

### 2.5 Missing DSL Functions
- [x] at [times] do ... end (time-offset event spawning)
- [x] time_warp N do ... end (sugar for at)
- [x] Sample start:/finish:/loop: parameter pass-through
- [x] beat_stretch / pitch_stretch on samples (approximate)
- [x] String interpolation (Ruby #{expr} → JS `${expr}` backtick conversion)
- [x] .each do |x| ... end (array iteration)
- [x] .map/.select/.reject/.collect { |x| expr } (Ruby block syntax)

### 2.6 Completeness
- [x] MT19937 PRNG alignment (matches Sonic Pi's random output for same seed)
- [x] live_audio :name (mic/line input via getUserMedia)
- [x] begin/rescue/ensure error handling blocks

---

## Phase 3: Security & Education [COMPLETE]

University compliance and institutional deployment.

### 3.1 Sandboxed Execution
- [x] Blocked globals: fetch, XMLHttpRequest, WebSocket, localStorage,
      document, window, navigator, eval (+ 20 more)
- [x] Only DSL functions available in user scope
- [x] Sandbox wrapper around SonicPiEngine.evaluate()
- [x] validateCode() warns about constructor chain escapes

### 3.2 Subresource Integrity
- [x] CDN dependencies pinned to specific versions
- [x] CDN manifest documenting all runtime dependencies
- [x] Note: dynamic import() does not support SRI attributes; versions pinned instead

### 3.3 Content Security Policy
- [x] Strict CSP headers documented in SECURITY.md
- [x] Copy-pasteable configs for nginx and Apache
- [x] Strict (no-CDN) mode documented for bundled deployment

### 3.4 Signed Session Logs
- [x] Every Run/Stop/Edit/LoadExample appended to session log
- [x] SHA-256 hash of code at each action
- [x] Timestamps (ISO 8601)
- [x] Ed25519 signature (HMAC-SHA256 fallback)
- [x] Ctrl+Shift+S to export signed session JSON
- [x] Static verify() method for teacher verification

### 3.5 Code Provenance (v2)
- [ ] Sign individual code snapshots
- [ ] Prove: student X wrote code Y at time Z
- [ ] Export signed submission for LMS integration

---

## Package Structure (ship with v1.0)

Three packages from day one. A developer who finds the engine shouldn't have to
install an editor they don't need. A university IT admin who checks for security
shouldn't have to dig through engine code. Nobody files an issue — they just leave.

### @sonic-pi-web/core
- [ ] Pure engine: VirtualTimeScheduler, DSL, SuperSonic bridge, transpilers
- [ ] Zero security opinion — caller's responsibility
- [ ] ~50KB, MIT license
- [ ] README: "npm install @sonic-pi-web/core" + 5-line usage example
- [ ] For: struCode adapter, custom integrations, power users
- [ ] npm page answers: "Can I embed a Sonic Pi engine?" → Yes

### @sonic-pi-web/sandbox
- [ ] Sandboxed execution wrapper (blocked globals: fetch, DOM, eval)
- [ ] SRI verification for CDN resources
- [ ] Session logging + Ed25519 signing
- [ ] ~10KB, MIT license
- [ ] README: "npm install @sonic-pi-web/sandbox" + education platform example
- [ ] For: education platforms, any app running untrusted student code
- [ ] npm page answers: "Is it safe for my school?" → Yes

### sonic-pi-web (CLI + app)
- [ ] Standalone app (CodeMirror + scope + console + toolbar)
- [ ] Depends on core + sandbox
- [ ] `npx sonic-pi-web` launches browser
- [ ] MIT license
- [ ] README: "npx sonic-pi-web" + screenshot
- [ ] For: end users, teachers, students
- [ ] npm page answers: "Can I use Sonic Pi in my browser?" → Yes

### Monorepo Structure
```
sonic-pi-web/
  packages/
    core/
      src/engine/          ← VirtualTimeScheduler, DSL, SuperSonic, transpilers
      package.json         ← "@sonic-pi-web/core"
    sandbox/
      src/security/        ← Sandbox, SRI, SessionLog, CodeSign
      package.json         ← "@sonic-pi-web/sandbox"
    app/
      src/app/             ← CodeMirror, scope, console, toolbar
      src/index.html
      bin/cli.js           ← npx entry point
      package.json         ← "sonic-pi-web" (depends on core + sandbox)
  package.json             ← workspace root
```

---

## Phase 5: Extensions

### 5.1 Recording / Export
- [ ] Capture AudioContext output to WAV
- [ ] Download button in app toolbar
- [ ] Duration selection (4/8/16/32 bars)

### 5.2 Sample Preview
- [ ] List available samples from SuperSonic CDN
- [ ] Click to preview
- [ ] Search/filter

### 5.3 use_debug / use_timing_warnings
- [ ] Toggle timing warnings when computation > sleep duration
- [ ] Debug output for event scheduling in console

### 5.4 MIDI I/O
- [ ] Web MIDI API output (midi_note_on, midi_cc)
- [ ] MIDI input as cue source (sync(:midi_note))
- [ ] MIDI device selector in toolbar

### 5.5 Ableton Link (via WebRTC)
- [ ] @sonic-pi-web/link-bridge companion (Node.js)
- [ ] WebRTC DataChannel (unreliable mode, ~1-2ms phase lock)
- [ ] SyncComponent for tempo/beat/phase
- [ ] Auto-discover bridge on localhost

### 5.6 Collaborative Editing
- [ ] CRDT sync (Yjs) for shared code buffer
- [ ] WebRTC DataChannel for peer-to-peer
- [ ] Cursor presence (see other users' cursors)
- [ ] Combined with Link sync for phase-locked collaboration

### 5.7 Tree-sitter Parser (v2 — replaces regex transpiler)
- [ ] Tree-sitter WASM with Ruby grammar (~1.5MB)
- [ ] Custom grammar extensions for Sonic Pi DSL
- [ ] Incremental parsing (only re-parse changed regions)
- [ ] Structural AST for code ↔ graph node mapping

**Why NOT in v1.0:**
- The regex transpiler works (190+ tests pass, <1ms per file)
- Typical live coding files are 10-50 lines — full re-parse is <1ms
- Tree-sitter WASM is ~1.5MB — larger than the entire app
- No external consumers need AST access yet

**Why needed in v2:**
- struCode's graph node editor needs AST to map nodes ↔ code bidirectionally
  (user drags a [fast(2)] node → Tree-sitter finds the call in code → updates it)
- Structural diffing for smart hot-swap ("which live_loop changed?")
- Code intelligence (autocomplete, go-to-definition) in struCode's Monaco

**What v1.0 uses instead:**
- Regex-based RubyTranspiler for Ruby → JS conversion
- Full re-evaluate on every Play press (sonicPiWeb standalone)
- Full re-evaluate + scheduler hot-swap on edit (struCode live mode)
- Both are fast enough: <5ms for typical patterns, well within frame budget

**struCode live mode works without Tree-sitter because:**
1. User edits code → Monaco detects change
2. Full re-transpile + re-evaluate (<5ms)
3. VirtualTimeScheduler.reEvaluate() hot-swaps changed loops
4. Unchanged loops keep running at current beat position
5. Viz updates next frame
The "incremental" part is at the scheduler level (which loops changed),
not the parser level (which tokens changed). Hot-swap handles it.

---

## Community & Release Strategy

### Open Source Launch
1. Ship Phase 1 (standalone app) + Phase 3.1-3.3 (sandbox + SRI + CSP)
2. Launch on: Hacker News, Reddit (r/programming, r/livecoding, r/musicprogramming),
   Sonic Pi forums (in-thread.sonic-pi.net), TOPLAP community
3. Headline: "Sonic Pi in the browser — zero install, SuperCollider synthesis"

### struCode Integration
- sonicPiWeb is the engine — struCode is the platform
- struCode's adapter imports @sonic-pi-web/core
- Viz, inline zones, engine switching handled by struCode
- sonicPiWeb never knows about struCode's visualization layer

### Upgrade Path
```
sonic-pi.web (standalone)  →  "Want pianoroll, multi-engine?"  →  Motif / struCode
simple, familiar              power features, embeddable
```
