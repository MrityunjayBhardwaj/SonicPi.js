# Complete Gap Analysis: Desktop Sonic Pi vs Sonic Pi Web

Every layer, every boundary, every gap. End-to-end.

---

## Layer 0: User Code Entry

### Desktop Sonic Pi
```
GUI → /save-and-run-buffer OSC → Spider (Ruby runtime)
  → PreParser.preparse(code)     ← Ruby preprocessing (vec_fns, comment stripping)
  → Kernel.eval(code)            ← Ruby eval in sandboxed binding
```

### Sonic Pi Web
```
Editor → App.handleRun() → SonicPiEngine.evaluate(code)
  → treeSitterTranspile(code)    ← Tree-sitter partial fold (or regex fallback)
  → Sandbox.execute(js)          ← Proxy-based with() scope
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G0.1 | **No PreParser** | LOW | Ruby's PreParser handles `vec_fns` (vector function syntax). We don't need this — our transpiler handles it. |
| G0.2 | **Regex transpiler bugs** | MEDIUM | `define` stray `)` (#37), postfix `if` (#38), `line()`/`scale()` not transpiled (#39). Tree-sitter handles these — regex is fallback only. |
| G0.3 | **`##\|` comment syntax** | LOW | Sonic Pi's comment-out syntax not stripped. Minor. |

---

## Layer 1: DSL Dispatch (live_loop, with_fx, use_bpm, etc.)

### Desktop Sonic Pi
```
live_loop(:name, sync: :x) {
  1. define(:name_body) { block }           ← stores function by name
  2. in_thread(name: :name, sync: :x) {     ← creates named thread
       sync(:x)                              ← ONE-TIME before loop starts
       loop {
         __live_loop_cue(:name)              ← auto-cue at START of each iteration
         res = send(:name_body, res)         ← calls latest definition (hot-swap)
       }
     }
}

with_fx(:name, opts) {
  1. Allocate fx_container_group (scsynth group inside FX group)
  2. Allocate fx_synth_group inside container (for inner synths)
  3. Allocate private audio bus
  4. trigger_fx() → /s_new for FX synth (in_bus=new_bus, out_bus=parent_bus)
  5. Redirect thread-local out_bus to new_bus
  6. Execute block (inner synths write to new_bus)
  7. Restore out_bus
  8. GC thread: wait for subthreads + tracker + kill_delay → group.kill(true)
}

Re-evaluate (Run again):
  1. define(:name_body) replaces the function
  2. in_thread(name: :name) → NEW thread is KILLED (name exists)
  3. OLD thread survives, picks up new function on next send()
  4. Virtual time, tick counters, random state, BPM ALL persist
```

