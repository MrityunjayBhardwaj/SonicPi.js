# Changelog

## v1.5.0-beta.4

**Prerelease.** First release under the new name **`@mjayb/sonicweb`** (formerly `@mjayb/sonicpijs`). The project is now **Sonic Web**, live at [sonicweb.cc](https://sonicweb.cc). Bundles all work merged since beta.3. Install: `npm install @mjayb/sonicweb`.

### Rebrand

- **Sonic Pi Web → Sonic Web.** npm `@mjayb/sonicpijs → @mjayb/sonicweb`, repo `SonicPiWeb → SonicWeb`, domain `sonicpi.cc → sonicweb.cc` (308 redirect, old paths preserved). Upstream Sonic Pi attribution and the audio-critical `sonic-pi-*` synthdef/OSC identifiers are unchanged. (#610, #611, #614)

### Engine

- **Self-sufficient by default** (#604) — the engine auto-loads SuperSonic (the GPL scsynth WASM core, from CDN), the tree-sitter transpiler, and its PRNG table itself. A bare consumer needs zero runtime wiring.
- **`Hash#length` / `#size` / `#count`** transpile correctly via a runtime `__spSize` helper (#603) — fixes loops over Hash literals silently dropping layers.
- **`spread(hits, total)`** matches Desktop Sonic Pi's `redistribute` placement byte-for-byte for all `(hits, total)` (#597, #598).
- Parity fixes: dynamic / non-literal `use_synth`, inline-loop RNG continuity, cross-loop `get`/`set` time-frame alignment, and bang-only mixer/volume linting (#585, #586, #588–#593, #595, #596).

### Docs & tooling

- Parity dashboards and every docs code snippet are now playable (Run/Stop) with an "open in sonicweb.cc" link; dashboards published to Vercel + Cloudflare R2.
- Fixed the "Engine not ready" race when Run is pressed during engine init.
- CI: `actions/checkout` / `actions/setup-node` bumped to v6/v7 (#607).

## v1.5.0-beta.2

**Prerelease.** Two PRs since v1.5.0-beta.0 — transpiler stability work (#165) and four new features from the Desktop Sonic Pi tutorial (#166). Installed via `npm install @mjayb/sonicweb@beta`.

### New features

- **`use_real_time`** (tutorial Ch 11.1) — disable the schedule-ahead buffer for the current thread. Use inside a MIDI-triggered `live_loop` to drop perceived latency to near-zero.
- **MIDI input cue paths** (tutorial Ch 11) — `sync "/midi:*:1/note_on"` (Desktop format) and `sync "/midi/note_on"` (short format) both match a single incoming MIDI message. Either form from the tutorial now works unchanged.
- **Wildcard sync / cue matching** (tutorial Ch 10.3) — `sync "/osc*/trigger"` and `sync "/foo/?ar/tick"` support `*` and `?` glob patterns. Exact-match is still the fast path when no glob characters are present.
- **`synth :sound_in` / `synth :sound_in_stereo`** (tutorial Ch 13.1) — capture microphone input into the live composition. The browser prompts for mic permission on first use, then routes the mic through scsynth so you can gate, filter, FX, or record it like any other synth. Stereo input devices go through `sound_in_stereo`.

### Transpiler consolidation (#165)

- **`synth :NAME` idiom** — `synth :prophet, note: :c4, release: 0.5` now dispatches the named synth. Previously every such call silently fell back to `:beep` because the transpiler emitted `play(opts)` instead of `play(note, opts)`.
- **Top-level `use_synth` ordering** — `use_synth :saw; play :c4; use_synth :tri; play :e4` now plays the right synth for each note. Previously the `use_synth` calls were hoisted together and only the last one took effect.
- **Single transpiler path** — the legacy regex-based transpiler has been removed. TreeSitter is now the sole Ruby → JS path, eliminating a class of inconsistencies where one transpiler handled a construct and the other didn't.
- Ruby array helpers: `.zip` and `.each_with_index` now transpile correctly.

### Bug fixes

- **`get[:key]` bracket form** — `if get[:flag] ... end` branches now read the stored value. Previously the bracket form silently returned `undefined` for every key, so any composition that gated loops on shared state (`set`/`get`) appeared inert — no error, no warning, just nothing happening. `get(:key)` function-call form was unaffected.
- **`synth :sound_in` connect error** — every dispatch used to print `Mic input failed: Failed to execute 'connect' on 'AudioNode': Overload resolution failed` to the log. Fixed in initial review.
- **`synth :sound_in` mic lifecycle** — three sharp edges fixed during review testing:
  - **Stop** now releases the mic track so the browser's recording indicator clears and nothing keeps feeding scsynth's input channel.
  - **Rapid re-dispatch** inside a `live_loop` (e.g., `synth :sound_in; sleep 0.1`) no longer re-acquires the microphone ten times per second. The mic connects once and stays connected.
  - **Hot-swap** (edit code to remove `sound_in`, press Run again) cleanly releases the mic without needing an explicit Stop first.
- **MIDI dual-fire drop** — the new `/midi:*:ch/type` + `/midi/type` dual dispatch was silently dropping every event because the scheduler's `fireCue` early-returned when called with a synthetic taskId. MIDI input now actually wakes sync waiters.

### Verified compatibility

The 56 real-world compositions from the beta.0 regression set still pass end-to-end. New automated E2E coverage (`tests/p2-credibility.spec.ts`) exercises the four new features in headed Chromium with mocked MIDI input and a mocked microphone stream.

### Known gaps (follow-up)

- `use_real_time` latency reduction is wired through the scheduler but hasn't been measured against real MIDI hardware — perceptual verification is still owed.
- `synth :sound_in` has been verified to reach scsynth end-to-end and real mic passthrough works in manual testing, but an automated fidelity test (known tone in → known tone out with FFT verification) is still owed.

Bug reports welcome on [GitHub issues](https://github.com/MrityunjayBhardwaj/SonicWeb/issues). The in-app **Report Bug** button pre-fills the version, browser, and current code.

---

## v1.5.0-beta.0

**Prerelease.** This is the first public beta of v1.5.0. Installed via `npm install @mjayb/sonicweb@beta`; the default `latest` tag still points to `v1.4.0`. Bug reports welcome on [GitHub issues](https://github.com/MrityunjayBhardwaj/SonicWeb/issues) — the in-app **Report Bug** button pre-fills the version, browser, and current code.

### Engine audit — 33 bugs fixed

Found during a multi-round audit against MagPi book chapters, official Sonic Pi wizard/sorcerer/magician examples, and community forum compositions. Per-bug rationale in the engine audit PR (#155) and synth alias cleanup (#157).

**Critical engine:**
- `randomSuffix()` was `const f = (): string => f()` — infinite recursion on top-level `in_thread`/`at`
- `ProgramBuilder` children (`in_thread`/`with_fx`/`at`) not inheriting `_transpose`, `_synthDefaults`, `_sampleDefaults`
- `wrapBareCode` didn't track `loop do`/`.times do`/`.each do` — `use_synth` hoisted out of loops
- `normalizeSampleParams` missing `expandSlideParam` — `sample :x, slide:` silently ignored
- `normalizeFxParams` resolved symbols AFTER injecting defaults (wrong order)
- `with_bpm` didn't restore previous BPM
- `resumeTick()` race condition on rapid pause/resume

**Bridge / runtime:**
- `in_thread` inside `with_fx` not inheriting `outBus` — thread audio bypassed FX entirely
- Sample/SynthDef lazy-load race conditions (buffer leaks, duplicate loads)
- `freeBus()` allowed duplicate frees — bus collision
- `fetchSampleDuration` silently swallowed errors, breaking `beat_stretch`

**DSL / tutorial parity:**
- `use_sample_bpm` — wrapper around `use_bpm(60 / sample_duration(name))`
- `midi` shorthand — `midi 60, sustain: 0.5` (note_on + auto note_off)
- `use_osc` / `osc` shorthand — state variable for default host/port
- `with_fx reps:` — FX body now loops N times within same FX instance
- `with_synth_defaults` / `with_sample_defaults` — scoped variants
- `use_density` — permanent density setter
- `use_debug` — exposed in sandbox as no-op (was causing crashes)
- `.take(n)` — transpiler was emitting `.slice()` but Ring uses `.take()`
- `Ring.line(steps=1)` returned `[NaN]` (division by zero) — now returns `[start]`

**Public API additions:**
- Exported: `hzToMidi`, `chord_degree`, `degree`, `knit`, `range`, `line`

**Sandbox fixes:**
- `get()` was defined as a `new Proxy(...)` not a function — `get(:key)` crashed
- `with_random_seed`, `with_octave`, `with_density`, `with_synth_defaults`, `with_sample_defaults` weren't in `transpileWithBlock` handler — blocks transpiled without callback wrapper
- `TOP_LEVEL_SETTINGS` missing `use_arg_bpm_scaling`

**Architectural fix — `b` shadowing:**
- User variable `b` shadowed `ProgramBuilder` callback parameter via Proxy `set` trap. Renamed internal parameter from `b` to `__b` across all transpiler output sites (callback params, method prefixes, `__checkBudget`, `stop`, `lastRef`, `density`, `define` funcs, `at` callbacks). Documented in KNOWN_LIMITATIONS.

**`wrapBareCode` regex expansion:**
- Regex only matched `/^\s*(play|sleep|sample)\s/` — missed `play_chord`, `play_pattern_timed`, `use_synth_defaults`, `synth`, `control`, `cue`, `sync`, etc. Expanded to cover all bare DSL callables that need `__b` scope.

**Synth aliases:**
- Removed `dark_sea_horn` and `singer` from `SYNTH_NAMES` — no corresponding `.scsyndef` on the SuperSonic CDN (silent failure trap).

### Verified compatibility

56 real-world compositions run end-to-end in Chromium capture:
- 18 E2E tests (covering 122 DSL functions)
- 7 MagPi Essentials chapter examples
- 15 official Sonic Pi examples (wizard/sorcerer/magician tiers from `etc/examples/`)
- 13 community forum compositions from in-thread.sonic-pi.net
- 3 edge cases

### Test coverage

- 703 unit tests pass
- Zero TypeScript errors

### UI

- Version label in the menu bar displays `v1.5.0-beta.0` (top-right, muted). Click to copy the full `SonicWeb v1.5.0-beta.0` string to clipboard. Pre-filled into the Report Bug URL so every bug report is tagged to a specific build.

### Release engineering

- This is the first release following the new release-cycle criteria: single version string across all surfaces, npm `--tag beta` to protect `latest`, UI footer as the load-bearing signal for the prerelease channel, explicit beta → RC → stable gate criteria documented in the release runbook.

### Known limitations

See [`KNOWN_LIMITATIONS.md`](./KNOWN_LIMITATIONS.md) for the current list. The limitations file is the single source of truth; it is intentionally NOT duplicated per-release in this changelog. Noteworthy feasible-but-not-built items tracked for post-beta work: external sample upload (#159), OSC receive via WebSocket bridge (#150), `synth :sound_in` via `getUserMedia` (#152), `use_real_time` MIDI latency bypass (#149), `.zip`/`.each_with_index` Array methods (#154).

---

## v1.4.0

### UI/UX
- **Help panel** — fixed cursor word detection (CodeMirror ESM `wordAt()` bug), resizable with draggable splitter, 311 entries (33 functions + 37 synths + 34 FX + 207 samples generated from engine data)
- **View menu** — all 5 panel toggles now work (scope, log, cue log, buttons, tabs)
- **Cue Log** — wired to live cue/sync events from the scheduler, resizable with splitter
- **Scope visualizer** — no longer overflows into log panel (overflow + flex display fix)
- **Autocomplete tooltip** — dark-themed to match editor
- **Resizable panels** — drag splitters on scope, log, cue log, help panel
- **Report Bug button** — pre-filled GitHub issue with current code, browser, OS (no OAuth)
- **Toolbar layout** — fixed vertical stacking bug caused by `display: ''` wiping inline flex
- **New hero image** — 1500x701 screenshot

### Error Handling
- **Syntax errors block execution** — transpiler errors now return `{ error: SyntaxError }` instead of executing raw Ruby as JS
- **Block validation** — `live_loop`, `define`, `with_fx`, `in_thread`, `at`, `time_warp`, `density` all emit parse errors when `do...end` block is missing
- **Error line highlighting** — parse errors extract line numbers directly (no wrapper offset), runtime errors now also highlight the error line
- **Sandbox line offsets** — dynamic `SANDBOX_WRAPPER_LINES` replaces hardcoded offset, fallback executor now enriches SyntaxErrors
- **`engine.init()` failure** — wrapped in try/catch, shows error instead of silent UI freeze
- **Hot-swap rollback** — `reEvaluate()` saves previous loop functions, restores on failure
- **FriendlyErrors** — 20 patterns (was 18), parse error pattern bypasses wrapper offset logic
- **TreeSitter not-ready message** — now says "try clicking Run again" instead of "call initTreeSitter()"

### Examples
- **Blade Runner x Techno** — added to advanced examples (10 synced loops, same as welcome buffer)

### Infrastructure
- **CI workflow** — type check + vitest on every PR and push to main (closes #9)
- **CI + Deploy badges** in README
- **Dependabot** — configured for npm (weekly) and GitHub Actions (monthly) (closes #10)
- **GitHub Actions** — bumped to v6 (checkout + setup-node)
- **TypeScript** — upgraded to 6.0.2
- **v1.4.0 milestone** — 5 issues closed, 4 PRs merged
- **KNOWN_LIMITATIONS.md** — corrected `osc_send` status (implemented, hook-based)
- **Dev artifacts** — moved to `~/.anvideck/`, public repo is clean

---

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
- `vite` moved from `devDependencies` to `dependencies` — the CLI requires it at runtime; `npx @mjayb/sonicweb` was silently broken in fresh installs
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

The first public release of Sonic Web — a browser-native reimplementation of Sonic Pi with SuperCollider synthesis via WebAssembly.

### Standalone App
- Responsive layout: editor (left) + scope + console (right)
- CodeMirror 6 editor with Ruby syntax highlighting and auto-indent
- Three-mode oscilloscope (waveform, mirror, lissajous)
- Console with play events, timestamps, friendly error messages
- 10 built-in examples grouped by difficulty
- 10 buffer tabs with localStorage persistence
- Volume slider, BPM display, recording to WAV
- `npx @mjayb/sonicweb` CLI launcher
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
- `@mjayb/sonicweb` engine embeddable in any app
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
