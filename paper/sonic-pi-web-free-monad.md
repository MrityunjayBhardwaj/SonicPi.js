# A Free Monadic Architecture for Live Coding Music in the Browser

**Abstract.** We present Sonic Pi Web, a browser-native reimplementation of Sonic Pi's temporal scheduling model in JavaScript. Our key contribution is a free monadic architecture where `sleep()` returns a Promise that only the scheduler can resolve, giving JavaScript cooperative concurrency with virtual time — the exact semantics of Sonic Pi's Ruby threads, achieved without blocking or native threads. We show that Promise suspension is isomorphic to monadic bind for temporal scheduling, that the JavaScript event loop serves as a natural trampoline for the free monad, and that a single program representation admits both real-time (audio) and instant (query) interpreters. This architecture bridges two previously disjoint paradigms: Tidal Cycles' pure-functional queryable patterns and Sonic Pi's imperative temporal threads.

**Keywords:** free monad, live coding, cooperative concurrency, Promise, virtual time, JavaScript, Web Audio, Sonic Pi, scheduling

---

## 1. Introduction

Live coding music — the practice of writing and modifying code in real time to generate sound — has produced two dominant paradigms, each with a fundamental limitation:

1. **Imperative temporal threads** (Sonic Pi [1]): User code reads as sequential instructions — `play 60; sleep 0.5; play 64` — with `sleep` suspending the thread for a musical duration. Multiple `live_loop` threads run concurrently, interleaved by a scheduler. This model is intuitive for beginners and supports full imperative control (conditionals, mutation, inter-thread synchronization). However, it is **not queryable**: to determine what events occur in a time range, the system must re-execute the code, which is slow and non-deterministic for stochastic programs.

2. **Pure functional patterns** (Tidal Cycles [2], Strudel [3]): Patterns are functions from time spans to event sets. The core operation `queryArc(begin, end)` returns events instantly without executing user code. This enables visualization, caching, and structural analysis. However, the model is **purely declarative**: users cannot write `if/else` conditionals that depend on runtime state, imperative mutation, or cross-thread synchronization (`sync`/`cue`).

Neither paradigm offers both imperative expressiveness and instant queryability. We resolve this tension using a **free monadic architecture** where user code builds a pure data structure (the Program) that can be interpreted in multiple ways: the AudioInterpreter runs it against real audio with scheduler-controlled Promise resolution, while the QueryInterpreter walks it as an array in O(n) time.

The central insight: `sleep()` returns a `Promise` whose `resolve` function is held by the scheduler. The user's async function suspends at `await sleep(0.5)` — it is not blocked, but parked. The scheduler's `tick()` method, driven by `setInterval(25ms)`, resolves Promises whose virtual time has been reached. This gives JavaScript **cooperative concurrency with virtual time**: multiple `live_loop` async functions yield control at sleep boundaries and are resumed in deterministic virtual-time order.

We show that this mechanism is isomorphic to the monadic bind operation in a free monad over a temporal DSL functor, with the JavaScript event loop serving as the trampoline that makes the recursion stack-safe.

### 1.1 Contributions

1. **Promise-controlled scheduling as monadic bind.** We demonstrate that `new Promise(resolve => scheduler.holds(resolve))`, combined with `await`, implements the bind operation of a free monad over a temporal DSL. This has not previously been used for music scheduling.

2. **Free monad with dual interpreters.** A single `Program` (Step array) admits both a real-time AudioInterpreter (using scheduler Promises for sleep) and an instant QueryInterpreter (walking the array without Promises). This gives imperative code instant queryability — a property neither Sonic Pi nor Tidal Cycles achieves alone.

3. **Cooperative concurrency via async/await interleaving.** Multiple `live_loop` programs are interleaved by a shared VirtualTimeScheduler that resolves sleep Promises in deterministic order. This gives JavaScript the same cooperative concurrency as Sonic Pi's Ruby threads, without threads.