### Sonic Pi Web
```
live_loop("name", {sync: "x"}, fn) {
  1. wrappedLiveLoop stores builderFn
  2. Creates asyncFn closure
  3. Registers with scheduler (or hot-swaps via reEvaluate)
  4. sync: waits once via loopSynced set (persists across hot-swaps)
  5. Auto-cue at start of each iteration
}

with_fx — via fxAwareWrappedLiveLoop:
  1. topFxStack captures nested FX
  2. Builder wrapped with b.with_fx() for each stacked FX
  3. AudioInterpreter fx case:
     - Allocate bus + FX group
     - Create FX synth node
     - Redirect task.outBus
     - Run inner program
     - setTimeout(kill_delay) → freeGroup + freeBus
}

Re-evaluate:
  1. scheduler.reEvaluate() → existing.asyncFn = newFn
  2. loopSynced persists → no re-sync
  3. loopTicks persists → tick counters survive
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G1.1 | **No FX synth group inside container** | MEDIUM | Sonic Pi creates a `fx_synth_group` inside the container where inner synths are added. We add inner synths to group 100 (main synths group). This works because group 100 executes before group 101, but it means inner synths aren't scoped to the FX chain — they can't be killed atomically with the FX. |
| G1.2 | **FX cleanup is setTimeout, not tracker-based** | MEDIUM | Sonic Pi waits for all inner synths to finish (via SynthTracker), then waits kill_delay, then kills. We just setTimeout(kill_delay). If inner synths run longer than kill_delay, they get orphaned. |
| G1.3 | **Top-level `with_fx` creates new FX per loop iteration** | HIGH | Every loop iteration creates a new FX synth. Sonic Pi creates FX ONCE at the top level and routes ALL loop iterations through the same FX node. Our approach creates hundreds of FX nodes over time. Even with kill_delay cleanup, there's overlap. |
| G1.4 | **`in_thread` not fully implemented** | LOW | Sonic Pi's `in_thread` supports `delay:`, `sync:`, `sync_bpm:`. Our `thread` step is basic — spawns a one-shot loop. Missing delay and sync_bpm. |
| G1.5 | **`define` doesn't create a callable function** | MEDIUM | Sonic Pi's `define` creates a method on `@user_methods` that `send()` can call. Our transpiler converts `define` to a JS function declaration. This works for simple cases but doesn't support the `send(:name)` hot-swap pattern — hot-swap goes through asyncFn replacement instead. |
| G1.6 | **`density` not implemented for loops** | LOW | `density N do ... end` scales sleep times by 1/N inside the block. We pass through as identity function. |

---

## Layer 2: Sound Dispatch (play, sample, control)

### Desktop Sonic Pi (sound.rb — 4000+ lines)

```
play(note, opts):
  1. normalise_and_resolve_synth_args(args_h)
     → normalise_args!: resolve Symbol defaults (e.g., decay_level → :sustain_level)
     → validate_if_slider!: clamp values to valid ranges
  2. synthinfo.rb defaults: per-synth arg_defaults merged
  3. munge_opts(args_h): synth-specific aliasing
     → TB303: cutoff→cutoff_attack mirroring
  4. trigger_synth(synth_name, args_h)
     → add out_bus from thread-local
     → /s_new queued as DELAYED MESSAGE (not sent yet)

sample(name, opts):
  1. resolve_specific_sampler(args_h)
     → Simple opts → BasicStereoPlayer
     → Complex opts → StereoPlayer/MonoPlayer
  2. munge_opts(args_h): alias cutoff→lpf, cutoff_slide→lpf_slide
  3. Load sample buffer if not cached
  4. trigger_sampler(player_name, args_h)
     → add out_bus, buf number
     → /s_new queued as DELAYED MESSAGE

control(node, opts):
  1. normalise_and_resolve_synth_args
  2. /n_set queued as DELAYED MESSAGE

DELAYED MESSAGES:
  All play/sample/control calls between sleeps queue OSC messages.
  On sleep → __schedule_delayed_blocks_and_messages!:
    1. Collect all queued messages
    2. Compute dispatch time = virtual_time + sched_ahead_time
    3. Spawn thread: Kernel.sleep(dispatch_time - Time.now), then send all messages
    4. All messages in one dispatch share the same NTP timetag
```

### Sonic Pi Web

```
play(note, opts):
  1. ProgramBuilder._pushPlayStep() → creates Step data
  2. AudioInterpreter play case:
     → triggerSynth(synth, audioTime, {note, ...opts, out_bus})
  3. SuperSonicBridge.triggerSynth:
     → normalizeSynthParams (TB303 only)
     → queueMessage(audioTime, '/s_new', args)

sample(name, opts):
  1. ProgramBuilder._pushSampleStep() → creates Step data
  2. AudioInterpreter sample case:
     → playSample(name, audioTime, {opts, out_bus})
  3. SuperSonicBridge.playSample:
     → translateSampleOpts (beat_stretch, rpitch, cutoff→lpf)
     → Select basic_stereo_player or stereo_player
     → queueMessage(audioTime, '/s_new', args)

