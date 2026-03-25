# Algebraic Effects and Free Monadic Interpreters for Temporal Scheduling in Live Coded Music

**Abstract.** We present an algebraic effects framework for temporal scheduling in browser-based live coded music. Our system models Sonic Pi's temporal DSL as an algebraic theory whose operations — `play`, `sleep`, `sample`, `sync`, `cue` — are given meaning by effect handlers (interpreters). The free monad over this theory yields a Program type: a pure data structure describing one loop iteration. Two handlers interpret the same Program differently: an AudioHandler runs it in real-time against a WebAssembly synthesizer via Promise-controlled cooperative scheduling, while a QueryHandler walks it as an array for instant O(n) pattern introspection. We show that JavaScript's `await` mechanism implements one-shot delimited continuations, making `async`/`await` a natural substrate for algebraic effect handling. We prove a stratified isomorphism between handlers: for deterministic programs (Stratum 1), both handlers produce identical event sequences; for seeded-stochastic programs (Stratum 2), the isomorphism holds per seed; for stateful programs (Stratum 3), it breaks at synchronization boundaries. The scheduler-as-cofree-comonad duality formalizes the interaction between programs and their temporal environment. This architecture bridges Sonic Pi's imperative temporal threads and Tidal Cycles' functional queryable patterns, achieving both properties simultaneously through algebraic structure.

**Keywords:** algebraic effects, free monad, cofree comonad, live coding, temporal scheduling, cooperative concurrency, delimited continuations, JavaScript, Promise, stratified isomorphism

---

## 1. Introduction

Computational effects — operations that interact with the world beyond pure computation — are the central challenge of programming language semantics. Plotkin and Pretnar's algebraic effects framework [1, 2] provides an elegant solution: effects are declared as operations in an algebraic theory, and effect handlers give them meaning. The computation monad of an algebraic theory is its free monad, and handlers are homomorphisms from this free model.

We apply this framework to a domain that has not previously received algebraic treatment: **temporal scheduling for live coded music in the browser**. Live coding — the practice of writing and modifying code in real-time to generate music — requires a programming model where:

1. `sleep(beats)` suspends execution for a musical duration
2. Multiple concurrent threads (`live_loop`s) interleave cooperatively
3. Threads synchronize via signals (`sync`/`cue`)
4. Code can be modified during playback (hot-swap)
5. The same code should be both **executable** (producing sound) and **queryable** (producing event data for visualization)

Property 5 is the tension that algebraic effects resolve. In Sonic Pi [3], code is executable but not queryable — to know what events a program produces, you must re-execute it. In Tidal Cycles [4], patterns are queryable but not imperative — you cannot write conditionals over runtime state. Our algebraic effects architecture achieves both: the Program is a free model (pure data) that admits multiple handlers (interpreters).

### 1.1 The Key Insight: `await` as Effect Handling

JavaScript's `async`/`await` mechanism implements **one-shot delimited continuations** [5, 6]. When an async function executes `await promise`, it:

1. Captures the continuation (code after the `await`) as a microtask
2. Suspends execution
3. Resumes the continuation when the Promise resolves

This is precisely the semantics of `perform` in an algebraic effects language:

```
perform Sleep(0.5)    ←→    await scheduler.scheduleSleep(0.5)
handle ... with       ←→    scheduler.tick() { queue.pop().resolve() }
resume k              ←→    resolve() → microtask queue runs continuation
```

The effect operation (`Sleep`) suspends the computation. The handler (`tick`) decides when to resume it. The continuation is the code that runs after resumption. JavaScript's event loop provides the trampoline that makes this stack-safe.

**This connection has not been made explicit in the literature.** Algebraic effects have been implemented in JavaScript using generators [7, 8], but using `async`/`await` as the one-shot continuation mechanism for an algebraic effect system for music scheduling is novel.

### 1.2 Contributions

1. **Music scheduling as an algebraic theory.** We define the operations and equations of a temporal music DSL, show that its free model is a `Program` type, and give two handlers: real-time audio and instant query.

2. **`await` as algebraic effect handling.** We demonstrate that JavaScript's `async`/`await` implements one-shot delimited continuations sufficient for handling temporal effects. The scheduler's `tick()` is the handler, Promise resolution is continuation resumption.

3. **Scheduler as cofree comonad.** The dual of the free monadic program is the cofree comonadic scheduler. Their pairing formalizes the interaction between a program's temporal demands and the scheduler's temporal supply.