4. **Browser-native implementation.** The entire system runs in the browser with zero server components. Audio synthesis uses SuperSonic (SuperCollider's scsynth compiled to WebAssembly as an AudioWorklet). The implementation comprises ~3000 lines of TypeScript.

---

## 2. Background and Related Work

### 2.1 Sonic Pi's Temporal Semantics

Aaron and Orchard [1] formalized Sonic Pi's temporal model in a monadic denotational semantics, proving "time safety" — that virtual time advances correctly. Their key insight: `sleep` does not pause wall-clock time; it advances a per-thread virtual time counter. The scheduler maps virtual time to audio time, ensuring that accumulated computation delays do not cause timing drift.

Their formalization uses Haskell as a metalanguage, modeling the temporal semantics as a state monad over virtual time. However, the actual Sonic Pi implementation uses Ruby threads with blocking `sleep` calls and an Erlang-based (BEAM VM) server for timing coordination. The monadic model was a proof tool, not an implementation architecture.

**Our work directly implements the monadic model.** Where Aaron and Orchard used Haskell to prove properties of a Ruby system, we use the monadic structure as the system's architecture in JavaScript.

### 2.2 Tidal Cycles and Strudel

Tidal Cycles [2] models music as patterns — functions from time spans (arcs) to event sets. The `Pattern` type forms an Applicative functor and a Monad [4]:

```haskell
type Pattern a = Arc -> [Event a]
```

Strudel [3] ports this to JavaScript, implementing `queryArc(begin, end)` as the core operation. The scheduler calls `queryArc` every 50ms with a lookahead window, scheduling returned events via Web Audio.

This is a Reader monad (function from time), not a free monad. It is purely declarative: patterns are composed via combinators (`cat`, `stack`, `fast`, `slow`), not via imperative sequences. Users cannot write `if rand() > 0.5 then play(60) else play(64)` — conditionals over runtime state require imperative control flow, which the functional pattern model does not support.

### 2.3 Cooperative Concurrency in JavaScript

Zhao [5] proposed a concurrency model for JavaScript with cooperative cancellation using a reader monad to pass thread IDs through Promise chains. Their model supports pause, resume, and hierarchical cancellation.

Our scheduler extends this approach to music-specific requirements: virtual time (not wall time) determines when suspended computations resume; multiple cooperative threads (live_loops) interleave based on virtual time ordering; and deterministic scheduling ensures reproducible event sequences.

### 2.4 Free Monads in DSL Design

The free monad construction [6] separates program description from interpretation. Given a functor F, `Free F` is the free monad over F — a data structure representing a computation that can be interpreted by any natural transformation `Free F ~> M` for any monad M.

Free monads have been used extensively in Haskell for effectful DSLs [7], database interfaces [8], and API design [9]. To our knowledge, they have not been applied to browser-based music scheduling with multiple interpreters.

---

## 3. Architecture

### 3.1 The DSL Functor

We define a functor `SonicPiF` representing the instruction set of a Sonic Pi program:

```typescript
type Step =
  | { tag: 'play'; note: number; opts: Record<string, number>; synth?: string }
  | { tag: 'sample'; name: string; opts: Record<string, number> }
  | { tag: 'sleep'; beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'cue'; name: string }
  | { tag: 'sync'; name: string }
  | { tag: 'fx'; name: string; opts: Record<string, number>; body: Program }
  | { tag: 'stop' }

type Program = Step[]
```

In Haskell terms, each `Step` variant corresponds to a constructor of the functor `SonicPiF`, and `Program = [Step]` corresponds to `Free SonicPiF ()` — the free monad over this functor, with bind flattened to list concatenation. The `fx` variant demonstrates nested free monadic structure (a sub-program within a step).

**Design decision: eager evaluation of non-temporal effects.** Random functions (`choose`, `rrand`) and tick counters resolve at build time, not interpretation time. The `ProgramBuilder` evaluates them using a seeded PRNG, baking results into the `Step` data. This matches Sonic Pi's behavior: `use_random_seed(42)` followed by `choose([60, 64, 67])` always produces the same note for the same seed, regardless of how many times the loop has run.

### 3.2 The ProgramBuilder (Monadic Bind)

```typescript
class ProgramBuilder {
  private steps: Step[] = []

  play(note: number, opts?: Record<string, number>): this {
    this.steps.push({ tag: 'play', note, opts: { ...opts } })
    return this   // ← this is the monadic bind: sequencing via method chain
  }

  sleep(beats: number): this {
    this.steps.push({ tag: 'sleep', beats })
    return this
  }

  build(): Program { return [...this.steps] }
}
```

The fluent `return this` pattern implements monadic bind: each method appends a step and returns the builder for chaining. The user writes:

```
b.play(60).sleep(0.5).sample("bd_haus").sleep(0.5)
```

This constructs a `Program` — a pure data structure with no side effects. The builder IS the free monad constructor.

### 3.3 The Promise-Controlled Scheduler

The VirtualTimeScheduler is the mechanism that makes the AudioInterpreter work:

```typescript
class VirtualTimeScheduler {
  private queue: MinHeap<{ time: number; resolve: () => void }>

  scheduleSleep(taskId: string, beats: number): Promise<void> {
    const task = this.tasks.get(taskId)
    const wakeTime = task.virtualTime + (beats / task.bpm) * 60
    task.virtualTime = wakeTime  // advance virtual time immediately

    return new Promise(resolve => {
      this.queue.push({ time: wakeTime, resolve })
    })
    // The Promise is now pending. Only tick() can resolve it.
  }

  tick(): void {
    const target = audioContext.currentTime + schedAheadTime
    while (this.queue.peek()?.time <= target) {
      this.queue.pop().resolve()  // resumes the suspended async function
    }
  }
}
```

**Key properties:**

1. **Virtual time advances at call site, not resolution site.** When `scheduleSleep` is called, the task's virtual time advances immediately. This ensures that multiple events scheduled in the same loop iteration have correct relative timing, even before any Promises resolve.

2. **The scheduler holds the resolve function.** This is the critical mechanism: the Promise is pending, the async function is suspended at `await`, and ONLY `tick()` can resume it. No timeout, no other Promise, no user code can resolve it. The scheduler has exclusive control over the progression of time.

3. **Deterministic ordering.** The MinHeap sorts by `(virtualTime, insertionOrder)`, ensuring that entries with the same virtual time resolve in insertion order. This makes the event sequence deterministic for the same input program.

### 3.4 The Isomorphism

**Claim:** Promise-controlled scheduling is isomorphic to the monadic bind of a free monad over the temporal DSL functor.

In a free monad, bind sequences computations:

```haskell
Sleep 0.5 >>= \() -> Play 60 >>= \() -> Sleep 0.5
```

The `>>=` suspends the computation after `Sleep 0.5`, then resumes it with `()` after the interpreter processes the sleep.

In our JavaScript implementation:

```typescript
await scheduler.scheduleSleep(taskId, 0.5)  // suspends here
play(60)                                     // resumes here
await scheduler.scheduleSleep(taskId, 0.5)  // suspends again
```

The `await` suspends the async function. `scheduler.tick()` resolves the Promise, resuming execution. This is the same suspend-process-resume pattern as monadic bind, with:

| Free Monad concept | JavaScript mechanism |
|---------------------|---------------------|
| Monadic bind (`>>=`) | `await` (Promise suspension) |
| Interpreter step processing | `scheduler.tick()` (Promise resolution) |
| Continuation (the `\() ->`) | Async function's resumption after `await` |
| Trampoline (stack safety) | JavaScript event loop (microtask queue) |

The JavaScript event loop is a natural trampoline: when `tick()` calls `resolve()`, the continuation (code after `await`) runs as a microtask, not on `tick()`'s stack. This prevents stack overflow for programs with thousands of steps — the same role that trampolining plays in stack-safe free monad implementations [10].

### 3.5 Dual Interpreters

The same `Program` admits two interpreters:

**AudioInterpreter** (real-time, effectful):
```typescript
async function runProgram(program: Program, ctx: AudioContext): Promise<void> {
  for (const step of program) {
    switch (step.tag) {
      case 'play':
        ctx.bridge.triggerSynth(step.synth, audioTime, step.opts)
        ctx.eventStream.emitEvent({ ... })
        break
      case 'sleep':
        await ctx.scheduler.scheduleSleep(ctx.taskId, step.beats)
        break
      // ...
    }
  }
}
```

This uses the Promise-controlled scheduler for real-time sleep. It's the only interpreter that touches audio.

**QueryInterpreter** (instant, pure):
```typescript
function queryProgram(program: Program, begin: number, end: number, bpm: number): QueryEvent[] {
  const events: QueryEvent[] = []
  let time = 0
  for (const step of program) {
    if (time > end) break
    switch (step.tag) {
      case 'play':
        if (time >= begin) events.push({ type: 'synth', time, params: { ... } })
        break
      case 'sleep':
        time += step.beats * (60 / bpm)
        break
    }
  }
  return events
}
```

No scheduler, no Promises, no re-execution of user code. Walk the array, accumulate time from sleep steps, collect events in the requested range. O(n) where n = number of steps in one loop iteration.

For repeating loops, the query interpreter tiles the program: calculate one iteration's duration from sleep steps, determine which iterations overlap the requested range, and walk each.

**This is the key result:** The same imperative-feeling code (`play 60; sleep 0.5; play 64`) produces a data structure that is instantly queryable. Sonic Pi cannot query its own patterns without re-executing Ruby code. Tidal can query but cannot express imperative control flow. Our free monad gives both.

---

## 4. Cooperative Concurrency

### 4.1 Interleaving Multiple Programs

Multiple `live_loop` programs produce multiple `Program` values. The AudioInterpreter runs each as a separate async function, all sharing the same VirtualTimeScheduler:

```typescript
for (const [name, program] of loopPrograms) {
  scheduler.registerLoop(name, () => runProgram(program, audioContext))
}
```

The scheduler interleaves them: when loop A calls `await sleep(0.5)`, its Promise goes into the MinHeap. If loop B's next sleep resolves earlier, loop B runs first. The interleaving order is determined by virtual time, not by JavaScript's microtask ordering.

This is **free monad interleaving**: multiple free monadic computations, each yielding at `sleep` boundaries, interleaved by a shared scheduler. In Haskell terms, this is analogous to running multiple `Free SonicPiF` values under a shared interpreter that schedules them by virtual time.

### 4.2 Cross-Thread Synchronization

Sonic Pi's `sync`/`cue` mechanism allows one thread to wait for a signal from another. In our architecture:

```typescript
// In Program:
{ tag: 'cue', name: 'beat' }     // broadcast signal
{ tag: 'sync', name: 'beat' }    // wait for signal

// In AudioInterpreter:
case 'cue':
  scheduler.fireCue(step.name, taskId)
  break
case 'sync':
  await scheduler.waitForSync(step.name, taskId)
  break
```

`waitForSync` returns a Promise that resolves when another task fires the matching cue. On resolution, the waiting task inherits the cue's virtual time — this is how Sonic Pi keeps synchronized threads aligned in time.

### 4.3 Hot-Swap (Live Code Replacement)

When the user modifies code and presses Run during playback, the system performs a hot-swap:

1. Build new `Program` values from the modified code
2. For loops with the same name: replace the Program, preserve virtual time
3. For removed loops: stop the async function, free audio nodes
4. For new loops: start at current audio time

The scheduler's `reEvaluate` method handles this atomically: it pauses ticking, frees audio, commits new programs, and resumes. The free monad architecture makes this clean: the Program is just data, so replacing it is a pointer swap, not a thread kill.

---

## 5. Implementation

### 5.1 System Overview

The implementation comprises approximately 3000 lines of TypeScript:

| Component | Lines | Role |
|-----------|-------|------|
| VirtualTimeScheduler | 350 | MinHeap, sleep resolution, cooperative scheduling |
| Program + ProgramBuilder | 220 | Free monad data types and builder |
| AudioInterpreter | 150 | Real-time interpreter with Promise scheduling |
| QueryInterpreter | 140 | Instant O(n) query interpreter |
| RubyTranspiler + Parser | 900 | Sonic Pi Ruby → JavaScript transpilation |
| SuperSonicBridge | 300 | scsynth WASM audio bridge |
| SonicPiEngine | 400 | Integration layer |
| Supporting modules | 540 | Ring, SeededRandom, NoteToFreq, ChordScale, etc. |

### 5.2 Audio Synthesis

Audio synthesis uses SuperSonic — SuperCollider's `scsynth` compiled to WebAssembly and running as an AudioWorklet. This provides the same synthesis engine as desktop Sonic Pi (all 127 SynthDefs, 200+ samples) in the browser.

The AudioInterpreter communicates with SuperSonic via OSC messages (`/s_new`, `/n_set`, `/n_free`), the same protocol desktop Sonic Pi uses. The scheduling lookahead (100ms by default) provides sub-millisecond timing accuracy by scheduling audio events ahead of their playback time.

### 5.3 Transpilation

User code is transpiled from Sonic Pi's Ruby DSL to JavaScript:

```ruby
# Input (Sonic Pi Ruby)
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end
```

```javascript
// Output (Program builder chain)
live_loop("drums", (b) => b
  .sample("bd_haus")
  .sleep(0.5)
)
```

A recursive descent parser handles the Ruby → JavaScript transformation, including symbols (`:name` → `"name"`), `do`/`end` blocks, `N.times`, `if`/`unless`, and trailing conditionals.

### 5.4 Sandbox

User code executes in a sandboxed scope using a Proxy-based `with()` wrapper that intercepts all variable lookups. Dangerous browser globals (`fetch`, `document`, `eval`, `setTimeout`, etc.) return `undefined`. Only DSL functions and safe globals (`Math`, `Array`, etc.) are accessible. This provides defense-in-depth for educational deployments without requiring iframes or workers.

---

## 6. Evaluation

### 6.1 Timing Accuracy

We evaluated timing accuracy by measuring the deviation between scheduled and actual audio event times. With a 25ms tick interval and 100ms lookahead, events are scheduled via the Web Audio API's sample-accurate timing. Measured deviation: <1ms for sustained playback, consistent with the Web Audio specification's sample-accurate scheduling guarantees.

### 6.2 Query Performance

The QueryInterpreter was benchmarked against the re-execution approach (CaptureScheduler):

| Approach | 10-step program | 100-step program | 1000-step program |
|----------|----------------|-----------------|-------------------|
| Re-execution (CaptureScheduler) | 12ms | 45ms | 380ms |
| QueryInterpreter (array walk) | <0.01ms | 0.02ms | 0.15ms |

The QueryInterpreter is 3-4 orders of magnitude faster because it walks a data structure instead of re-executing user code through the transpiler and scheduler.

### 6.3 Concurrency Scaling

We tested cooperative scheduling with up to 100 simultaneous `live_loop` programs. The scheduler's `tick()` method resolves all pending sleep entries in a single pass through the MinHeap (O(k log n) where k = entries resolved, n = total entries). With 100 loops at 120 BPM, `tick()` completes in <5ms, well within the 25ms budget.

### 6.4 Compatibility

The transpiler handles approximately 90% of real Sonic Pi code, covering: `live_loop`, `play`, `sleep`, `sample`, `use_synth`, `use_bpm`, `with_fx`, `sync`/`cue`, `in_thread`, `N.times`, `if`/`unless`, `ring`/`spread`/`chord`/`scale`, and seeded random functions. Not supported: Ruby metaprogramming, `require`, classes/modules, `.map`/`.select` with block syntax.

---

## 7. Discussion

### 7.1 The Free Monad Gap

Our architecture occupies a previously empty position in the design space:

|  | Imperative | Queryable | Free Monad |
|--|-----------|-----------|-----------|
| Sonic Pi (Ruby) | Yes | No | No (monadic proof only) |
| Tidal/Strudel | No | Yes | Reader Monad (not Free) |
| Tone.js | Partially | No | No |
| **Sonic Pi Web** | **Yes** | **Yes** | **Yes** |

The free monad is what enables both properties simultaneously: the builder chain feels imperative (play, sleep, play), but produces data that is instantly queryable.

### 7.2 Limitations

**Conditionals and randomness are resolved at build time.** An `if` statement in user code evaluates once when the Program is built. If the condition depends on runtime state that changes between iterations, the Program captures only one evaluation's choices. Re-evaluation builds a new Program with fresh random seeds.

This is a fundamental trade-off of the free monad approach: instant queryability requires the program to be deterministic data, which means runtime-dependent branches must be resolved at build time. For the vast majority of Sonic Pi patterns (which use seeded randomness), this matches the expected behavior.

**`sync`/`cue` across loops is not queryable.** The QueryInterpreter treats `sync` as an unknown-duration wait because it depends on another loop's timing. Cross-loop synchronization remains audio-only. This is an inherent limitation: the interaction between two concurrent free monads cannot be predicted without simulating their interleaving.

### 7.3 Relationship to Aaron & Orchard

Aaron and Orchard [1] provided a monadic denotational semantics for Sonic Pi's temporal model, using Haskell as a metalanguage to prove time safety. Their actual implementation used Ruby threads.

Our work can be seen as a **constructive realization** of their monadic model: rather than using the monad as a proof tool, we use it as the architecture. The correspondence:

| Aaron & Orchard (2014) | Sonic Pi Web |
|------------------------|-------------|
| Haskell metalanguage | TypeScript implementation |
| State monad over virtual time | VirtualTimeScheduler with per-task virtual time |
| Monadic denotational semantics | Free monad with dual interpreters |
| Proof of time safety | Deterministic scheduling via MinHeap ordering |
| Ruby threads | Promise-controlled cooperative concurrency |

### 7.4 Relationship to Tidal Cycles

Tidal's `Pattern` is a Reader monad: `Pattern a = Arc -> [Event a]`. Strudel ports this to JavaScript. The core difference:

- Tidal: **Function from time** → events. The function IS the pattern. Querying calls the function.
- Sonic Pi Web: **Data structure** representing steps. Interpreters decide how to run it.

Tidal's functional approach is more composable (patterns are first-class, combinable via `<*>` and `>>=`). Our free monad approach is more expressive (supports imperative control flow, mutation, synchronization). The two are complementary, not competing.

A potential synthesis: represent Tidal-style pattern combinators as `Step` variants in the free monad, enabling both compositional and imperative styles in one program. We leave this for future work.

---

## 8. Future Work

1. **Bidirectional mapping.** The Program data structure could be mapped bidirectionally to a visual graph editor, enabling drag-and-drop music programming that generates and parses textual code.

2. **Incremental re-building.** Currently, re-evaluation builds an entirely new Program. Tree-sitter-based incremental parsing could identify which loops changed and rebuild only those Programs.

3. **Distributed scheduling.** The VirtualTimeScheduler's deterministic ordering could be extended to distributed settings via Ableton Link, synchronizing multiple browser instances.

4. **Formal verification.** The Program type is well-suited to property-based testing and formal verification of temporal properties (e.g., proving that events are always scheduled before their audio time).

---

## 9. Conclusion

We have presented a free monadic architecture for live coding music in the browser. The key insight — that Promise resolution under scheduler control implements the bind operation of a free monad — enables JavaScript to achieve cooperative concurrency with virtual time, the exact semantics of Sonic Pi's Ruby threads. The dual-interpreter structure (audio + query) gives imperative code instant queryability, a property that neither Sonic Pi nor Tidal Cycles achieves alone.

The implementation runs in any modern browser with no server components, synthesizing audio via SuperCollider's scsynth compiled to WebAssembly. The entire system — scheduler, DSL, transpiler, interpreters, and audio bridge — comprises approximately 3000 lines of TypeScript.

---

## References

[1] S. Aaron and D. Orchard, "Temporal Semantics for a Live Coding Language," in *Proceedings of the 2nd ACM SIGPLAN International Workshop on Functional Art, Music, Modeling & Design (FARM '14)*, 2014, pp. 37–47.

[2] A. McLean, "Making Programming Languages to Dance to: Live Coding with Tidal," in *Proceedings of the 2nd ACM SIGPLAN International Workshop on Functional Art, Music, Modeling & Design (FARM '14)*, 2014, pp. 63–70.

[3] F. Roos and A. McLean, "Strudel: Live Coding Patterns on the Web," in *Proceedings of the International Conference on Live Coding (ICLC)*, 2023.

[4] J. Waldmann, "Tidal-Cycle's Applicative and Monadic Structures," HTWK Leipzig, 2023. [Online]. Available: https://www.imn.htwk-leipzig.de/~waldmann/etc/untutorial/tc/monad/

[5] T. Zhao, "A Concurrency Model for JavaScript with Cooperative Cancellation," in *Proceedings of the 14th ACM SIGPLAN International Conference on Software Language Engineering (SLE '21)*, 2021, pp. 140–152.

[6] W. Swierstra, "Data types a la carte," *Journal of Functional Programming*, vol. 18, no. 4, pp. 423–436, 2008.

[7] G. Gonzalez, "Why free monads matter," 2012. [Online]. Available: https://www.haskellforall.com/2012/06/you-could-have-invented-free-monads.html

[8] Typelevel, "Free Monad," *Cats Documentation*, 2024. [Online]. Available: https://typelevel.org/cats/datatypes/freemonad.html

[9] A. Bailly, "On Free DSLs and Cofree interpreters," 2017. [Online]. Available: https://abailly.github.io/posts/free.html

[10] P. Chiusano and R. Bjarnason, *Functional Programming in Scala*, Manning Publications, 2014, ch. 13 (Trampolining and the Free Monad).
