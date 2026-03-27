# Architecture Guide

This document explains how the SonicPi.js engine works internally.
Read this before modifying the engine.

## The Core Innovation

Desktop Sonic Pi uses Ruby's `sleep()` to block the current thread while other
threads continue playing. JavaScript has a single thread -- blocking it freezes
the entire browser. Previous attempts to port Sonic Pi to JS tried to make
`sleep` block. That is impossible.

Our insight: **you don't need blocking, you need scheduler-controlled Promise
resolution.**

`sleep()` returns a Promise. That Promise is stored in a min-heap inside the
`VirtualTimeScheduler`. Nothing in user code can resolve it. Only the
scheduler's `tick()` method -- called on a 25ms interval -- checks the heap and
resolves Promises whose virtual wake time has been reached.

The result: multiple `live_loop`s run as concurrent async functions. Each
suspends at `await sleep(...)`, yielding control. The scheduler resumes them in
deterministic virtual-time order. No threads, no workers, no preemption.

```
live_loop :drums              live_loop :bass
    |                             |
    play :bd_haus                 play :c2
    |                             |
    sleep(0.5)                    sleep(1)
    |                             |
 [Promise parked in heap]     [Promise parked in heap]
    |                             |
    +-------- tick() resolves ----+
              earliest sleeper
```

### Why This Works

A Promise is just a callback registration. Creating one is free. The JS engine
suspends the async function at `await` and moves on. When `tick()` calls
`resolve()`, the microtask queue picks up exactly where the function left off.
This gives us cooperative concurrency with zero overhead beyond the Promise
machinery the engine already has.

## Data Flow

```
User Code (Ruby DSL or JS)
    |
    v
Parser / RubyTranspiler        Ruby --> JS transpilation
    |                           (recursive descent or regex fallback)
    v
Transpiled JS                   builder calls: b.play(60).sleep(0.5)
    |
    v
Sandbox                         Proxy-based scope blocks dangerous globals
    |
    v
ProgramBuilder                  builds Program -- pure data, no side effects
    |
    v
Program (Step[])                the "free monad" representation
    |
    +---> AudioInterpreter      runs against real audio via scheduler
    |         |
    |         +--> VirtualTimeScheduler   sleep -> Promise -> tick resolves
    |         +--> SuperSonicBridge       scsynth WASM via SuperSonic
    |
    +---> QueryInterpreter      instant O(n) query, no scheduler
              |
              +--> Used by Motif/struCode for visualization
```

## The Three Clocks

The engine maintains three independent time references:

| Clock | Source | Purpose |
|-------|--------|---------|
| **Wall clock** | `AudioContext.currentTime` | Real elapsed seconds since audio context creation. Monotonic, high-resolution. |
| **Virtual clock** | `TaskState.virtualTime` | Musical time per loop. Advances only when `sleep()` or `sync()` is called. Two loops can have different virtual times. |
| **Schedule-ahead** | `schedAheadTime` (default 0.1s) | Lookahead buffer. Events are scheduled at `virtualTime + schedAheadTime` on the audio timeline, giving the audio thread time to prepare. |

`tick()` resolves all sleep entries whose virtual time <= `audioTime + schedAheadTime`.
This is how virtual time stays ahead of wall time: events are dispatched early
enough for the audio thread to play them on time.

```
          schedAheadTime
          |<--------->|
  --------+-----------+---------> wall clock (AudioContext.currentTime)
           ^           ^
           |           |
        tick fires   audio plays the note
           |
           resolves sleepers whose
           virtualTime <= here
```

## Program as Pure Data

A `Program` is a flat array of `Step` objects:

```typescript
type Step =
  | { tag: 'play';     note: number; opts: Record<string, number>; synth?: string }
  | { tag: 'sample';   name: string; opts: Record<string, number> }
  | { tag: 'sleep';    beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'useBpm';   bpm: number }
  | { tag: 'control';  nodeRef: number; params: Record<string, number> }
  | { tag: 'cue';      name: string; args?: unknown[] }
  | { tag: 'sync';     name: string }
  | { tag: 'fx';       name: string; opts: Record<string, number>; body: Program }
  | { tag: 'thread';   body: Program }
  | { tag: 'print';    message: string }
  | { tag: 'stop' }
```

