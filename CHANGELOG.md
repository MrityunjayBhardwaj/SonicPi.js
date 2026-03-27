# Changelog

## v1.3.0

### Bug Fixes
- **`with_fx` state corruption** — callback errors no longer leave all subsequent loops permanently wrapped in a phantom FX context; `currentTopFx` is now restored via `try/finally`
- **`validateCode` never ran** — sandbox escape-hatch checks (`constructor`, `__proto__`) are now called during `evaluate()` and surfaced via the print handler
- **`capture.queryRange` return type** — was typed `Promise<unknown[]>`, now correctly `Promise<QueryEvent[]>`; removes the need for callers to cast the result
- **Silent transpiler fallback** — `autoTranspile` now logs a `console.warn` when the parser produces invalid JS or reports errors and falls back to the regex transpiler; both paths are now observable

### New API
- **`engine.hasAudio`** — getter that returns `false` when SuperSonic failed to initialize, so callers know audio is unavailable without inferring it from silent playback
- **`DEFAULT_SCHED_AHEAD_TIME`** — exported constant from `VirtualTimeScheduler`; both the scheduler and engine now share one source of truth instead of two `0.1` literals

### Code Quality
- Named constants replace all magic numbers: MIDI status bytes, WAV format fields, scheduling intervals, musical tuning constants (`A4_MIDI`, `A4_FREQ_HZ`, `SEMITONES_PER_OCTAVE`), pitch bend range, clock rates
- JSDoc on all public `SonicPiEngine` methods: `init()`, `evaluate()`, `play()`, `stop()`, `setVolume()`, `setRuntimeErrorHandler()`, `setPrintHandler()`
- `index.ts` reorganized into three tiers: **Public API**, **Extensions**, **Advanced/internals**
- `midiBridge` public field documented: shell-level device management only, not for bypassing the DSL scheduler
- `ProgramBuilder.play()` and `.sample()` now accept `Record<string, unknown>` opts — removes the double-cast that was hiding the `synth: string` vs `Record<string, number>` mismatch

### npm Package
- `name` corrected to `sonic-pi-web` (was `sonic-pi-web-root`)
- `version` aligned with git tag convention
- `private: true` removed — package is now publishable
- `main` field removed — it was pointing at TypeScript source, which is wrong for a CLI package
- `vite` moved from `devDependencies` to `dependencies` — the CLI requires it at runtime; `npx sonicpijs` was silently broken in fresh installs
- `files` whitelist added — prevents publishing `artifacts/`, `tests/`, `.anvi/`, etc.
- `engines` field added: Node ≥ 18.0.0
- `repository`, `bugs`, `homepage` fields added

---

## v1.2.0

### New Features
- **`stop_loop :name`** — stop a named loop from anywhere in the program, including from inside another loop
- **Multi-line continuation** — statements split across lines with trailing operators (`+`, `-`, `and`, `or`, etc.) are now correctly joined before transpilation
- **Ternary operator** — `condition ? then_val : else_val` syntax supported in both the parser and regex transpiler

### Bug Fixes
- **Word-boundary continuation regex** — words ending in continuation-like suffixes (`color`, `minor`, `razor`, etc.) no longer incorrectly trigger line joining

---

## v1.1.0

### Bug Fixes
- **Ring bracket access** — `ring[i]` now wraps correctly via Proxy; fixes Euclidean rhythm examples that index ring values
- **`play chord(...)`** — pushes one play step per note (matches desktop Sonic Pi chord behaviour)
- **Example switching** — stops engine and drains the lookahead buffer before loading a new example; eliminates audio bleed from the previous loop
- **Arpeggio tick reset** — `ring.tick()` now routes through ProgramBuilder's persistent counter; arpeggios advance correctly across loop iterations instead of restarting from note[0]
- **`beat_stretch` formula** — applies Sonic Pi's exact `rate = (1/N) * existing_rate * (bpm / (60 / duration))` formula; sample duration cached via Web Audio `decodeAudioData` on first load
- **`pitch_stretch` formula** — same rate as `beat_stretch` plus `pitch -= 12 * log2(rate)` compensation; pitch is now truly preserved