Message batching:
  → flushMessages() called on sleep/sync/end-of-program
  → All queued messages sent as ONE OSC bundle with single NTP timetag
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G2.1 | **No `normalise_args!` (Symbol resolution)** | MEDIUM | Sonic Pi resolves symbolic defaults: `decay_level: :sustain_level` means "use sustain_level's value". We don't resolve these. Most synthdefs have numeric defaults, but some rely on cross-parameter references. |
| G2.2 | **No `validate_if_slider!` (range clamping)** | LOW | Sonic Pi clamps parameter values to valid ranges (e.g., cutoff 0-130 MIDI). We pass raw values. Out-of-range values may cause scsynth weirdness. |
| G2.3 | **`normalizeSynthParams` only handles TB303** | HIGH | Sonic Pi's `munge_opts` is per-synth. TB303 is the only one we normalize. Other synths with parameter mirroring or aliasing are missed. Need to check: which other synths have `munge_opts`? |
| G2.4 | **No `pre_amp` parameter sent** | MEDIUM | Sonic Pi's `MonoPlayer`/`StereoPlayer` have `pre_amp: 1` in defaults. We don't send `pre_amp`. The synthdef default may differ. |
| G2.5 | **Sample `rate` not sent by default** | LOW | Sonic Pi sends `rate: 1` explicitly. We rely on synthdef default. Should be fine but worth verifying. |
| G2.6 | **`env_curve` not sent** | LOW | Sonic Pi sends `env_curve: 2` for synths with envelopes. We rely on synthdef default. |
| G2.7 | **Slide parameters ignored** | LOW | `note_slide`, `amp_slide`, `cutoff_slide` etc. are DSL features that control parameter glide. We pass them through but don't set up the slide timing. |

---

## Layer 3: scsynth Node Tree & Bus Routing

### Desktop Sonic Pi (studio.rb)

```
Root Group (0):
  STUDIO-SYNTHS (before FX)
    Run-{jobId}-Synths (per-run)
      [synth nodes, each with out_bus]
  STUDIO-FX (before MIXER)
    Run-{jobId}-FX (per-run)
      FX-container (per with_fx)
        FX-synths group (head) ← inner synths added HERE
        FX synth node (tail) ← in_bus=private, out_bus=parent
  STUDIO-MIXER (head of root)
    sonic-pi-mixer (head) ← pre_amp→HPF→LPF→Limiter.ar(0.99,0.01)→LeakDC→amp→clip→ReplaceOut
  STUDIO-MONITOR (after mixer)
    sonic-pi-scope, sonic-pi-amp_stereo_monitor, sonic-pi-recorder

Bus allocation:
  0-1: hardware output (stereo)
  2-3: hardware input (stereo)
  4+:  private buses (allocated in stereo pairs)
  First private bus = mixer_bus (for mixer's in_bus)
```

### Sonic Pi Web

```
Root Group (0):
  Group 100 (synths, before FX) ← matches STUDIO-SYNTHS
    [synth nodes, all play/sample go here regardless of FX context]
  Group 101 (FX, before mixer) ← matches STUDIO-FX
    [FX container groups + FX synth nodes]
  Mixer Group (head of root) ← matches STUDIO-MIXER
    sonic-pi-mixer (in_bus=private, amp=6, pre_amp=0.2)

Bus allocation:
  0-1: hardware output
  2-13: track output channels (NUM_OUTPUT_CHANNELS=14)
  14+: private buses (allocateBus starts here)
  mixer_bus = first allocateBus() call
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G3.1 | **Inner synths not in FX group** | MEDIUM | Sonic Pi adds inner synths to the FX container's synth group. We add all synths to group 100. Execution order still works (100 before 101), but inner synths can't be atomically killed with the FX group. |
| G3.2 | **No per-run groups** | LOW | Sonic Pi creates per-run synth and FX groups (`Run-{jobId}-Synths`). On stop, it kills the run's group. We use `freeAllNodes()` which kills everything in groups 100 and 101. Same effect for single-run, but multi-job doesn't scope correctly. |
| G3.3 | **No MONITOR group** | LOW | Sonic Pi has a monitor group with scope, amp monitor, and recorder synths. We handle scope via Web Audio AnalyserNode and recording via MediaRecorder. Different mechanism, same result. |
| G3.4 | **Bus allocation starts at 14, not 4** | LOW | Sonic Pi starts private buses at 4 (after hardware I/O). We start at 14 (after track output channels). This wastes bus numbers but doesn't affect sound — scsynth has 1024+ buses. |
| G3.5 | **Top-level FX creates new nodes per iteration** | HIGH | Same as G1.3. Desktop Sonic Pi's top-level `with_fx` creates the FX node ONCE and routes all loop audio through it permanently. Our `fxAwareWrappedLiveLoop` adds a `b.with_fx()` step to the builder, which creates a new FX node every loop iteration. Over 1 minute at 130 BPM with the hhc1 loop (0.125 beat sleep), this creates ~520 FX nodes per minute. Even with kill_delay cleanup, there are ~2 FX nodes alive at any time per loop per FX layer. |

---

## Layer 4: OSC Bundle Construction & Dispatch

### Desktop Sonic Pi

```
play/sample → delayed_message queue (thread-local)
sleep → __schedule_delayed_blocks_and_messages!:
  1. Collect ALL delayed messages
  2. dispatch_time = virtual_time + sched_ahead_time
  3. Thread.new {
       Kernel.sleep(dispatch_time - Time.now)    ← real-time wait
       send_bundle(dispatch_time, messages)       ← single OSC bundle
     }
  4. NTP timetag = dispatch_time + NTP_EPOCH_OFFSET
  5. Bundle format: #bundle\0 + NTP(8) + [size(4) + message]...
