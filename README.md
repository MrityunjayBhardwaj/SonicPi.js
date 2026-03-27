# SonicPi.js

**Browser-native live coding music environment powered by SuperCollider synthesis.**

<!-- badges -->
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

---

## What is this?

SonicPi.js is a browser-native reimplementation of [Sonic Pi](https://sonic-pi.net/)'s live coding environment. It runs real SuperCollider synthesis in the browser via SuperSonic (scsynth compiled to WebAssembly) with a scheduler-controlled Promise architecture that gives JavaScript cooperative concurrency with virtual time. Zero install -- open a browser and start making music.

## Quick Start

```bash
npx sonicpi
```

This starts a local server and opens the editor in your default browser. That's it.

## Try It Now

Paste this into the editor and press Run:

```ruby
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
```

Add a second loop while it's playing -- the drums keep going:

```ruby
live_loop :bass do
  use_synth :tb303
  play :e2, release: 0.3, cutoff: 70
  sleep 0.5
end
```

## Features

### DSL

Full Sonic Pi Ruby DSL with automatic transpilation to JavaScript:

- `live_loop`, `in_thread`, `loop`, `N.times`
- `play`, `sleep`, `sample`, `use_synth`, `use_bpm`
- `with_fx` (nested effect chains)
- `define` (named functions)
- `density`, `at`, `time_warp`
- `sync`, `cue` (inter-loop coordination with virtual time inheritance)
- `control` with parameter slides
- `.each`, `.map`, `.select`, `.reject`
- `begin`/`rescue`, `if`/`elsif`/`else`/`unless`
- `rrand`, `rrand_i`, `dice`, `one_in`, `choose` (seeded PRNG)

### Music Theory

- 30+ chord types (`major`, `minor`, `dom7`, `dim`, `aug`, ...)
- 50+ scales (`major`, `minor_pentatonic`, `dorian`, `blues`, ...)
- `note`, `note_range`, `chord_invert`
- `tick`, `look` (stateful iteration)
- `ring`, `knit`, `range`, `spread` (Euclidean rhythms)

### Audio

- 127 SuperCollider SynthDefs (same definitions as desktop Sonic Pi)
- Sample library organized by category (`bd_haus`, `sn_dub`, `hat_snap`, ...)
- FX chain: reverb, distortion, echo, flanger, lpf, hpf, and more
- `live_audio` for microphone input
- Recording to WAV via `Recorder`
- MIDI bridge for external controllers
- Ableton Link synchronization

### Editor

- CodeMirror 6 with Ruby syntax highlighting
- Auto-indent and bracket matching
- 10 buffer tabs (like desktop Sonic Pi)
- 10 built-in examples from beginner to advanced
- Friendly error messages with line numbers

### Security

- Proxy-based sandbox isolating student code from browser globals
- Session logging with Ed25519 cryptographic signing
- Content Security Policy (CSP) ready for institutional deployment

## For Developers

Embed the engine in your own application:

```ts
import { SonicPiEngine } from '@spw/core'

const engine = new SonicPiEngine()
await engine.init()
await engine.evaluate(`
  live_loop :beat do
    sample :bd_haus
    sleep 0.5
  end
`)
engine.play()
```

The engine exposes components for visualization and analysis:

```ts
const components = engine.getComponents()

// Subscribe to sound events
components.streaming.eventStream.subscribe(event => {
  console.log(event.type, event.time)
})

// Query deterministic output (no audio needed)
const events = await components.capture.queryRange(0, 4)
```

## Documentation

- [Getting Started](docs/GETTING-STARTED.md)
- [API Reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [DSL Reference](docs/DSL-REFERENCE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Built With

- **VirtualTimeScheduler** -- scheduler-controlled Promise resolution for cooperative concurrency
- **SuperSonic** -- scsynth (SuperCollider) compiled to WebAssembly
- **CodeMirror 6** -- extensible code editor for the browser
- **Vite** -- build tooling and dev server

## How It Works

`sleep()` returns a Promise that only the VirtualTimeScheduler can resolve. This gives JavaScript cooperative concurrency with virtual time -- multiple `live_loop`s run concurrently, each advancing through their own timeline, with the scheduler controlling exactly when each one wakes up. Previous attempts at browser-based Sonic Pi tried to make `sleep` block the JavaScript thread (impossible without freezing the UI). Our insight: you don't need blocking, you need scheduler-controlled Promise resolution.

## Compatibility with Desktop Sonic Pi

Approximately 95% of Sonic Pi syntax runs unmodified. The Ruby DSL is transpiled to JavaScript through a recursive descent parser that handles Sonic Pi's idiomatic patterns.

**What matches exactly:**

- Seeded PRNG (Mersenne Twister MT19937) -- same random sequences as desktop
- SynthDef definitions -- same SuperCollider synthesis graphs
- Sample names and categories
- Music theory (chords, scales, rings, spreads)
- Timing semantics (virtual time, hot-swap, sync/cue)

**Differences:**

- No OSC output (browser networking restrictions)
- No Erlang runtime (scheduling is pure JavaScript)
- Browser audio latency is higher than native (~20ms vs ~5ms depending on hardware)
- Some niche Ruby syntax may not be covered by the transpiler

## License

MIT. See [LICENSE](LICENSE) for details.

## Credits

Based on [Sonic Pi](https://sonic-pi.net/) by Sam Aaron and contributors. SonicPi.js is an independent reimplementation -- it does not share code with the desktop application.

SuperSonic (scsynth WASM) by the SuperSonic contributors. Loaded via CDN at runtime (GPL-licensed, never bundled).