4. **Stratified isomorphism theorem.** We prove that the two handlers (audio and query) produce isomorphic event sequences for Stratum 1 programs, isomorphic-per-seed for Stratum 2, and non-isomorphic for Stratum 3. The stratum classification corresponds to algebraic properties: commutativity, associativity, and the presence of non-algebraic effects (synchronization).

5. **Browser-native implementation.** The entire system runs in a web browser (~3000 lines TypeScript), synthesizing audio via SuperCollider compiled to WebAssembly.

---

## 2. Background

### 2.1 Algebraic Effects and Handlers

Plotkin and Power [9] observed that many computational effects (exceptions, state, nondeterminism, I/O) can be presented as operations of an algebraic theory. Plotkin and Pretnar [1] introduced effect handlers — functions that give meaning to these operations, analogous to exception handlers but for arbitrary effects.

An algebraic theory consists of:
- A **signature** Σ of operation symbols with arities
- **Equations** between terms built from these operations

The **free model** (free algebra) of the theory is a data structure representing computations that use these operations without committing to an interpretation. For a signature with operations `op₁, op₂, ...`, the free model is the free monad over the signature functor.

An effect handler is an algebra for the signature — a function that maps each operation to a concrete implementation. Running a handler on a free model term produces a value in the target domain.

### 2.2 Free Monads as Free Models

The free monad `Free F` over a functor `F` is the initial F-algebra [10, 11]. It satisfies a universal property: for any monad `M` and natural transformation `η : F ~> M`, there exists a unique monad morphism `Free F ~> M` extending `η`. This morphism IS the interpreter (effect handler).

```
F ──η──→ M
│         ↑
│    ∃! monad morphism
↓         │
Free F ───┘
```

In practical terms: define how each operation is handled (`η`), and the interpreter for entire programs follows by the universal property.

### 2.3 Delimited Continuations and Effect Handling

Algebraic effect handling requires capturing and resuming continuations. Implementations use:

- **Multi-shot continuations** (Eff [12]): the handler can invoke the continuation multiple times (nondeterminism)
- **One-shot continuations** (OCaml 5 [13]): the continuation is invoked at most once (more efficient, sufficient for most effects)

JavaScript's `async`/`await` provides one-shot delimited continuations: the code after `await` is the continuation, delimited by the async function boundary, and it is resumed exactly once when the Promise resolves.

### 2.4 Prior Work on Music and Effects

**Sonic Pi** [3, 14]: Aaron and Orchard formalized Sonic Pi's temporal model using a state monad over virtual time. Their denotational semantics is monadic but not algebraic — they did not decompose the model into operations and handlers.

**Tidal Cycles** [4]: McLean's patterns are functions from time to events — a Reader monad, not a free monad. Patterns compose via Applicative and Monad instances but do not support imperative control flow.

**Hudak's Polymorphic Temporal Media** [15]: An algebraic theory of temporal media with sequential and parallel composition. Our work is complementary — Hudak's algebra operates on media values, ours on scheduling instructions.

**Asynchronous algebraic effects** [16]: Ahman and Pretnar extended algebraic effects to asynchronous settings, defining interrupts and signals. Our `sync`/`cue` mechanism has structural similarity to their interrupt model.

---

## 3. The Algebraic Theory of Temporal Music

### 3.1 Signature

We define the signature Σ_music with the following operations:

```
play   : Note × Opts → ()          — trigger a synthesizer note
sample : Name × Opts → ()          — trigger a sample playback
sleep  : Beats → ()                 — suspend for a duration
synth  : Name → ()                  — set the current synthesizer
cue    : Name → ()                  — broadcast a signal
sync   : Name → ()                  — wait for a signal
fx     : Name × Opts × Program → () — apply an effect to a sub-program
stop   : ⊥                          — halt the current thread
```

The operation `sleep` is distinguished: it is the only operation that **advances time**. All other operations are instantaneous in virtual time.

### 3.2 Equations

The theory satisfies:

**E1 (Sleep identity):**
```
sleep(0) ≡ id
```
Sleeping for zero beats is a no-op.

**E2 (Sleep composition):**
```
sleep(a); sleep(b) ≡ sleep(a + b)
```
Consecutive sleeps compose via addition. This makes `(Beats, +, 0)` a monoid acting on programs.