```

### Sonic Pi Web

```
play/sample → queueMessage(audioTime, address, args)
sleep → bridge.flushMessages():
  1. Collect all queued messages
  2. NTP = audioTimeToNTP(audioTime, audioCtx.currentTime)
  3. If 1 message: encodeSingleBundle(ntp, addr, args)
     If N messages: encodeBundle(ntp, messages)
  4. sonic.sendOSC(bundle)
  5. SuperSonic classifies bundle:
     - nearFuture (<500ms): direct to worklet
     - farFuture (>500ms): prescheduler min-heap
     - immediate/late: direct to worklet
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G4.1 | **No real-time dispatch thread** | LOW | Sonic Pi spawns a Thread that sleeps until dispatch_time, then sends. We send immediately with an NTP timetag and let SuperSonic's prescheduler handle the timing. This is actually equivalent — SuperSonic's prescheduler does the same job as Sonic Pi's dispatch thread. |
| G4.2 | **sched_ahead_time = 0.1s vs 0.5s** | MEDIUM | Sonic Pi defaults to 0.5s lookahead. We use 0.1s. Smaller lookahead = less time for scsynth to prepare = more likely to miss deadlines under CPU load. Should increase to 0.3-0.5s. |
| G4.3 | **No flush on cue** | LOW | Sonic Pi flushes delayed messages on `cue` as well as `sleep`. We flush on sleep and sync but not cue. Cue-before-sleep patterns might delay messages. |

---

## Layer 5: Mixer & Master Output

### Desktop Sonic Pi

```
sonic-pi-mixer synthdef:
  in(out_bus) + in(mixer_bus) → sum
  → pre_amp (varlag, default 1, set to vol*0.2 by set_volume!)
  → HPF (default 22 MIDI ≈ 29Hz, bypassable)
  → LPF (default 135.5 MIDI ≈ 19912Hz, bypassable)
  → force_mono (optional)
  → invert_stereo (optional)
  → Limiter.ar(signal, 0.99, 0.01)  ← hard ceiling, 10ms lookahead
  → LeakDC.ar(signal)
  → amp (default 6, set at trigger time)
  → clip2(signal, 1)
  → HPF 10Hz + LPF 20500Hz (safety filters)
  → ReplaceOut.ar(out_bus)

Effective gain at default volume: pre_amp(0.2) × amp(6) = 1.2x
Limiter at 0.99 prevents clipping before amp stage.
After amp, clip2 catches anything above 1.0.
```

### Sonic Pi Web