This is the "free monad" representation. The key property: **a Program contains
no side effects, no Promises, no scheduler references.** It is pure data
describing what to do, not how to do it. Interpreters decide the how.

### Why "free monad"?

In functional programming, a free monad turns a set of operations into a data
structure that can be interpreted later. Our `Step[]` does exactly that:

- `ProgramBuilder` constructs the data (the "free" part -- build without executing)
- `AudioInterpreter` interprets it against real audio (one interpreter)
- `QueryInterpreter` interprets it as an instant synchronous query (another interpreter)

Same Program, different interpreters = same music, different outputs. The
AudioInterpreter plays sound. The QueryInterpreter returns time-stamped events
for visualization in Motif/struCode. Neither knows about the other.

## The Transpiler Chain

User code arrives as Sonic Pi's Ruby DSL. It must become JavaScript builder calls.

### Pipeline

```
Ruby DSL                  autoTranspile()               transpile()
  live_loop :drums do   ------------------>   live_loop("drums", (b) => {
    sample :bd_haus        Parser.ts or          b.sample("bd_haus")
    sleep 0.5              RubyTranspiler.ts      b.sleep(0.5)
  end                                          })
```

**`autoTranspile(code)`** in `RubyTranspiler.ts` is the entry point:
1. Calls `detectLanguage(code)` -- if the code is already JS, returns it as-is
2. Tries the recursive descent `Parser.ts` first (proper parser, handles nesting)
3. If the parser throws, falls back to `RubyTranspiler.ts` (regex-based, less correct but more lenient)

**`Parser.ts`**: Recursive descent parser. Tokenizes then walks the grammar:
```
program     -> (statement NL)*
statement   -> live_loop | with_fx | define | if_block | times_loop | ...
live_loop   -> 'live_loop' SYMBOL (',' sync_opt)? 'do' block 'end'
expression  -> play | sleep | sample | use_synth | use_bpm | ...
```
Emits JS with `b.` prefixes for builder calls inside loop bodies.

**`RubyTranspiler.ts`**: Regex-based fallback. Handles common patterns but
misses edge cases with nesting. Exists for resilience -- if the parser chokes on
unusual Ruby, the regex path often produces something workable.

**`Transpiler.ts`**: Minimal wrapper. Previously injected `await` keywords;
now passes code through unchanged since the builder chain is synchronous.

**`detectLanguage()`**: Heuristic. Looks for Ruby markers (`:symbol`, `do/end`,
`def`, `puts`) vs JS markers (`const`, `let`, `=>`, `{}`). Avoids double-transpiling
code that is already JavaScript.

## Build-Time vs Runtime

The engine separates what happens when a Program is constructed from what happens
when it is interpreted.

### Build-time (ProgramBuilder)

Resolved eagerly when `builderFn(b)` is called. The result is baked into the
Step array:

| Operation | What happens |
|-----------|-------------|
| `rrand`, `choose`, `dice` | Seeded PRNG evaluates immediately. Deterministic per seed. |
| `tick`, `look` | Ring counter advances/reads. Index stored in step opts. |
| `density` | Multiplier applied to sleep beats at build time. |
| `define` | User-defined functions stored and callable during build. |
| `ring`, `scale`, `chord` | Collections constructed, values selected. |

### Runtime (AudioInterpreter)

Executed against the scheduler and audio bridge:

| Step tag | What happens |
|----------|-------------|
| `play` | Triggers a synth on SuperSonic at `virtualTime + schedAheadTime` |
| `sample` | Plays a sample on SuperSonic |
| `sleep` | Calls `scheduler.scheduleSleep()` -- suspends via Promise |
| `control` | Sends `/n_set` to a running synth node |
| `fx` | Allocates a bus, applies FX, runs inner program, frees bus |
| `thread` | Spawns a one-shot loop via `scheduler.registerLoop()` |
| `sync` / `cue` | Inter-loop synchronization via the scheduler |
| `useSynth` / `useBpm` | Updates interpreter state for subsequent steps |
| `print` | Calls the print handler (log pane in the UI) |
| `stop` | Sets `task.running = false`, breaking the loop |

## Cooperative Concurrency

Multiple `live_loop`s run as async functions sharing the single JS thread:

1. `registerLoop(name, asyncFn)` stores the task and calls `runLoop(task)`
2. `runLoop` immediately does `await scheduleSleep(taskId, 0)` -- parking the
   loop until the first `tick()`
3. `tick()` fires every 25ms via `setInterval`
4. `tick()` pops all heap entries with `time <= audioTime + schedAheadTime`
5. For each popped entry, `tick()` calls `entry.resolve()` -- resuming that
   async function from where it `await`ed
6. The resumed function runs until the next `sleep()`, which parks it again
7. Loop body runs inside a `while (task.running)` loop -- it repeats
   automatically after each iteration

No preemption. No threads. No workers. Each loop runs until it voluntarily
yields at `sleep()`. Between sleeps, a loop has exclusive access to the JS
thread. This is safe because Sonic Pi's programming model guarantees that every
loop body contains at least one `sleep`.

### Deterministic ordering

When two loops sleep to the same virtual time, the scheduler uses insertion
order as a tiebreaker. This makes execution deterministic -- the same code
always produces the same event sequence.

### sync / cue

`cue(name)` broadcasts to all tasks waiting via `sync(name)`. Waiting tasks
inherit the cuer's virtual time (invariant SV5), keeping them phase-aligned.

## Hot-Swap

When the user edits code and re-evaluates while music is playing:

1. `evaluate()` detects `isReEvaluate = true` (scheduler exists and is playing)
2. New code is transpiled and executed, collecting loop names and async functions
   into a `pendingLoops` map
3. `scheduler.pauseTick()` -- no events fire during transition
4. `bridge.freeAllNodes()` -- clean audio cut
5. `scheduler.reEvaluate(pendingLoops)`:
   - **Same-named loops**: hot-swap the async function, preserve `virtualTime`
     (invariant SV6). The loop continues from its current beat position.
   - **New loops**: `registerLoop()` with fresh state
   - **Removed loops**: `task.running = false` -- the while-loop exits
6. `scheduler.resumeTick()` -- music continues with new code

The key invariant (SV6): virtual time is preserved across hot-swaps. A drum
loop at beat 47.5 stays at beat 47.5 after re-evaluation. Only the body
changes.

## SuperSonic Bridge