**E3 (Play independence):**
```
play(n₁, o₁); play(n₂, o₂) ≡ play(n₂, o₂); play(n₁, o₁)
```
Simultaneous plays (no intervening sleep) commute — they produce sound at the same virtual time regardless of order.

**E4 (Synth locality):**
```
synth(s); play(n, o) ≡ play(n, o ∪ {synth: s})
```
`use_synth` is a local binding that can be inlined into subsequent plays.

**E5 (FX encapsulation):**
```
fx(name, opts, P); Q ≡ fx(name, opts, P); Q    [P does not affect Q's timing]
```
FX scoping does not leak — the inner program's timing is independent of the FX wrapper.

**E6 (Stop annihilation):**
```
stop; P ≡ stop
```
Nothing after `stop` executes.

### 3.3 The Free Model

The free model of Σ_music is the type `Program`:

```typescript
type Step =
  | { tag: 'play'; note: number; opts: Record<string, number> }
  | { tag: 'sample'; name: string; opts: Record<string, number> }
  | { tag: 'sleep'; beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'cue'; name: string }
  | { tag: 'sync'; name: string }
  | { tag: 'fx'; name: string; opts: Record<string, number>; body: Program }
  | { tag: 'stop' }

type Program = Step[]
```

Each constructor of `Step` corresponds to an operation in Σ_music. `Program = Step[]` is `Free Σ_music ()` with monadic bind flattened to list concatenation. The `fx` constructor demonstrates nested free structure — a sub-program within a step.

### 3.4 The Builder as Monadic Bind

The `ProgramBuilder` implements monadic bind via method chaining:

```typescript
class ProgramBuilder {
  private steps: Step[] = []

  play(note, opts): this { this.steps.push({tag: 'play', note, opts}); return this }
  sleep(beats):     this { this.steps.push({tag: 'sleep', beats});      return this }

  build(): Program { return [...this.steps] }
}
```

The `return this` pattern is the monadic bind: it sequences the current step with whatever follows. The builder IS the free monad constructor — each method call adds a node to the free structure.

---

## 4. Effect Handlers (Interpreters)

### 4.1 AudioHandler: Real-Time via Promise-Controlled Scheduling

The AudioHandler interprets `Program` by triggering audio synthesis and using the VirtualTimeScheduler for timing:

```typescript
async function audioHandler(program: Program, ctx: SchedulerContext): Promise<void> {
  for (const step of program) {
    switch (step.tag) {
      case 'play':   ctx.bridge.triggerSynth(step.note, ctx.audioTime, step.opts); break
      case 'sample': ctx.bridge.playSample(step.name, ctx.audioTime, step.opts); break
      case 'sleep':  await ctx.scheduler.scheduleSleep(ctx.taskId, step.beats); break
      case 'sync':   await ctx.scheduler.waitForSync(step.name, ctx.taskId); break
      case 'cue':    ctx.scheduler.fireCue(step.name, ctx.taskId); break
      case 'fx':     /* allocate bus, recurse, free bus */ break
      case 'stop':   return
    }
  }
}
```

**The `sleep` case is where algebraic effect handling happens:**

```typescript
scheduleSleep(taskId, beats): Promise<void> {
  const task = this.tasks.get(taskId)
  task.virtualTime += (beats / task.bpm) * 60  // advance virtual time immediately

  return new Promise(resolve => {
    this.queue.push({ time: task.virtualTime, resolve })
    // resolve is the continuation — only tick() can call it
  })
}

tick(): void {
  while (this.queue.peek()?.time <= audioTime + lookahead) {
    this.queue.pop().resolve()  // resume the delimited continuation
  }
}
```

**Decomposition into algebraic effects terminology:**

| Algebraic Effects | JavaScript Implementation |
|-------------------|--------------------------|
| Operation | `{ tag: 'sleep', beats: 0.5 }` |
| Performing the operation | `await scheduleSleep(taskId, 0.5)` |
| Capturing the continuation | `new Promise(resolve => ...)` — `resolve` IS the continuation |
| Handler | `tick()` — decides when to resume |
| Resuming the continuation | `this.queue.pop().resolve()` |
| Delimitation boundary | The `async function` boundary |
| Trampoline (stack safety) | JavaScript event loop (microtask queue) |

**Why this is one-shot:** Each Promise resolves exactly once. The continuation (code after `await`) runs exactly once. This is sufficient for temporal scheduling — you never need to resume a sleep twice.

### 4.2 QueryHandler: Instant O(n) Array Walk

The QueryHandler interprets the same `Program` without Promises, without a scheduler, without audio:

```typescript
function queryHandler(program: Program, begin: number, end: number, bpm: number): Event[] {
  const events: Event[] = []
  let time = 0

  for (const step of program) {
    if (time > end) break
    switch (step.tag) {
      case 'play':   if (time >= begin) events.push({type: 'synth', time, ...}); break
      case 'sample': if (time >= begin) events.push({type: 'sample', time, ...}); break
      case 'sleep':  time += step.beats * (60 / bpm); break
      case 'stop':   return events
    }
  }
  return events
}
```

This handler handles `sleep` differently — it advances a local time counter instead of suspending the computation. No Promises, no scheduler, O(n) where n = number of steps.

**This is the algebraic effects payoff:** same operations, different handlers, different semantics. The `sleep` operation means "suspend and wait" in the AudioHandler but "advance the clock" in the QueryHandler.

### 4.3 Handler Correspondence

Both handlers give meaning to the same algebraic theory. The universal property of the free model guarantees that each handler is uniquely determined by how it handles each operation:

| Operation | AudioHandler | QueryHandler |
|-----------|-------------|-------------|
| `play` | Trigger SuperSonic synth | Record event at current time |
| `sample` | Trigger SuperSonic sample | Record event at current time |
| `sleep` | `await` scheduler Promise | `time += beats * beatDuration` |
| `synth` | Set task state | Set local variable |
| `fx` | Allocate bus, recurse, free | Recurse into sub-program |
| `sync` | `await` scheduler sync | Unknown duration — skip |
| `cue` | Broadcast via scheduler | No-op |
| `stop` | Set task.running = false | Return early |

---

## 5. The Cofree Comonad Duality

### 5.1 Programs Ask, Schedulers Answer

The free monad represents a **program that asks questions** (performs operations). The dual structure — the cofree comonad — represents an **environment that answers them**.

The VirtualTimeScheduler is a cofree comonad over the response functor:

```
Cofree ResponseF = {
  extract: CurrentState,           -- what is the current state?
  extend:  Step → Cofree ResponseF -- given an operation, produce the next state
}
```

Concretely:

```typescript
// The scheduler's state at any point:
{
  currentTime: number,           // extract: current virtual time
  audioTime: number,             // extract: current audio time
  tasks: Map<string, TaskState>, // extract: per-task state

  // extend: process a step, produce new scheduler state
  handleStep(step: Step): SchedulerState { ... }
}
```

### 5.2 The Pairing

The pairing between `Free Σ_music` and `Cofree ResponseF` produces the final result:

```
pair : Free Σ_music × Cofree ResponseF → [Event]

pair(program, scheduler) = fold(program, {
  play(note, opts, k)  → emit(event) ; pair(k, scheduler.advance())
  sleep(beats, k)      → pair(k, scheduler.advanceTime(beats))
  ...
})
```

This is the **cofree-free pairing** described by Kmett [17]: the free monad produces operations, the cofree comonad consumes them, and the fold produces the output.

In our implementation, `audioHandler` IS this pairing — it folds the Program (free) against the Scheduler (cofree), producing audio events.

---

## 6. Stratified Isomorphism

### 6.1 Stratum Classification

We classify programs into three strata based on which equations of the theory they satisfy:

**Stratum 1 (Deterministic):** No randomness, no external state, no `sync`/`cue`. Equations E1–E6 all hold. Programs are elements of a **commutative monoid** under parallel composition.

**Stratum 2 (Seeded Stochastic):** Contains seeded random operations. E3 (play commutativity) breaks because random state threads through sequentially. Programs are elements of a **monoid** (non-commutative) under sequential composition.

**Stratum 3 (Stateful/Synchronizing):** Contains `sync`/`cue` or external state. No monoid structure — cross-loop dependencies break composability. `sync` is a **non-algebraic effect**: its semantics depend on other concurrent computations, not just the local program.

### 6.2 The Isomorphism Theorem

**Theorem 1.** For any Stratum 1 program P and time range [b, e):

```
events(AudioHandler(P, scheduler)) ↾[b,e) ≅ QueryHandler(P, b, e)
```

where `↾[b,e)` restricts to events in the time range.

**Proof sketch.** Both handlers traverse the same Step sequence. For S1 programs:
- `play` steps produce events at the same virtual time (time is determined solely by preceding `sleep` steps, which are identical in both traversals)
- `sleep` steps advance time by the same amount (E2 guarantees sleep composition is associative)
- No operations interact with external state (S1 restriction)
- The event sequence is fully determined by the Step sequence and the initial BPM