```
sonic-pi-mixer synthdef (same!):
  in(out_bus=0) + in(mixer_bus=private) → sum
  → pre_amp=0.2, amp=6 (same as Sonic Pi)
  → Limiter.ar(0.99, 0.01) (same)
  → ReplaceOut.ar(0)
Then: Web Audio chain:
  → ChannelSplitter → ChannelMerger → AnalyserNode → GainNode(1.0) → speakers
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G5.1 | **Mixer `set_volume!` not wired to UI slider** | MEDIUM | Sonic Pi's volume slider calls `set_volume!(vol)` which sets `pre_amp = vol * 0.2`. Our `setMasterVolume` sends `/n_set` on the mixer node AND sets Web Audio gain. Needs testing to confirm the `/n_set` actually reaches the mixer node. |
| G5.2 | **Web Audio GainNode after mixer is redundant** | LOW | The mixer already controls volume via pre_amp/amp. The Web Audio GainNode at 1.0 is a passthrough. Could be used for the UI slider, but then it doubles with the mixer's pre_amp control. Should pick one. |
| G5.3 | **No HPF/LPF bypass control** | LOW | Sonic Pi exposes `set_mixer_control! hpf_bypass: 1` etc. We don't expose mixer parameter control. |

---

## Layer 6: Synth Lifecycle & Envelope

### Desktop Sonic Pi

```
Synths use NON-GATED envelopes (release_node = -99):
  attack → decay → sustain → release → doneAction:FREE
  Total duration = attack + decay + sustain + release (known at trigger time)
  Synth self-frees when envelope completes.

FX synths:
  Gated (stay alive until gate=0 or killed).
  FX container killed by GC thread after kill_delay.

control(node, opts):
  /n_set sent as delayed message with same timetag as surrounding play calls.
```

### Sonic Pi Web

```
Same synthdefs → same envelope behavior.
Synths self-free via doneAction:FREE.
FX nodes killed by setTimeout(kill_delay) → freeGroup.
control: sendTimedControl queues /n_set message.
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G6.1 | **No SynthTracker for FX cleanup** | MEDIUM | Sonic Pi tracks which synths are alive inside an FX block. The GC thread waits for ALL inner synths to finish before starting kill_delay. We just start kill_delay immediately. If a long-sustain synth (e.g., `sustain: 8`) outlives kill_delay, the FX group dies while the synth is still producing audio. |
| G6.2 | **No `kill_delay` from synthinfo** | LOW | Sonic Pi's `kill_delay` comes from the FX's synthinfo (`info.kill_delay(args_h)`), which can vary per FX type. We default to 1.0s for all FX. Reverb might need more, distortion might need less. |

---

## Layer 7: Time-State System (set/get/sync/cue)

### Desktop Sonic Pi

```
CueEvent: {time, priority, thread_id, delta, beat, bpm, path, val}
Ordering: time → priority → thread_id → delta (total order)

EventHistory: trie-based, sorted event lists, auto-trimmed (>32s removed)

get(:name):
  1. Check thread-local cache (same-tick reads)
  2. EventHistory.find_most_recent_event(position) ← at or before current time
  Returns existing value without blocking.

sync(:name):
  1. Check EventHistory for event STRICTLY AFTER current position
  2. If found → return immediately, teleport vt to cue's time
  3. If not → register Promise + EventMatcher, BLOCK
  4. On cue: EventMatcher checks ce > matcher.ce, delivers Promise
  5. After wakeup: re-check history (race protection)
  Thread's virtual time teleports to cue's virtual time.

live_loop cues use priority -100 (lower than normal).
delta is per-thread sub-tick counter for same-time ordering.
```

### Sonic Pi Web