### New Features
- **Full MIDI I/O** — complete Web MIDI API integration:
  - Output: `midi_note_on`, `midi_note_off`, `midi_cc`, `midi_pitch_bend`, `midi_channel_pressure`, `midi_poly_pressure`, `midi_prog_change`, `midi_clock_tick`, `midi_start`, `midi_stop`, `midi_continue`, `midi_all_notes_off`
  - Input state: `get_cc(controller, channel: 1)`, `get_pitch_bend(channel: 1)`
  - MIDI input → scheduler cues: incoming note/CC/bend events fire `/midi/note_on` etc., enabling `sync '/midi/note_on'` in live loops
  - Multi-output: `selectOutput()` adds to the active set; all sends go to every selected port simultaneously
  - Continuous MIDI clock: `startClock(bpm)` / `stopClock()` for driving external gear

### Known Limitations (updated)
- `beat_stretch`/`pitch_stretch` use a fallback approximation on the first loop iteration (before sample duration is cached); exact from the second iteration on
- No OSC output, `run_file`, or Ableton Link (browser limitations)

---

## v1.0.0

The first public release of Sonic Pi Web — a browser-native reimplementation of Sonic Pi with SuperCollider synthesis via WebAssembly.

### Standalone App
- Responsive layout: editor (left) + scope + console (right)
- CodeMirror 6 editor with Ruby syntax highlighting and auto-indent
- Three-mode oscilloscope (waveform, mirror, lissajous)
- Console with play events, timestamps, friendly error messages
- 10 built-in examples grouped by difficulty
- 10 buffer tabs with localStorage persistence
- Volume slider, BPM display, recording to WAV
- `npx sonicpijs` CLI launcher
- Single HTML file deployment (87KB, 27KB gzipped)
- Mobile-friendly with touch-sized controls

### DSL Coverage (~95% of Sonic Pi syntax)

**Playback:** `play`, `sample`, `use_synth`, `use_bpm`, `sleep`, `stop`, `live_audio`

**Loops and Threads:** `live_loop`, `in_thread`, `loop do`, `N.times do |i|`

**Timing:** `sync`/`cue`, `at [times] do`, `time_warp N do`, `density N do`

**Effects:** `with_fx :name do` with 33 built-in FX

**Control:** `s = play 60, note_slide: 1; control s, note: 65` (smooth parameter slides)

**Control Flow:** `if`/`elsif`/`else`/`unless`, `begin`/`rescue`/`ensure`, `define :name do |args|`, `.each do |x|`, `.map`/`.select`/`.reject`/`.collect { |x| expr }`

**Music Theory:** 35 synths, 34 samples, 30+ chord types, 50+ scale types, `chord`, `scale`, `note`, `note_range`, `chord_invert`

**Data:** `ring`, `knit`, `range`, `line`, `spread` (Euclidean rhythms), `tick`/`look`, `.reverse`/`.shuffle`/`.pick`/`.take`/`.drop`

**Random:** `rrand`, `rrand_i`, `rand`, `rand_i`, `choose`, `dice`, `one_in`, `use_random_seed` (MT19937, matches desktop Sonic Pi output)

**Output:** `puts`/`print`, string interpolation (`"hello #{name}"`)

### Audio Engine
- VirtualTimeScheduler: cooperative async concurrency with virtual time
- sleep() returns Promises only the scheduler can resolve
- SuperSonic bridge: scsynth compiled to WASM (127 SynthDefs)
- Hot-swap: replace loop body without stopping music
- Capture mode: instant O(n) query for visualization
- Stratum detection (S1/S2) for struCode/Motif integration

### Security
- Sandboxed execution: Proxy-based scope blocks fetch, DOM, eval, WebSocket, etc.
- Session logging with SHA-256 hashes and Ed25519/HMAC-SHA256 signing
- CDN dependencies pinned to specific versions
- SECURITY.md with CSP headers for nginx/Apache
- Ctrl+Shift+S to export signed session log

### Developer API
- `@mjayb/sonicpijs` engine embeddable in any app
- ProgramBuilder fluent API for building music programs
- AudioInterpreter + QueryInterpreter dual-interpreter architecture
- Full TypeScript types exported
- Comprehensive documentation: README, API reference, architecture guide, DSL reference, contributing guide

### Known Limitations
- No OSC output (browser limitation)
- No `run_file` / `load_buffer` (filesystem access)
- `beat_stretch`/`pitch_stretch` are approximate (no granular synthesis)
- SuperSonic loaded from CDN (GPL, not bundled)
- Dynamic `import()` does not support SRI integrity attributes