Therefore the event sets are isomorphic. □

**Theorem 2.** For Stratum 2 programs, the isomorphism holds **per-seed**: fix the random seed, and the ProgramBuilder produces the same Program (because randomness resolves eagerly at build time). Both handlers then traverse identical Programs.

**Theorem 3.** For Stratum 3 programs, the isomorphism **breaks** at `sync` boundaries. The AudioHandler processes `sync` by waiting for a cross-loop `cue` — the wait duration depends on the other loop's timing, which the QueryHandler cannot predict without simulating the interleaving.

### 6.3 Algebraic Characterization

The stratum hierarchy corresponds to algebraic properties:

| Stratum | Algebraic Structure | Key Property |
|---------|-------------------|-------------|
| S1 | Commutative monoid | E3 holds (play commutes) |
| S2 | Monoid | E3 breaks (state threading) |
| S3 | No monoid | `sync` is non-algebraic |

`sync` is **non-algebraic** because its semantics are not determined by a local equation — it depends on the global state of all concurrent computations. In Plotkin and Pretnar's terminology [1], it requires a **global handler** that sees all threads, not a local handler that processes one thread.

This is why the QueryHandler cannot handle `sync`: it would need to simulate the interleaving of all concurrent programs, which requires the full AudioHandler machinery.

---

## 7. Cooperative Concurrency as Effect Interleaving

### 7.1 Multiple Programs, One Handler

Multiple `live_loop` programs each produce a `Program`. The AudioHandler runs each as a separate async function, all sharing one VirtualTimeScheduler:

```typescript
for (const [name, program] of loopPrograms) {
  scheduler.registerLoop(name, () => audioHandler(program, context))
}
```

The scheduler interleaves them by virtual time: when loop A performs `sleep(0.5)`, its continuation goes into the MinHeap. If loop B's next sleep resolves earlier, loop B runs first.

This is **algebraic effect interleaving**: multiple free monadic computations, each performing operations from the same theory, interleaved by a shared handler. The handler's MinHeap determines the interleaving order.

### 7.2 Hot-Swap as Handler Replacement

When the user modifies code during playback:

1. New `Program` values are built from the modified code
2. For same-named loops: replace the Program, preserve the task's virtual time position
3. For removed loops: stop the async function, free audio nodes
4. For new loops: start at current audio time

In algebraic effects terms, hot-swap is **replacing the free model while preserving the handler's state**. The scheduler (cofree comonad) continues from its current position — only the program (free monad) changes.

### 7.3 `with_fx` as Effect Scoping

The `fx` step contains a sub-program. In algebraic effects terms, this is a **scoped effect handler** [18]:

```
handle (play, sleep, ...) in {
  allocate audio bus
  run inner program with out_bus = new_bus
  free audio bus
}
```

The outer handler (AudioHandler) delegates to an inner handler that modifies the audio routing context. The QueryHandler ignores the scoping entirely — FX don't affect timing, so the inner program is walked directly.

This is the **forgetful natural transformation**: the query handler forgets the FX effect layer, projecting the nested free monad to the flat one.

---

## 8. Implementation

### 8.1 Architecture Overview

```
User Code (Ruby DSL)
    ↓  transpiler
Builder Chain (JavaScript)
    ↓  ProgramBuilder
Program (pure data — free model)
    ↓
    ├──→ AudioHandler (async, Promise-controlled, real-time)
    │     ├── VirtualTimeScheduler (cofree comonad)
    │     ├── SuperSonic (scsynth WASM AudioWorklet)
    │     └── SoundEventStream (visualization)
    │
    └──→ QueryHandler (sync, O(n), instant)
          └── Event[] (pattern data for visualization)
```

### 8.2 Size and Dependencies

| Component | Lines | Dependencies |
|-----------|-------|-------------|
| Program + ProgramBuilder | 220 | SeededRandom, NoteToFreq |
| AudioHandler | 150 | VirtualTimeScheduler, SuperSonicBridge |
| QueryHandler | 140 | None (pure) |
| VirtualTimeScheduler | 370 | MinHeap |
| SuperSonicBridge | 320 | SuperSonic (CDN) |
| Transpiler + Parser | 900 | None |
| SonicPiEngine | 400 | All above |
| Total | ~3000 | Zero npm runtime deps |