```
cueMap: Map<string, {time, args}>  ← stores latest cue per name
syncWaiters: Map<string, Promise[]>  ← tasks waiting for cue

waitForSync(name, taskId):
  Always parks and waits for fresh fireCue().
  Does NOT check cueMap (stale cues ignored).
  On fireCue: inherits cuer's virtual time.

fireCue(name, taskId):
  Stores in cueMap.
  Wakes all syncWaiters for that name.
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G7.1 | **No multi-dimensional event ordering** | MEDIUM | Sonic Pi orders events by (time, priority, thread_id, delta). We just use time. Two cues at the same virtual time are unordered in our system. For most code this doesn't matter, but concurrent loops cueing the same name could see non-deterministic ordering. |
| G7.2 | **No event history** | MEDIUM | Sonic Pi keeps a trie of all events for 32 seconds. `get(:name)` looks up the most recent value. We have `cueMap` with only the latest value per name. `get` semantics are approximately correct but miss the time-aware lookup. |
| G7.3 | **No `get` function** | MEDIUM | Sonic Pi's `get(:name)` returns the current value without blocking (like a read from a concurrent map). We have `cue` and `sync` but no `get`. Code using `get` to read shared state between loops won't work. |
| G7.4 | **No `set` function** | MEDIUM | Sonic Pi's `set(:name, val)` stores a value in the time-state system. `get(:name)` retrieves it. This is used for inter-loop communication without blocking. We don't implement `set`/`get`. |
| G7.5 | **No delta sub-tick counter** | LOW | Sonic Pi's `delta` disambiguates multiple events at the same virtual time. We don't have this — same-time events are unordered. Rarely matters in practice. |
| G7.6 | **No `sync_bpm`** | LOW | `sync_bpm :name` waits for a cue AND inherits the cuer's BPM. We only inherit virtual time, not BPM. |
| G7.7 | **live_loop cue priority not -100** | LOW | Sonic Pi uses priority -100 for live_loop auto-cues so they don't interfere with user cues. Our auto-cues have no priority distinction. |

---

## Layer 8: Random Number System

### Desktop Sonic Pi

```
441,000 pre-generated floats from WAV files (5 distributions: white, pink, light_pink, dark_pink, perlin)
Per-thread state: {seed, idx}
rand!(max) = random_numbers[(seed + idx + 1) % 441000] * max; idx++
use_random_seed(s) → seed=s, idx=0
Child thread: new_seed = parent.rand!(441000, threadSpawnCount) + parent.seed
rand_back(n) → decrements idx by n
rand_reset → idx=0
with_random_seed → scoped save/restore
```

### Sonic Pi Web

```
SeededRandom class with PRNG (mulberry32 or similar)
Per-loop seed derived from loop name hash
use_random_seed resets PRNG state
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G8.1 | **Different random distribution** | LOW | Our PRNG produces uniform distribution. Sonic Pi's WAV-based system has white (uniform), pink, perlin distributions. For `rand()` (white), results are equivalent. For `choose()`/`shuffle()`, the exact sequence differs but is still random. Doesn't affect musicality. |
| G8.2 | **No `rand_back`/`rand_reset`** | LOW | Not commonly used. Easy to add. |
| G8.3 | **No `with_random_seed` scoped reset** | LOW | We have `use_random_seed` but not the scoped version. |
| G8.4 | **No distribution selection** | LOW | `use_random_source :pink` etc. not implemented. Rarely used. |

---

## Layer 9: Timing & Error Detection

### Desktop Sonic Pi

```
After each loop iteration:
  slept = thread_local :sonic_pi_spider_slept
  synced = thread_local :sonic_pi_spider_synced
  raise ZeroTimeLoopError unless slept or synced

Timing exception:
  If virtual_time falls too far behind wall_clock → thread killed
  "Timing Exception: thread got too far behind time"
```

### Sonic Pi Web

```
BudgetGuard: max iterations per tick cap
InfiniteLoopError on exceeding cap
```

### Gaps
| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| G9.1 | **No "did you sleep?" check** | LOW | Sonic Pi checks per-iteration. We use a global iteration cap. Similar protection, different mechanism. |
| G9.2 | **No "too far behind" timing exception** | LOW | If computation takes too long, Sonic Pi kills the thread. We don't detect this — the loop just falls behind silently. Events play late. |

---

## Summary: All Gaps by Severity

### HIGH (directly causes wrong audio output)
| # | Gap | Root Cause |
|---|-----|-----------|
| G1.3/G3.5 | **Top-level FX creates new nodes per iteration** | Missing: persistent top-level FX node (create once, route all iterations through it) |
| G2.3 | **normalizeSynthParams only handles TB303** | Missing: per-synth munge_opts for all synths with parameter aliasing |

