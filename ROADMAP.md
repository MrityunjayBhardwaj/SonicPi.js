# SonicPi.js Roadmap

> Live at [sonicpi.cc](https://sonicpi.cc) | npm: [`@mjayb/sonicpijs`](https://www.npmjs.com/package/@mjayb/sonicpijs)

---

## Released

| Version | Highlights |
|---------|------------|
| **v1.0.0** | Engine, standalone app, 35 synths, 34 samples, sandbox, CLI |
| **v1.1.0** | Full MIDI I/O, beat_stretch/pitch_stretch, Ring fixes |
| **v1.2.0** | stop_loop, multi-line continuation, ternary operator |
| **v1.3.0** | Tree-sitter sole transpiler, SoundLayer parity, 100% data parity (66 synths, 197 samples, 42 FX), param validation, scope rewrite (5 modes), runtime semantics, full UI overhaul |
| **v1.4.0** | Help panel (311 entries), resizable panels, cue log wired, error handling overhaul (20 patterns, block validation, line highlighting, hot-swap rollback), Report Bug button, CI workflow, TypeScript 6 |

---

## v1.5.0 — Next

### Mobile / Touch
- [ ] Responsive toolbar — collapse buttons into hamburger menu on narrow screens
- [ ] Touch-friendly splitters — larger hit targets for panel resizing
- [ ] On-screen keyboard — tap to insert common DSL keywords (live_loop, play, sleep, sample)
- [ ] Swipe between buffers
- [ ] Test and fix layout on iOS Safari + Android Chrome

### Hot Reload Preferences
- [ ] Prefs changes apply immediately without re-run (volume, BPM, scope modes already do — extend to editor font size, line numbers, word wrap)
- [ ] Theme changes (scope colors, glow, trail) apply to running visualizer without restart

### Polish
- [ ] WASM boot progress indicator (loading bar during SuperSonic init)
- [ ] Test coverage reporting (Vitest coverage + badge)

---

## Future

- WebSocket-to-UDP bridge for `osc_send` (bundled, not just hook)
- Ableton Link via WebRTC DataChannel
- Collaborative live coding (CRDT sync via Yjs + WebRTC)
- Code provenance — signed snapshots for LMS submission
- Monorepo split (`@mjayb/sonicpijs` engine, `@mjayb/sonicpijs-app` UI)