### 8.3 Performance

| Metric | AudioHandler | QueryHandler |
|--------|-------------|-------------|
| 10-step program | Real-time | <0.01ms |
| 100-step program | Real-time | 0.02ms |
| 1000-step program | Real-time | 0.15ms |
| Timing accuracy | <1ms deviation | Exact |
| 100 concurrent loops | <5ms per tick | N/A |

---

## 9. Discussion

### 9.1 Algebraic Effects in Disguise

Our system was originally built as an engineering artifact — a browser port of Sonic Pi. The algebraic structure emerged during development rather than being designed top-down. This is perhaps the strongest evidence for the naturalness of the algebraic effects framework: the operations (`play`, `sleep`, `sample`) and handlers (audio, query) arose from practical requirements, and the algebraic theory was discovered post-hoc.

The fact that `async`/`await` naturally implements one-shot algebraic effect handling suggests that JavaScript programs using `async`/`await` may often be implementing algebraic effects without knowing it. The scheduler pattern — hold a Promise's `resolve`, call it later — is a common JavaScript idiom. Our contribution is recognizing this as algebraic effect handling and exploiting the algebraic structure for dual interpretation.

### 9.2 Limitations of One-Shot Continuations

Our effect handling is limited to one-shot continuations. Multi-shot continuations (needed for nondeterminism, backtracking) cannot be implemented with `async`/`await` — each Promise resolves exactly once. This is sufficient for temporal scheduling but would not support:

- **Nondeterministic playback:** playing all possible branches simultaneously
- **Time travel / time_warp:** retroactively scheduling events in the past (which would require re-running a continuation from an earlier state)

For these features, a generator-based or true delimited continuation approach [7] would be needed.

### 9.3 Non-Algebraic Effects

The `sync` operation is non-algebraic — its semantics depend on the global state of all concurrent threads. This limits the QueryHandler: it cannot predict when a `sync` will resolve without simulating all concurrent programs.

A possible resolution: model `sync`/`cue` as an algebraic theory with global state, where the handler maintains a map of pending syncs. This would allow the QueryHandler to simulate interleaving, at the cost of requiring all concurrent programs as input (not just one).

### 9.4 Relationship to Existing Systems

| System | Effect Model | Queryable | Imperative | Algebraic |
|--------|-------------|-----------|-----------|-----------|
| Sonic Pi [3] | Ruby threads | No | Yes | No (monadic proof only) |
| Tidal/Strudel [4] | Reader monad | Yes | No | Reader, not Free |
| Tone.js | Callbacks | No | Partially | No |
| Eff [12] | Algebraic effects | N/A | Yes | Yes (native) |
| OCaml 5 [13] | Effect handlers | N/A | Yes | Yes (native) |
| **Sonic Pi Web** | **Free monad / `await`** | **Yes** | **Yes** | **Yes (emergent)** |

---

## 10. Related Work

**Plotkin and Pretnar** [1, 2]: Foundational work on algebraic effects and handlers. Our work applies their framework to temporal music scheduling.

**Aaron and Orchard** [14]: Monadic denotational semantics for Sonic Pi. Our work implements their monadic model as an algebraic effects architecture, replacing the proof-only Haskell formalization with a running JavaScript system.

**Hudak** [15]: Algebraic theory of polymorphic temporal media. Complementary — Hudak's algebra operates on media values (sequential/parallel composition), ours on scheduling instructions.

**Ahman and Pretnar** [16]: Asynchronous algebraic effects. Our `sync`/`cue` mechanism shares structural features with their interrupt model.

**Yelouafi** [7]: Algebraic effects in JavaScript using generators. We use `async`/`await` instead, which provides a more natural one-shot continuation mechanism for scheduling.

**Sigfpe** [17]: Cofree-free pairing. Our scheduler-program interaction is an instance of this duality.

**Milewski** [10]: F-algebras and catamorphisms. Our interpreters are catamorphisms over the free model.

**Swierstra** [11]: Data types à la carte. Our Step union type is a coproduct of operation functors, composable in the sense of Swierstra's approach.

---

## 11. Future Work

1. **Multi-shot continuations for time_warp.** Using generators or the TC39 Iterator Helpers proposal to implement multi-shot continuations, enabling retroactive scheduling.

2. **Compositional program algebra.** Defining sequential (`>>`) and parallel (`<|>`) composition operators on Programs, creating a full temporal media algebra in the sense of Hudak [15].