### MEDIUM (causes subtle differences or missing features)
| # | Gap | Root Cause |
|---|-----|-----------|
| G1.1 | Inner synths not in FX group | Missing: FX container scoping for synth nodes |
| G1.2 | FX cleanup is setTimeout, not tracker-based | Missing: SynthTracker equivalent |
| G1.5 | define doesn't create callable function | Different hot-swap mechanism (works but different) |
| G2.1 | No Symbol resolution in args | Missing: normalise_args! equivalent |
| G2.4 | No pre_amp parameter sent | Missing: default param injection |
| G3.1 | Inner synths not in FX group | Same as G1.1 |
| G4.2 | sched_ahead_time 0.1s vs 0.5s | Config difference — easy fix |
| G5.1 | Mixer volume not wired to UI | Integration gap |
| G6.1 | No SynthTracker for FX cleanup | Missing: synth lifetime tracking |
| G7.1-G7.4 | Time-state system incomplete | Missing: event history, get/set, multi-dim ordering |

### LOW (minor differences, rarely affect user experience)
G0.2, G0.3, G1.4, G1.6, G2.2, G2.5, G2.6, G2.7, G3.2, G3.3, G3.4, G4.1, G4.3, G5.2, G5.3, G6.2, G7.5-G7.7, G8.1-G8.4, G9.1, G9.2

---

## The Missing Layer: SoundLayer

The cluster analysis shows 13/23 bugs originated in `SuperSonicBridge.ts` (8) and `AudioInterpreter.ts` (5). These files do the work of Sonic Pi's `sound.rb` (4000+ lines) in ~200 lines combined.

Desktop Sonic Pi has a clear separation:
```
User DSL → sound.rb (param normalize, synthdef select, bus manage, FX lifecycle, message batch) → server.rb (OSC encode, dispatch) → scsynth
```

We have:
```
User DSL → AudioInterpreter (step walker) → SuperSonicBridge (thin OSC wrapper) → scsynth
```

The missing `SoundLayer` would handle:
1. **Parameter normalization** — per-synth munge_opts, Symbol resolution, range clamping
2. **Synthdef selection** — basic_stereo_player vs stereo_player vs mono_player
3. **Bus management** — out_bus injection, FX bus allocation, mixer bus
4. **FX lifecycle** — container groups, synth tracking, kill_delay from synthinfo
5. **Message batching** — queue during computation, flush on sleep (already partially done)
6. **Top-level FX persistence** — create FX node once, route all iterations through it

---

## ADDENDUM: Deep Research Findings (Round 2)

### NEW HIGH SEVERITY GAPS

#### G_NEW.1: BPM scales ALL time parameters — WE DON'T
Desktop Sonic Pi's `scale_time_args_to_bpm!` multiplies ALL time-based args by `60/BPM`:
- attack, decay, sustain, release
- ALL slide times (amp_slide, cutoff_slide, etc.)

At `use_bpm 130`, `release: 1` becomes `release: 1 * (60/130) = 0.4615` seconds.

**We pass raw beat values to scsynth which interprets them as seconds.**
This means at BPM 130, our release is 1.0 seconds, theirs is 0.46 seconds.
Every envelope is 2.17x longer than it should be at 130 BPM.

This is likely the **biggest remaining audio discrepancy** — every note rings for over 2x too long,
causing overlaps, smeared sound, and higher sustained RMS.

#### G_NEW.2: Top-level FX persists forever (confirmed mechanism)
The GC thread's cleanup is blocked by `subthread.join()` on the live_loop thread,
which runs forever. The FX node lives until the job is killed.

We recreate the FX node every loop iteration via `fxAwareWrappedLiveLoop`.
This creates hundreds of FX nodes per minute, each with a kill_delay timeout.

The fix: for top-level `with_fx` wrapping `live_loop`, create the FX node ONCE
at registration time and pass the bus/group to the loop thread.

#### G_NEW.3: Inner synths placed in FX group, not main synths group
`current_group` thread-local is set to `fx_synth_group` inside `with_fx`.
ALL play/sample calls inside the block are added to the FX's synth group.

We add all synths to group 100 regardless of FX context. This means:
- Synths can't be atomically killed with the FX group
- Execution order within the FX chain isn't guaranteed (works by accident because 100 < 101)

