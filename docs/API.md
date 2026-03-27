# SonicPi.js -- API Reference

> Package: `@spw/core`
> Engine for browser-native Sonic Pi temporal scheduling.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [SonicPiEngine](#sonicpiengine)
3. [ProgramBuilder](#programbuilder)
4. [VirtualTimeScheduler](#virtualtimescheduler)
5. [Program Types](#program-types)
6. [Transpilers](#transpilers)
7. [Audio -- SuperSonicBridge](#audio--supersonibridge)
8. [Events -- SoundEventStream](#events--soundeventstream)
9. [Music Theory](#music-theory)
10. [Sandbox](#sandbox)
11. [Session Logging](#session-logging)
12. [Extensions](#extensions)
13. [Query / Capture](#query--capture)
14. [Examples](#examples)
15. [Sample Catalog](#sample-catalog)
16. [Stratum Detection](#stratum-detection)
17. [Error Handling](#error-handling)

---

## Quick Start

Minimal code to get audio playing in the browser:

```ts
import { SonicPiEngine } from '@spw/core'

const engine = new SonicPiEngine()
await engine.init()
await engine.evaluate('live_loop :beat do; sample :bd_haus; sleep 0.5; end')
engine.play()

// Later...
engine.stop()
engine.dispose()
```

The engine accepts Sonic Pi's Ruby DSL directly. It auto-detects the language, transpiles Ruby to JS, builds a `Program`, and runs it through the `VirtualTimeScheduler` and `SuperSonicBridge`.

---

## SonicPiEngine

The top-level facade. Manages the scheduler, audio bridge, transpiler, and event stream.

### Constructor

```ts
new SonicPiEngine(options?: {
  bridge?: SuperSonicBridgeOptions
  schedAheadTime?: number
})
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options.bridge` | `SuperSonicBridgeOptions` | `{}` | SuperSonic CDN URLs and constructor override. |
| `options.schedAheadTime` | `number` | `0.1` | Lookahead time in seconds for scheduling audio events ahead of real time. |

### Methods

#### `init(): Promise<void>`

Initialize the audio engine. Must be called before `evaluate()`. Loads SuperSonic from CDN, initializes WebAudio, and pre-loads common SynthDefs. Safe to call multiple times (no-ops after first).

```ts
await engine.init()
```

#### `evaluate(code: string): Promise<{ error?: Error }>`

Transpile and load code into the scheduler. Supports both Ruby DSL and JS builder syntax. If the scheduler is already playing, performs a live hot-swap: same-named loops get updated code, removed loops are stopped, new loops are started.

```ts
const result = await engine.evaluate(`
  live_loop :drums do
    sample :bd_haus
    sleep 0.5
  end
`)

if (result.error) {
  console.error('Evaluation failed:', result.error)
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | `string` | Sonic Pi Ruby DSL or JS builder code. |

**Returns:** `{ error?: Error }` -- empty object on success, `{ error }` on failure.

#### `play(): void`

Start the scheduler tick timer. Loops registered via `evaluate()` begin executing.

```ts
engine.play()
```

#### `stop(): void`

Stop all loops, free all audio nodes, and dispose the scheduler. The engine returns to a clean state ready for the next `evaluate()` + `play()` cycle.

```ts
engine.stop()
```

#### `dispose(): void`

Full teardown. Stops playback, destroys the audio bridge, clears the event stream. The engine cannot be used after this without calling `init()` again.

```ts
engine.dispose()
```

#### `setRuntimeErrorHandler(handler: (err: Error) => void): void`

Register a callback for runtime errors from user code (e.g., bad synth name, invalid note).

```ts
engine.setRuntimeErrorHandler((err) => {
  console.error('Runtime error:', err.message)
})
```

#### `setPrintHandler(handler: (msg: string) => void): void`

Register a callback for `puts` / `print` output from user code.

```ts
engine.setPrintHandler((msg) => {
  logPane.append(msg)
})
```

#### `setVolume(volume: number): void`

Set master volume (0--1). Safe to call before `init()` -- the volume is applied when the audio bridge becomes ready.

```ts
engine.setVolume(0.5)
```

#### `static formatError(err: Error): FriendlyError`

Convert a raw error into a structured friendly error with title, message, and optional line number.

```ts
const friendly = SonicPiEngine.formatError(err)
// { title: "Unknown synth", message: "...", line: 3, original: Error }
```

#### `static formatErrorString(err: Error): string`

Format an error as a single display string.

```ts
const msg = SonicPiEngine.formatErrorString(err)
```

### Properties

#### `components: Partial<EngineComponents>`

Access internal subsystems for visualization and introspection.

```ts
interface EngineComponents {
  streaming: { eventStream: SoundEventStream }
  audio: {
    analyser: AnalyserNode
    audioCtx: AudioContext
    trackAnalysers?: Map<string, AnalyserNode>
  }
  capture: {
    queryRange(begin: number, end: number): Promise<unknown[]>
  }
}
```

- `streaming.eventStream` -- always available. Subscribe to sound events.
- `audio` -- available after `init()` succeeds. Provides the master `AnalyserNode` for oscilloscope/FFT visualization, the `AudioContext`, and per-track analysers.
- `capture` -- available only when the current code is deterministic (Stratum S1 or S2). Query future events without running the scheduler.

```ts
const { streaming, audio, capture } = engine.components

// Oscilloscope
if (audio) {
  const data = new Uint8Array(audio.analyser.fftSize)
  audio.analyser.getByteTimeDomainData(data)
}

// Per-track analysers
if (audio?.trackAnalysers) {
  for (const [name, analyser] of audio.trackAnalysers) {
    // each live_loop gets its own AnalyserNode
  }
}

// Capture query (deterministic code only)
if (capture) {
  const events = await capture.queryRange(0, 4) // events from beat 0 to 4
}
```

---

## ProgramBuilder

Fluent chain API for constructing `Program` arrays. Each `live_loop` body receives a `ProgramBuilder` instance (the `b` parameter).

```ts
import { ProgramBuilder } from '@spw/core'

const b = new ProgramBuilder(seed)
b.play(60).sleep(0.5).sample('bd_haus').sleep(0.5)
const program = b.build()
```

### Constructor

```ts
new ProgramBuilder(seed?: number)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `seed` | `number` | `0` | Seed for the deterministic PRNG (Mersenne Twister). |

### Sound Methods

#### `play(noteVal: number | string, opts?: Record<string, number>): this`

Trigger a synth note. Accepts MIDI numbers or note names (`"c4"`, `"fs3"`, `"eb5"`).

```ts
b.play(60)                           // MIDI note 60 (C4)
b.play('e4', { amp: 0.5 })          // note name with options
b.play(72, { release: 2, pan: -1 }) // long release, hard left
b.play(60, { synth: 'prophet' })    // override current synth for this note
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `noteVal` | `number \| string` | MIDI note number or note name. |
| `opts` | `Record<string, number>` | Optional synth params: `amp`, `pan`, `attack`, `decay`, `sustain`, `release`, `cutoff`, etc. |

#### `sample(name: string, opts?: Record<string, number>): this`

Trigger a sample playback.

```ts
b.sample('bd_haus')
b.sample('loop_amen', { rate: 0.5, amp: 0.8 })
b.sample('ambi_choir', { beat_stretch: 4 })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Sample name (e.g., `"bd_haus"`, `"loop_amen"`). |
| `opts` | `Record<string, number>` | Optional: `rate`, `amp`, `pan`, `beat_stretch`, `rpitch`, `attack`, `release`, `start`, `finish`, `lpf`, `hpf`, etc. |

#### `sleep(beats: number): this`

Advance virtual time. The duration is affected by the current `density` factor.

```ts
b.sleep(1)    // sleep 1 beat
b.sleep(0.25) // sleep a sixteenth note
```

### Configuration Methods

#### `use_synth(name: string): this`

Set the current synth for subsequent `play()` calls.

```ts
b.use_synth('prophet')
b.play(60) // uses prophet synth
```

Available synths: `beep`, `saw`, `prophet`, `tb303`, `supersaw`, `pluck`, `pretty_bell`, `piano`, `dsaw`, `dpulse`, `dtri`, `fm`, `mod_fm`, `sine`, `square`, `tri`, `pulse`, `noise`, and more.

#### `use_bpm(bpm: number): this`

Set the BPM for this loop.

```ts
b.use_bpm(120) // 120 beats per minute
```

#### `use_random_seed(seed: number): this`

Reset the PRNG to a specific seed. Produces deterministic random sequences.

```ts
b.use_random_seed(42)
```

### Control Flow

#### `with_fx(name: string, opts: Record<string, number>, buildFn: (b: ProgramBuilder) => ProgramBuilder): this`
#### `with_fx(name: string, buildFn: (b: ProgramBuilder) => ProgramBuilder): this`

Wrap steps in an audio effect. The inner builder receives its own `ProgramBuilder`.

```ts
b.with_fx('reverb', { room: 0.8 }, (fx) =>
  fx.play(60).sleep(0.5).play(64).sleep(0.5)
)

b.with_fx('echo', (fx) =>
  fx.sample('bd_haus')
)
```

Available FX: `reverb`, `echo`, `delay`, `distortion`, `slicer`, `wobble`, `ixi_techno`, `compressor`, `rlpf`, `rhpf`, `flanger`, `bitcrusher`, and more.

#### `in_thread(buildFn: (b: ProgramBuilder) => void): this`

Spawn a concurrent thread. The thread runs in parallel -- it does not advance the parent's virtual time.

```ts
b.in_thread((t) => {
  t.sample('ambi_choir', { rate: 0.5 })
  t.sleep(4)
})
b.play(60) // runs immediately, doesn't wait for the thread
```

#### `at(times: number[], values: unknown[] | null, buildFn: (b: ProgramBuilder, ...args: unknown[]) => void): this`

Schedule events at specific beat offsets. Creates one thread per time entry.

```ts
b.at([0, 0.5, 1, 1.5], [60, 64, 67, 72], (t, note) => {
  t.play(note as number)
})
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `times` | `number[]` | Beat offsets to schedule at. |
| `values` | `unknown[] \| null` | Values to pass to the build function (cycles if shorter than `times`). |
| `buildFn` | `(b, ...args) => void` | Builder function called for each time entry. |

#### `live_audio(name: string, opts?: Record<string, number>): this`

Enable live audio input (microphone/line-in).

```ts
b.live_audio('mic')
```

#### `stop(): this`

Halt loop execution at this point.

```ts
b.stop()
```

### Messaging

#### `cue(name: string, ...args: unknown[]): this`

Broadcast a cue event to other loops.

```ts
b.cue('go', 42)
```

#### `sync(name: string): this`

Wait for a cue from another loop. The loop suspends until the named cue fires.

```ts
b.sync('go')
```

#### `control(nodeRef: number, params: Record<string, number>): this`

Modify parameters of a running synth node.

```ts
b.play(60, { sustain: 4 })
const ref = b.lastRef
b.sleep(1)
b.control(ref, { cutoff: 80 })
```

#### `puts(...args: unknown[]): this`

Print a message to the log output.

```ts
b.puts('Current note:', 60)
```

#### `print(...args: unknown[]): this`

Alias for `puts()`.

### Properties

#### `density: number` (getter/setter)

Get or set the density factor. Higher density compresses sleep durations.

```ts
b.density = 2   // all sleeps are halved
b.sleep(1)       // actually sleeps 0.5 beats
```

#### `lastRef: number` (getter)

Returns the node reference of the most recent `play()` call. Used with `control()`.

```ts
b.play(60)
const ref = b.lastRef // reference to the synth node
```

### Random Methods

All random methods use a seeded Mersenne Twister PRNG. The sequence is deterministic given the same seed.

#### `rrand(min: number, max: number): number`

Random float in [min, max].

```ts
b.play(b.rrand(60, 72)) // random note between C4 and C5
```

#### `rrand_i(min: number, max: number): number`

Random integer in [min, max].

```ts
b.sleep(b.rrand_i(1, 4)) // sleep 1, 2, 3, or 4 beats
```

#### `rand(max?: number): number`

Random float in [0, max). Default max is 1.

#### `rand_i(max?: number): number`

Random integer in [0, max). Default max is 2.

#### `choose<T>(arr: T[]): T`

Pick a random element from an array.

```ts
b.play(b.choose([60, 64, 67, 72]))
```

#### `dice(sides: number): number`

Roll a die. Returns integer in [1, sides].

```ts
if (b.dice(6) > 4) b.sample('sn_dub')
```

#### `one_in(n: number): boolean`

Returns `true` with probability 1/n.

```ts
if (b.one_in(3)) b.sample('hat_snap')
```

### Tick / Look

#### `tick(name?: string): number`

Increment and return a named counter. Default counter name is `"__default"`.

```ts
const notes = b.ring(60, 64, 67, 72)
b.play(notes.at(b.tick()))
```

#### `look(name?: string): number`

Read the current tick counter value without incrementing.

### Data Constructors

These are bound directly from the `Ring` and `ChordScale` modules. They produce `Ring` objects or arrays.

#### `ring(...values: T[]): Ring<T>`

```ts
const notes = b.ring(60, 64, 67, 72)
```

#### `knit(...args: (T | number)[]): Ring<T>`

Repeat each value N times.

```ts
b.knit(60, 2, 64, 1) // Ring([60, 60, 64])
```

#### `range(start: number, end: number, step?: number): Ring<number>`

Generate a number sequence.

```ts
b.range(60, 72, 2) // Ring([60, 62, 64, 66, 68, 70])
```

#### `line(start: number, finish: number, steps?: number): Ring<number>`

Generate a line of evenly spaced values.

```ts
b.line(60, 72, 5) // Ring([60, 63, 66, 69, 72])
```

#### `spread(hits: number, total: number, rotation?: number): Ring<boolean>`

Euclidean rhythm distribution (Bjorklund algorithm).

```ts
b.spread(3, 8) // Ring([true, false, false, true, false, false, true, false])
```

#### `chord(root: string | number, type: string): Ring<number>`

Build a chord as MIDI note numbers.

```ts
b.chord('e3', 'minor') // Ring([52, 55, 59])
```

#### `scale(root: string | number, type: string, num_octaves?: number): Ring<number>`

Build a scale as MIDI note numbers.

```ts
b.scale('c4', 'major') // Ring([60, 62, 64, 65, 67, 69, 71])
```

#### `chord_invert(notes: number[], inversion: number): number[]`

Invert a chord by shifting the lowest N notes up an octave.

#### `note(n: string | number): number`

Convert a note name to MIDI number.

#### `note_range(low: string | number, high: string | number, opts?: { pitches: number[] }): number[]`

Generate all MIDI notes in a range.

#### `noteToMidi(note: string | number): number`

Convert note name to MIDI. Alias available on builder.

#### `midiToFreq(midi: number): number`

Convert MIDI to frequency in Hz.

#### `noteToFreq(n: string | number): number`

Convert note name or MIDI directly to frequency.

### Build

#### `build(): Program`

Finalize and return the `Program` (a `Step[]` array).

```ts
const program: Program = b.build()
```

---

## VirtualTimeScheduler

Cooperative async scheduler with virtual time. The core innovation: `sleep()` returns a Promise that only `tick()` can resolve, giving JavaScript cooperative concurrency under scheduler control.

### Constructor

```ts
new VirtualTimeScheduler(options?: SchedulerOptions)
```

```ts
interface SchedulerOptions {
  getAudioTime?: () => number  // default: () => 0
  schedAheadTime?: number      // default: 0.1 seconds
  tickInterval?: number        // default: 25 ms
}
```

### Invariants

- **SV1:** Virtual time per task is non-decreasing, advances only on sleep/sync.
- **SV2:** Sleep Promises are resolved exclusively by `tick()`.
- **SV3:** Deterministic ordering -- entries sorted by (time, then insertion order).
- **SV4:** Three-clock separation -- wall/audio/virtual clocks are independent.
- **SV5:** On sync, the waiting task inherits the cue sender's virtual time.

### Methods

#### `registerLoop(name: string, asyncFn: () => Promise<void>, options?: { bpm?: number; synth?: string }): void`

Register a named live_loop. The loop starts immediately but suspends at an initial `sleep(0)` until `tick()` fires. If a loop with the same name is already running, the function is hot-swapped.

```ts
scheduler.registerLoop('drums', async () => {
  // ... loop body
}, { bpm: 120 })
```

#### `hotSwap(loopName: string, newFn: () => Promise<void>): boolean`

Replace a running loop's function. Preserves virtual time, BPM, density, and random state. Takes effect on the next iteration.

**Returns:** `true` if the swap succeeded, `false` if the loop was not found or not running.

#### `reEvaluate(loops: Map<string, () => Promise<void>>, options?: { bpm?: number; synth?: string }): void`

Bulk update: hot-swap loops that persist, stop removed loops, start new ones. Used by `SonicPiEngine.evaluate()` during live re-evaluation.

#### `scheduleSleep(taskId: string, beats: number): Promise<void>`

Schedule a sleep for the given task. Virtual time advances immediately. Returns a Promise that only `tick()` can resolve (SV2).

#### `fireCue(name: string, taskId: string, args?: unknown[]): void`

Broadcast a cue event. Wakes any tasks waiting via `waitForSync()`. Waiting tasks inherit the sender's virtual time (SV5).

#### `waitForSync(name: string, taskId: string): Promise<unknown[]>`

Suspend the calling task until `fireCue(name)` is called. Returns the cue arguments.

#### `tick(targetTime?: number): void`

Resolve all sleep entries whose wake time is at or before `targetTime`. If no target is given, uses `audioTime + schedAheadTime`. Entries are resolved in deterministic order.

#### `getTask(taskId: string): TaskState | undefined`

Get the state of a specific task.

```ts
interface TaskState {
  id: string
  virtualTime: number
  bpm: number
  density: number
  currentSynth: string
  outBus: number
  asyncFn: () => Promise<void>
  running: boolean
}
```

#### `getRunningLoopNames(): string[]`

Get names of all currently running loops.

#### `start(): void`

Start the tick timer. Loops are already registered and suspended at their initial sleep.

#### `stop(): void`

Stop the tick timer and mark all tasks as not running (breaks their while loops).

#### `dispose(): void`

Full cleanup: stop, clear all tasks, queues, cue state, and event handlers.

### Properties

#### `running: boolean` (getter)

Whether the scheduler tick timer is active.

---

## Program Types

A `Program` is a flat array of `Step` objects. No side effects, no Promises, no scheduler references. Interpreters decide how to execute them.

```ts
type Program = Step[]

type Step =
  | { tag: 'play'; note: number; opts: Record<string, number>; synth?: string; srcLine?: number }
  | { tag: 'sample'; name: string; opts: Record<string, number>; srcLine?: number }
  | { tag: 'sleep'; beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'useBpm'; bpm: number }
  | { tag: 'control'; nodeRef: number; params: Record<string, number> }
  | { tag: 'cue'; name: string; args?: unknown[] }
  | { tag: 'sync'; name: string }
  | { tag: 'fx'; name: string; opts: Record<string, number>; body: Program }
  | { tag: 'thread'; body: Program }
  | { tag: 'print'; message: string }
  | { tag: 'liveAudio'; name: string; opts: Record<string, number> }
  | { tag: 'stop' }
```

### LoopProgram

Metadata for a named loop program:

```ts
interface LoopProgram {
  name: string
  bpm: number
  synth: string
  seed: number
  body: Program
}
```

---

## Transpilers

Convert between Sonic Pi's Ruby DSL, JavaScript, and executable functions.

### `autoTranspile(code: string): string`

Auto-detect language and transpile Ruby to JS if needed. This is the primary entry point used by `SonicPiEngine`.

```ts
import { autoTranspile } from '@spw/core'

const js = autoTranspile(`
  live_loop :drums do
    sample :bd_haus
    sleep 0.5
  end
`)
```

### `detectLanguage(code: string): 'ruby' | 'js'`

Detect whether code is Ruby DSL or JavaScript.

```ts
import { detectLanguage } from '@spw/core'

detectLanguage('live_loop :drums do')  // 'ruby'
detectLanguage('live_loop("drums"')    // 'js'
```

### `transpileRubyToJS(ruby: string): string`

Regex-based Ruby-to-JS transpiler. Used as fallback when the parser encounters errors.

```ts
import { transpileRubyToJS } from '@spw/core'

const js = transpileRubyToJS(`
  live_loop :drums do
    sample :bd_haus
    sleep 0.5
  end
`)
// Result: live_loop("drums", (b) => { b.sample("bd_haus"); b.sleep(0.5) })
```

### `parseAndTranspile(source: string): { code: string; errors: ParseError[] }`

Recursive descent parser for the Ruby DSL. Primary transpilation path -- gives better error messages and handles nested blocks correctly.

```ts
import { parseAndTranspile } from '@spw/core'

const { code, errors } = parseAndTranspile(`
  live_loop :drums do
    sample :bd_haus
    sleep 0.5
  end
`)

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`Line ${err.line}: ${err.message}`)
  }
}
```

```ts
interface ParseError {
  message: string
  line: number
  column: number
  suggestion?: string
}
```

### `transpile(userCode: string): TranspileResult`

Wrap user code for execution via `new Function()`. Currently a pass-through (builder chain code is synchronous).

```ts
import { transpile } from '@spw/core'

const { code, lineOffset } = transpile(jsCode)
```

### `createExecutor(transpiledCode: string, dslParamNames: string[]): (...args: unknown[]) => Promise<void>`

Create an executable function from transpiled code. DSL function names become parameters.

```ts
import { createExecutor } from '@spw/core'

const executor = createExecutor('live_loop("test", (b) => b.play(60))', ['live_loop'])
await executor(myLiveLoopImpl)
```

---

## Audio -- SuperSonicBridge

Wrapper around SuperSonic (scsynth compiled to WASM). Loaded via CDN -- never bundled (GPL).

### Constructor

```ts
new SuperSonicBridge(options?: SuperSonicBridgeOptions)
```

```ts
interface SuperSonicBridgeOptions {
  SuperSonicClass?: SuperSonicConstructor  // pass the class directly
  baseURL?: string
  coreBaseURL?: string
  synthdefBaseURL?: string
  sampleBaseURL?: string
}
```

### Methods

#### `init(): Promise<void>`

Initialize SuperSonic, load common SynthDefs, set up the audio routing graph (multi-channel output with splitter, per-track analysers, master gain, and master analyser).

#### `triggerSynth(synthName: string, audioTime: number, params: Record<string, number>): Promise<number>`

Trigger a synth note. Returns the scsynth node ID.

```ts
const nodeId = await bridge.triggerSynth('beep', audioCtx.currentTime, {
  freq: 440, amp: 0.5
})
```

#### `playSample(sampleName: string, audioTime: number, opts?: Record<string, number>, bpm?: number): Promise<number>`

Play a sample. Automatically loads the sample from CDN on first use. Translates Sonic Pi opts (`beat_stretch`, `rpitch`, etc.) to scsynth params.

```ts
const nodeId = await bridge.playSample('bd_haus', audioCtx.currentTime)
```

#### `applyFx(fxName: string, params: Record<string, number>, inBus: number, outBus?: number): Promise<number>`

Apply an audio effect. Returns the FX node ID.

```ts
const bus = bridge.allocateBus()
const fxNodeId = await bridge.applyFx('reverb', { room: 0.8 }, bus, 0)
```

#### `startLiveAudio(name: string, opts?: { stereo?: boolean }): Promise<void>`

Start capturing live audio from microphone/line-in. Requests user permission via `getUserMedia`.

#### `stopLiveAudio(name: string): void`

Stop a named live audio stream.

#### `allocateBus(): number`

Allocate a private audio bus for FX routing.

#### `freeBus(busNum: number): void`

Release a private audio bus back to the pool.

#### `allocateTrackBus(trackId: string): number`

Allocate a stereo output bus for a track with its own `AnalyserNode`. Returns the bus number.

#### `setMasterVolume(volume: number): void`

Set master volume (0--1). Uses exponential ramp for smooth transitions.

#### `freeAllNodes(): void`

Free all synth and FX nodes (clean slate for re-evaluate).

#### `dispose(): void`

Full teardown: stop live audio, disconnect nodes, destroy SuperSonic.

### Properties

#### `audioContext: AudioContext | null` (getter)

The Web Audio `AudioContext` from SuperSonic.

#### `analyser: AnalyserNode | null` (getter)

The master `AnalyserNode` for oscilloscope / FFT visualization.

---

## Events -- SoundEventStream

Lightweight event bus for visualization and logging.

### Types

```ts
interface SoundEvent {
  audioTime: number        // when the sound plays (AudioContext time)
  audioDuration: number    // estimated duration in seconds
  scheduledAheadMs: number // how far ahead it was scheduled
  midiNote: number | null  // MIDI note (for synths)
  s: string | null         // sample name (for samples)
  srcLine: number | null   // 1-based source line number
  trackId: string | null   // which live_loop produced this event
}
```

### Methods

#### `on(handler: (event: SoundEvent) => void): void`

Subscribe to sound events.

```ts
const { streaming } = engine.components
streaming.eventStream.on((event) => {
  if (event.midiNote) {
    highlightLine(event.srcLine)
  }
})
```

#### `off(handler: (event: SoundEvent) => void): void`

Unsubscribe a handler.

#### `emitEvent(event: SoundEvent): void`

Emit a sound event to all subscribers. One bad subscriber cannot break others.

#### `dispose(): void`

Clear all handlers.

---

## Music Theory

Standalone functions for note conversion, chord/scale generation, and data structures.

### Note Conversion

#### `noteToMidi(note: string | number): number`

Convert a note name to MIDI number. Accepts: `"c4"`, `"fs3"` (F#3), `"eb5"` (Eb5), or plain numbers.

```ts
import { noteToMidi } from '@spw/core'

noteToMidi('c4')  // 60
noteToMidi('a4')  // 69
noteToMidi('fs3') // 54
noteToMidi(60)    // 60
```

#### `midiToFreq(midi: number): number`

Convert MIDI number to frequency in Hz. A4 (MIDI 69) = 440 Hz.

```ts
import { midiToFreq } from '@spw/core'

midiToFreq(69) // 440
midiToFreq(60) // 261.63
```

#### `noteToFreq(note: string | number): number`

Convert note name or MIDI number directly to frequency.

```ts
import { noteToFreq } from '@spw/core'

noteToFreq('a4') // 440
```

### Chords and Scales

#### `chord(root: string | number, type: string): Ring<number>`

Build a chord as a Ring of MIDI note numbers.

```ts
import { chord } from '@spw/core'

chord('c4', 'major')  // Ring([60, 64, 67])
chord('e3', 'minor7') // Ring([52, 55, 59, 62])
```

Chord types: `major`, `minor`, `dim`, `aug`, `dom7`, `7`, `major7`, `M7`, `minor7`, `m7`, `dim7`, `aug7`, `halfdim`, `m9`, `dom9`, `9`, `major9`, `M9`, `minor11`, and more.

#### `scale(root: string | number, type: string, num_octaves?: number): Ring<number>`

Build a scale as a Ring of MIDI note numbers.

```ts
import { scale } from '@spw/core'

scale('c4', 'major')         // Ring([60, 62, 64, 65, 67, 69, 71])
scale('a3', 'minor_pentatonic') // Ring([57, 60, 62, 64, 67])
```

Scale types: `major`, `minor`, `minor_pentatonic`, `major_pentatonic`, `blues_major`, `blues_minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `whole_tone`, `chromatic`, `harmonic_minor`, `melodic_minor`, and more.

#### `chord_names(): string[]`

List all available chord type names.

#### `scale_names(): string[]`

List all available scale type names.

#### `chord_invert(notes: number[], inversion: number): number[]`

Invert a chord by shifting the lowest N notes up an octave.

```ts
import { chord_invert } from '@spw/core'

chord_invert([60, 64, 67], 1) // [64, 67, 72] -- first inversion
```

#### `note(n: string | number): number`

Convert a note name to MIDI number. Same as `noteToMidi`.

#### `note_range(low: string | number, high: string | number, opts?: { pitches: number[] }): number[]`

Generate all MIDI note numbers in a range, optionally filtering by pitch classes.

### Ring

Circular array that wraps indices. Never goes out of bounds.

```ts
import { ring } from '@spw/core'

const r = ring(60, 64, 67, 72)
r.at(0)  // 60
r.at(4)  // 60 (wraps)
r.at(-1) // 72 (wraps backward)
```

#### Ring Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `at` | `(index: number): T` | Access by index (wraps). |
| `tick` | `(): T` | Auto-incrementing access. |
| `look` | `(): T` | Read tick position without advancing. |
| `resetTick` | `(): void` | Reset the tick counter. |
| `choose` | `(): T` | Random element (Math.random). |
| `reverse` | `(): Ring<T>` | New ring with reversed order. |
| `shuffle` | `(): Ring<T>` | New ring with shuffled elements. |
| `pick` | `(n: number): Ring<T>` | Pick n random elements. |
| `take` | `(n: number): Ring<T>` | First n elements. |
| `drop` | `(n: number): Ring<T>` | Drop first n elements. |
| `stretch` | `(n: number): Ring<T>` | Repeat each element n times. |
| `mirror` | `(): Ring<T>` | `[1,2,3]` becomes `[1,2,3,2,1]`. |
| `repeat` | `(n: number): Ring<T>` | Repeat the ring n times. |
| `toArray` | `(): T[]` | Convert to plain array. |
| `length` | `number` (getter) | Number of elements. |

Ring is also iterable (`for...of` works).

#### `knit<T>(...args: (T | number)[]): Ring<T>`

Repeat each value N times, alternating value/count pairs.

```ts
import { knit } from '@spw/core'

knit('c4', 2, 'e4', 1) // Ring(['c4', 'c4', 'e4'])
```

#### `range(start: number, end: number, step?: number): Ring<number>`

```ts
import { range } from '@spw/core'

range(1, 5)      // Ring([1, 2, 3, 4])
range(1, 10, 2)  // Ring([1, 3, 5, 7, 9])
range(10, 0, -2) // Ring([10, 8, 6, 4, 2])
```

#### `line(start: number, finish: number, steps?: number): Ring<number>`

Generate evenly spaced values. Default `steps` is 4.

```ts
import { line } from '@spw/core'

line(60, 72, 5) // Ring([60, 63, 66, 69, 72])
```

#### `spread(hits: number, total: number, rotation?: number): Ring<boolean>`

Euclidean rhythm pattern (Bjorklund algorithm).

```ts
import { spread } from '@spw/core'

spread(3, 8)    // Ring([true, false, false, true, false, false, true, false])
spread(5, 8)    // Ring([true, false, true, true, false, true, true, false])
spread(3, 8, 1) // rotated by 1 position
```

### SeededRandom

Deterministic PRNG using Mersenne Twister (MT19937). Matches Sonic Pi's Ruby `Random` class -- same seed produces same sequence.

```ts
import { SeededRandom } from '@spw/core'

const rng = new SeededRandom(42)
rng.next()         // float in [0, 1)
rng.rrand(60, 72)  // float in [60, 72]
rng.rrand_i(1, 6)  // int in [1, 6]
rng.choose([1,2,3]) // random element
rng.dice(6)         // int in [1, 6]
rng.reset(42)       // re-seed
```

---

## Sandbox

Blocks dangerous browser globals in user code using a `Proxy`-based scope with `with()`.

### `createSandboxedExecutor(transpiledCode: string, dslParamNames: string[], dslValues?: unknown[]): (...args: unknown[]) => Promise<void>`

Create a sandboxed executor. All variable lookups go through a Proxy that returns `undefined` for blocked globals and the real value for DSL functions.

```ts
import { createSandboxedExecutor } from '@spw/core'

const executor = createSandboxedExecutor(
  'live_loop("test", (b) => b.play(60))',
  ['live_loop']
)
await executor(myLiveLoopFn)
```

### `validateCode(code: string): string[]`

Check for obvious sandbox escape hatches. Returns warning strings.

```ts
import { validateCode } from '@spw/core'

const warnings = validateCode(userCode)
// e.g. ['Code accesses "constructor" -- this may not work in sandbox mode.']
```

### `BLOCKED_GLOBALS: string[]`

List of globals blocked in user code:

```
fetch, XMLHttpRequest, WebSocket, EventSource,
localStorage, sessionStorage, indexedDB,
document, window, navigator, location, history,
setTimeout, setInterval, clearTimeout, clearInterval,
Worker, SharedWorker, ServiceWorker,
importScripts, postMessage, globalThis,
eval, Function
```

---

## Session Logging

Records every Run/Stop/Edit action with SHA-256 code hashes. Supports Ed25519 or HMAC-SHA256 signing for teacher verification.

### SessionLog

```ts
import { SessionLog } from '@spw/core'

const log = new SessionLog()
await log.initSigning()        // generate signing keys
await log.logRun(code)         // record a Run action
await log.logStop()            // record a Stop action
await log.logEdit(code)        // record an Edit action
await log.logLoadExample('Basic Beat', code)
```

#### `initSigning(): Promise<void>`

Generate signing keys. Tries Ed25519 first, falls back to HMAC-SHA256.

#### `logRun(code: string): Promise<void>`

Record a "run" action with the SHA-256 hash of the code.

#### `logStop(): Promise<void>`

Record a "stop" action.

#### `logEdit(code: string): Promise<void>`

Record an "edit" action.

#### `logLoadExample(exampleName: string, code: string): Promise<void>`

Record loading an example.

#### `getEntries(): SessionEntry[]`

Get a copy of all log entries.

```ts
interface SessionEntry {
  action: 'run' | 'stop' | 'edit' | 'load_example'
  timestamp: string   // ISO 8601
  codeHash: string    // SHA-256 hex
  detail?: string
}
```

#### `length: number` (getter)

Number of entries.

#### `clear(): void`

Clear the log.

#### `exportSigned(): Promise<SignedSession>`

Export the session as a signed JSON object.

```ts
interface SignedSession {
  entries: SessionEntry[]
  signature: string     // hex-encoded
  algorithm: string     // 'Ed25519' | 'HMAC-SHA256' | 'unsigned'
  publicKey?: string    // hex-encoded (Ed25519 only)
}
```

#### `exportAndDownload(): Promise<void>`

Export and trigger a browser download of the signed session JSON.

#### `static verify(session: SignedSession, publicKey?: CryptoKey): Promise<boolean>`

Verify a signed session against a public key. Returns `false` for unsigned sessions.

---

## Extensions

### Recorder

Captures AudioContext output to WAV.

```ts
import { Recorder } from '@spw/core'

const { audio } = engine.components
const recorder = new Recorder(audio.audioCtx, audio.analyser)

recorder.start()
// ... play music ...
await recorder.stopAndDownload()  // triggers WAV download
```

#### Constructor

```ts
new Recorder(audioCtx: AudioContext, source: AudioNode, options?: {
  sampleRate?: number
  channels?: number  // default: 2
})
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start` | `(): void` | Start recording. |
| `stop` | `(): Promise<Blob>` | Stop and return WAV blob. |
| `stopAndDownload` | `(filename?: string): Promise<void>` | Stop and trigger browser download. |
| `cancel` | `(): void` | Cancel recording without saving. |
| `state` | `'idle' \| 'recording' \| 'stopped'` (getter) | Current recorder state. |

### MidiBridge

Web MIDI API for note output and input-as-cue.

```ts
import { MidiBridge } from '@spw/core'

const midi = new MidiBridge()
const ok = await midi.init()
if (ok) {
  const devices = midi.getDevices()
  midi.selectOutput(devices[0].id)
  midi.noteOn(60, 100, 1)  // C4, velocity 100, channel 1
}
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `init` | `(): Promise<boolean>` | Request MIDI access. Returns `false` if unavailable. |
| `getDevices` | `(): MidiDevice[]` | List available MIDI input/output devices. |
| `selectOutput` | `(deviceId: string): boolean` | Select an output device. |
| `selectInput` | `(deviceId: string): boolean` | Select an input device. Incoming MIDI fires event handlers. |
| `onMidiEvent` | `(handler: MidiEventHandler): void` | Register handler for incoming MIDI events. |
| `noteOn` | `(note: number, velocity?: number, channel?: number): void` | Send MIDI note on. |
| `noteOff` | `(note: number, channel?: number): void` | Send MIDI note off. |
| `cc` | `(controller: number, value: number, channel?: number): void` | Send MIDI CC. |
| `allNotesOff` | `(channel?: number): void` | Send all-notes-off (CC 123). |
| `dispose` | `(): void` | Disconnect and clean up. |

#### Types

```ts
interface MidiDevice {
  id: string
  name: string
  type: 'input' | 'output'
}

type MidiEventHandler = (event: {
  type: 'note_on' | 'note_off' | 'cc'
  channel: number
  note?: number
  velocity?: number
  cc?: number
  value?: number
}) => void
```

### LinkBridge

Ableton Link tempo/beat/phase synchronization via WebRTC.

```ts
import { LinkBridge } from '@spw/core'

const link = new LinkBridge()
link.onStateChange((state) => {
  console.log(`Tempo: ${state.tempo}, Beat: ${state.beat}`)
})
const connected = await link.connect()
```

#### Types

```ts
interface LinkState {
  tempo: number
  beat: number
  phase: number
  peers: number
  connected: boolean
}

type LinkStateHandler = (state: LinkState) => void
```

Without the Node.js bridge running, LinkBridge provides local-only tempo/beat tracking using `AudioContext.currentTime`.

### CollaborationSession

CRDT-based shared code buffer using Yjs and WebRTC. Peer-to-peer, no server required. Yjs is loaded from CDN at runtime.

```ts
import { CollaborationSession, generateRoomId } from '@spw/core'

const roomId = generateRoomId()
const session = new CollaborationSession({
  onCodeChange: (code) => editor.setValue(code),
  onPeerJoin: (peer) => showPeer(peer),
  onPeerLeave: (id) => removePeer(id),
  onPeerCursor: (id, cursor) => showCursor(id, cursor),
}, 'Alice')

await session.join(roomId)
```

#### Types

```ts
interface Peer {
  id: string
  name: string
  color: string
  cursor?: { line: number; col: number }
}

interface CollabCallbacks {
  onCodeChange: (code: string) => void
  onPeerJoin: (peer: Peer) => void
  onPeerLeave: (peerId: string) => void
  onPeerCursor: (peerId: string, cursor: { line: number; col: number }) => void
}
```

---

## Query / Capture

Instant O(n) query of Programs without running the scheduler. Walks the step array, accumulates time, collects events in a time range.

### `queryProgram(program: Program, begin: number, end: number, bpm: number, startTime?: number): QueryEvent[]`

Query a single iteration of a Program for events in `[begin, end)`.

```ts
import { queryProgram } from '@spw/core'

const events = queryProgram(program, 0, 4, 120)
```

### `queryLoopProgram(program: Program, begin: number, end: number, bpm: number): QueryEvent[]`

Query a looping Program across a time range. Tiles the program to cover `[begin, end)`.

```ts
import { queryLoopProgram } from '@spw/core'

const events = queryLoopProgram(program, 0, 16, 120)
```

### `captureAll(program: Program, duration: number, bpm: number): QueryEvent[]`

Capture all events from a looping Program up to a duration. Convenience wrapper around `queryLoopProgram`.

```ts
import { captureAll } from '@spw/core'

const events = captureAll(program, 8, 120) // 8 seconds at 120 BPM
```

### QueryEvent

```ts
interface QueryEvent {
  type: 'synth' | 'sample'
  time: number               // in seconds
  duration: number            // estimated duration in seconds
  params: Record<string, unknown>
}
```

---

## Examples

Built-in example gallery with classic Sonic Pi patterns.

### `examples: Example[]`

Array of all examples, each with Ruby and JS versions.

```ts
interface Example {
  name: string
  description: string
  difficulty: 'beginner' | 'intermediate' | 'advanced'
  ruby: string
  js: string
}
```

### `getExample(name: string): Example | undefined`

Find an example by name (case-insensitive).

```ts
import { getExample } from '@spw/core'

const ex = getExample('Basic Beat')
if (ex) engine.evaluate(ex.ruby)
```

### `getExampleNames(): string[]`

Get all example names.

### `getExamplesByDifficulty(): Record<Difficulty, Example[]>`

Get examples grouped by difficulty level.

```ts
import { getExamplesByDifficulty } from '@spw/core'

const groups = getExamplesByDifficulty()
// groups.beginner, groups.intermediate, groups.advanced
```

---

## Sample Catalog

Browseable catalog of all available Sonic Pi samples.

### `getAllSamples(): SampleInfo[]`

Get all samples with metadata.

```ts
interface SampleInfo {
  name: string
  category: string
}
```

### `getCategories(): string[]`

Get all unique sample categories (e.g., `"bass drum"`, `"snare"`, `"hi-hat"`, `"ambient"`, `"loop"`).

### `getSamplesByCategory(category: string): SampleInfo[]`

Filter samples by category.

### `searchSamples(query: string): SampleInfo[]`

Search samples by name substring (case-insensitive).

### `getSampleNames(): string[]`

Get all sample names as a flat array.

---

## Stratum Detection

Classifies code into computational strata for determining whether capture/query is available.

```ts
import { detectStratum, Stratum } from '@spw/core'

enum Stratum {
  S1 = 1,  // Stateless, cyclic, deterministic -- capturable
  S2 = 2,  // Seeded stochastic -- capturable with seed
  S3 = 3,  // State-accumulating, external I/O -- streaming only
}

const stratum = detectStratum(code)
if (stratum <= Stratum.S2) {
  // capture/query is available
}
```

---

## Error Handling

### `friendlyError(err: Error): FriendlyError`

Convert a raw error into a structured friendly error.

```ts
import { friendlyError } from '@spw/core'

interface FriendlyError {
  title: string
  message: string
  line?: number
  original: Error
}
```

### `formatFriendlyError(err: FriendlyError): string`

Format a `FriendlyError` as a display string.

**Related:** `SonicPiEngine.formatError()` and `SonicPiEngine.formatErrorString()` are convenience wrappers.