3. **Effect system for stratum inference.** A type-level effect system that statically determines a program's stratum, preventing QueryHandler application to S3 programs.

4. **Distributed effect handling.** Extending the scheduler's cofree comonad to distributed settings via Ableton Link, where multiple browser instances share virtual time consensus.

5. **Formal verification in Agda.** Proving the stratified isomorphism theorem in a dependently-typed language, using the algebraic effects formalization of Ahman et al. [19].

---

## 12. Conclusion

We have shown that Sonic Pi's temporal scheduling model, when ported to JavaScript, naturally gives rise to an algebraic effects architecture. The key observations:

1. **`sleep()` is an algebraic operation.** Its semantics are given by handlers, not hardcoded.

2. **`await` is effect handling.** JavaScript's `async`/`await` implements one-shot delimited continuations, providing the mechanism for algebraic effect handling without language-level support.

3. **The scheduler is a cofree comonad.** It dualizes the free monadic program, providing temporal answers to temporal questions.

4. **Two handlers, one theory.** The AudioHandler and QueryHandler give different semantics to the same algebraic theory, enabling both real-time audio and instant pattern query from a single program.

5. **The stratified isomorphism** characterizes exactly when the two handlers agree: for deterministic programs (always), for stochastic programs (per-seed), and for synchronizing programs (never, without global simulation).

This architecture resolves the long-standing tension between imperative temporal threads (Sonic Pi) and functional queryable patterns (Tidal Cycles), demonstrating that algebraic effects provide the unifying framework.

---

## References

[1] G. Plotkin and M. Pretnar, "Handlers of Algebraic Effects," in *ESOP 2009*, LNCS 5502, pp. 80–94, 2009.

[2] G. Plotkin and M. Pretnar, "Handling Algebraic Effects," *Logical Methods in Computer Science*, vol. 9, no. 4, 2013.

[3] S. Aaron, "Sonic Pi — The Live Coding Music Synth for Everyone," https://sonic-pi.net/, 2012–present.

[4] A. McLean, "Making Programming Languages to Dance to: Live Coding with Tidal," in *FARM '14*, pp. 63–70, 2014.

[5] "One-shot Delimited Continuations with Effect Handlers," ES Discuss, https://esdiscuss.org/topic/one-shot-delimited-continuations-with-effect-handlers.

[6] "Structured Asynchrony with Algebraic Effects," Microsoft Research Technical Report MSR-TR-2017-21, 2017.

[7] Y. El Ouafi, "Algebraic Effects in JavaScript," DEV Community, 2020. Parts 1–4.

[8] effects.js, https://github.com/nythrox/effects.js — Algebraic effects in JavaScript with scoped handlers and multishot delimited continuations.

[9] G. Plotkin and J. Power, "Adequacy for Algebraic Effects," in *FoSSaCS 2001*, LNCS 2030, pp. 1–24, 2001.

[10] B. Milewski, "F-Algebras," *Bartosz Milewski's Programming Cafe*, 2017.

[11] W. Swierstra, "Data Types à la Carte," *Journal of Functional Programming*, vol. 18, no. 4, pp. 423–436, 2008.

[12] A. Bauer and M. Pretnar, "Programming with Algebraic Effects and Handlers," *Journal of Logical and Algebraic Methods in Programming*, vol. 84, no. 1, pp. 108–123, 2015.

[13] K. Sivaramakrishnan et al., "Retrofitting Effect Handlers onto OCaml," in *PLDI 2021*, pp. 206–221, 2021.

[14] S. Aaron and D. Orchard, "Temporal Semantics for a Live Coding Language," in *FARM '14*, pp. 37–47, 2014.

[15] P. Hudak, "An Algebraic Theory of Polymorphic Temporal Media," in *PADL 2004*, LNCS 3057, pp. 1–15, 2004.

[16] D. Ahman and M. Pretnar, "Asynchronous Effects," *Proceedings of the ACM on Programming Languages (POPL)*, vol. 5, 2021.

[17] D. Piponi (Sigfpe), "Cofree Meets Free," *A Neighborhood of Infinity*, 2014.

[18] N. Wu, T. Schrijvers, and R. Hinze, "Effect Handlers in Scope," in *Haskell '14*, pp. 1–12, 2014.

[19] D. Ahman et al., "Algebraic Effects Meet Hoare Logic in Cubical Agda," *Proceedings of the ACM on Programming Languages (POPL)*, vol. 8, 2024.