SuperSonic is scsynth (SuperCollider's audio engine) compiled to WebAssembly,
running inside an `AudioWorkletNode`.

### Loading

SuperSonic is GPL-licensed. It is loaded from CDN at runtime, never bundled:

```
https://unpkg.com/supersonic-scsynth@latest/dist/
https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/
https://unpkg.com/supersonic-scsynth-samples@latest/samples/
```

### Initialization

1. Instantiate `SuperSonic` with CDN URLs
2. `sonic.init()` -- loads the WASM, starts the AudioWorklet
3. Load common SynthDefs (beep, saw, prophet, tb303, supersaw, pluck, ...)
4. Create scsynth group structure: group 100 (synths) at head, group 101 (FX) at tail
5. Set up multi-channel audio routing:
   - WorkletNode outputs `NUM_OUTPUT_CHANNELS` channels (autoConnect=false)
   - ChannelSplitter splits into individual channels
   - ChannelMerger mixes to stereo for speakers
   - Per-track AnalyserNodes for per-loop visualization
   - Master AnalyserNode and GainNode on the output

### Audio routing

```
AudioWorkletNode (scsynth WASM)
    |
    v
ChannelSplitter (N channels)
    |
    +--> channels 0-1: master bus
    +--> channels 2-3: track 0
    +--> channels 4-5: track 1
    +--> ...
    |
    v
ChannelMerger (stereo mix)
    |
    v
AnalyserNode (master) --> GainNode --> destination (speakers)
```

### 127 SynthDefs

SuperSonic ships with SynthDefs matching Sonic Pi's built-in synths: beep, saw,
prophet, tb303, supersaw, pluck, fm, and many more. Sample playback uses
numbered buffers loaded on demand.

## Security Model

User code runs in a Proxy-based sandbox. The strategy:

1. Wrap transpiled code in a `with(scope)` block
2. `scope` is a `Proxy` that intercepts all global lookups
3. DSL functions (`play`, `sleep`, `sample`, etc.) pass through
4. Safe globals pass through (`Math`, `Array`, `Object`, `console`, etc.)
5. Dangerous globals return `undefined`:
   - Network: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
   - Storage: `localStorage`, `sessionStorage`, `indexedDB`
   - DOM: `document`, `window`, `navigator`, `location`, `history`
   - Timers: `setTimeout`, `setInterval` (these would break virtual time)
   - Workers: `Worker`, `SharedWorker`, `ServiceWorker`
   - Eval: `eval`, `Function` (no sandbox escape)

Why not iframe/Worker: user code needs synchronous access to the ProgramBuilder
and (indirectly) the scheduler. Serializing across message boundaries would
break the builder chain pattern.

## Strata

The engine classifies code into three strata for optimization:

| Stratum | Description | Capturable? |
|---------|-------------|-------------|
| **S1** | Stateless, cyclic, deterministic | Yes -- QueryInterpreter can predict all events |
| **S2** | Seeded stochastic (uses `choose`, `rrand`, etc.) | Yes -- with known seed |
| **S3** | State-accumulating, external I/O (`sync`, `cue`, `Math.random`) | No -- streaming only |

S1/S2 code can be queried instantly via the QueryInterpreter for visualization.
S3 code must be observed in real time via the AudioInterpreter's event stream.

## File Map

Every file in `src/engine/`:

| File | Purpose |
|------|---------|
| `VirtualTimeScheduler.ts` | Core scheduler. Min-heap of sleep Promises, tick loop, sync/cue, hot-swap. |
| `Program.ts` | Step type definitions. Pure data, no logic. |
| `ProgramBuilder.ts` | Fluent builder API. User code calls `b.play(60).sleep(0.5)`. Resolves randomness at build time. |
| `SonicPiEngine.ts` | Top-level engine. Owns scheduler, bridge, transpiler pipeline. Implements evaluate/play/stop. |
| `Parser.ts` | Recursive descent parser for Ruby DSL. Tokenizer + grammar rules. |
| `RubyTranspiler.ts` | Regex-based Ruby-to-JS transpiler. Fallback when parser fails. |
| `Transpiler.ts` | Code wrapping for execution via `new Function()`. Minimal pass-through. |
| `Sandbox.ts` | Proxy-based sandbox. Blocks dangerous globals, passes DSL functions. |
| `SuperSonicBridge.ts` | Wrapper around SuperSonic (scsynth WASM). Init, synth triggers, samples, FX, audio routing. |
| `MinHeap.ts` | Generic min-heap used by the scheduler's sleep queue. |
| `Ring.ts` | Ring buffer data structure (`ring`, `knit`, `range`, `line`). Wrapping index access. |
| `SeededRandom.ts` | Deterministic PRNG for reproducible randomness across loop iterations. |
| `NoteToFreq.ts` | MIDI note number and note name conversions. |
| `ChordScale.ts` | Chord and scale generation matching Sonic Pi's built-in functions. |
| `EuclideanRhythm.ts` | Bjorklund's algorithm for `spread()` -- Euclidean rhythm patterns. |
| `SynthParams.ts` | Parameter metadata for synths (ranges, defaults). |
| `SampleCatalog.ts` | Sample name resolution and categorization. |
| `Stratum.ts` | Static analysis to classify code as S1/S2/S3 for capture optimization. |
| `SoundEventStream.ts` | Observable event stream. Emits sound events for visualization. |
| `FriendlyErrors.ts` | Transforms raw errors into user-readable messages with suggestions. |
| `SessionLog.ts` | Session logging for replay and debugging. |
| `Recorder.ts` | Audio recording (capture output to WAV/WebM). |
| `Collaboration.ts` | Multi-user collaboration support. |
| `LinkBridge.ts` | Ableton Link integration for tempo sync across devices. |
| `MidiBridge.ts` | Web MIDI API bridge for MIDI input/output. |
| `cdn-manifest.ts` | CDN URL management for SuperSonic assets. |
| `examples.ts` | Built-in example programs. |
| `index.ts` | Package entry point. Re-exports public API. |
| `interpreters/AudioInterpreter.ts` | Walks Program steps, triggers audio via scheduler and bridge. The only interpreter with side effects. |
| `interpreters/QueryInterpreter.ts` | Walks Program steps synchronously, returns timed events. No audio, no scheduler. O(n) query. |