#### G_NEW.4: `decay_level: :sustain_level` resolution for 37 synths
Every synth with ADSR has `decay_level: :sustain_level` in arg_defaults.
This means if user sets `sustain_level: 0.5` but not `decay_level`,
`decay_level` resolves to 0.5. We don't resolve Symbol references at all.

Affected: beep, saw, pulse, square, tri, dsaw, fm, prophet, tb303, supersaw,
hoover, zawa, dark_ambience, growl, hollow, tech_saws, rhodey, and 20+ more.

### NEW MEDIUM SEVERITY GAPS

#### G_NEW.5: Note transposition chain missing
Every note should go through: note() → +transpose → +octave*12 → +cents/100 → +pitch → tuning.
We only do note() conversion. `use_transpose`, `use_octave`, `use_cent_tuning` are not applied.

#### G_NEW.6: `cutoff→lpf` aliasing for sc808_snare and sc808_clap
These drum synths also need the alias. We only handle it for sample players.

#### G_NEW.7: Per-FX kill_delay values
| FX | kill_delay |
|----|-----------|
| reverb | min(room*10 + 1, 11) seconds |
| echo | decay value |
| chorus | decay value |
| ping_pong | log(0.01)/log(feedback) * phase |
| gverb | release value |
| record/sound_out | 0 |
| everything else | 1 second |

We use 1s for all FX.

#### G_NEW.8: `on:` parameter not stripped
Sonic Pi deletes `on:` from args before sending to scsynth (`should_trigger?` mutates args_h).
We pass it through — unrecognized by scsynth.

#### G_NEW.9: Sample thread-local defaults separate from synth defaults
Sonic Pi has TWO default systems:
- `use_synth_defaults` → `:sonic_pi_mod_sound_synth_defaults` → merged into `play`
- `use_sample_defaults` → `:sonic_pi_mod_sound_sample_defaults` → merged into `sample`

We use a single `_synthDefaults` in ProgramBuilder for both.

#### G_NEW.10: `slide:` propagation
If user passes `slide: 0.5`, Sonic Pi copies it to every `*_slide` param the synth supports.
We don't propagate the global `slide:` to individual slide params.

#### G_NEW.11: `calculate_sustain!` from `duration:`
If user passes `duration: 2`, Sonic Pi computes `sustain = duration - attack - decay - release`.
We don't support the `duration:` parameter.

#### G_NEW.12: `rand_buf` injection for specific synths
WinwoodLead, Rhodey, Gabberkick, FXSlicer, FXWobble, FXPanSlicer need `rand_buf` parameter.
Without it, their internal noise generators may not produce correct output.

### COMPLETE PRIORITY RANKING (all gaps)

| Priority | Gap | Impact |
|----------|-----|--------|
| **P0** | G_NEW.1: BPM doesn't scale time params | Every envelope 2x+ too long at non-60 BPM |
| **P0** | G_NEW.2: Top-level FX recreated per iteration | Hundreds of zombie FX nodes |
| **P0** | G_NEW.4: No Symbol resolution (decay_level etc.) | Wrong envelope shape for 37 synths |
| **P1** | G_NEW.3: Inner synths not in FX group | Can't atomically kill, wrong scope |
| **P1** | G_NEW.5: No note transposition | use_transpose/use_octave broken |
| **P1** | G_NEW.7: Per-FX kill_delay | Reverb tails cut short or too long |
| **P1** | G2.3: normalizeSynthParams only TB303 | Parameter aliasing for other synths |
| **P1** | G_NEW.6: sc808 cutoff→lpf | 808 drum filter broken |
| **P2** | G_NEW.8: on: param not stripped | Unrecognized param sent to scsynth |
| **P2** | G_NEW.9: Sample defaults separate | use_sample_defaults doesn't work |
| **P2** | G_NEW.10: slide: propagation | Global slide doesn't apply to individual params |
| **P2** | G_NEW.11: duration: → sustain calc | duration: parameter doesn't work |
| **P2** | G_NEW.12: rand_buf injection | Specific synths may produce wrong noise |
| **P2** | G4.2: sched_ahead_time 0.1 vs 0.5 | May miss deadlines under load |
