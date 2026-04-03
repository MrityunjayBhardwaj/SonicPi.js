# Lifecycle Patterns — Sonic Pi Web

> Every lifecycle references the Ground Truth interpretation layer.
> Internal: `artifacts/ref/GROUND_TRUTH_SONIC_PI_WEB.md` — our engine pipeline
> External: `artifacts/ref/GROUND_TRUTH_{SUPERSONIC,DESKTOP_SP,SONIC_TAU}.md`
> Source code: `artifacts/ref/sources/{supersonic,desktop-sp,sonic-tau}/`
> Chain: catalogue entry → REF → Ground Truth doc#stage → REF → source file:line

## SK1: SonicPiEngine Full Lifecycle
1. `init()` — create SuperSonic, AudioContext, AnalyserNode, VirtualTimeScheduler — ASYNC
2. `evaluate(code)` — transpile, create DSL context, execute code (registers live_loops), parse @viz comments — ASYNC
3. `play()` — scheduler.start() begins tick() timer — SYNC
4. Scheduler tick() fires every 25ms — resolves sleep Promises up to audioTime + schedAheadTime — SYNC
5. Async functions resume at await points — trigger synths via SuperSonic OSC — SYNC per resolution
6. `stop()` — scheduler.stop(), free all synth nodes — SYNC
7. `dispose()` — stop + destroy SuperSonic + clear HapStream — SYNC
**REF:** `SonicPiEngine.ts:108` init(); `SonicPiEngine.ts:169` evaluate guard; `SonicPiEngine.ts:685` scheduler.dispose(); `SonicPiEngine.ts:698-703` dispose() method

## SK2: VirtualTimeScheduler Tick Cycle
1. setInterval fires (~25ms) — ASYNC (macrotask)
2. Read audioContext.currentTime — SYNC
3. Compute targetTime = audioTime + schedAheadTime — SYNC
4. While queue.peek().time <= targetTime: pop and resolve — SYNC
5. Each resolve() triggers microtask: async function resumes — MICROTASK
6. Resumed function calls play() → queues OSC message to bridge — SYNC
7. Resumed function calls sleep() → flushMessages() → new Promise pushed to queue — SYNC
8. Function suspends at next await — MICROTASK completes

**Common violation:** Resolving Promises outside tick() (breaks SV2).
**REF:** `VirtualTimeScheduler.ts:85-99` constructor + schedAheadTime; `VirtualTimeScheduler.ts:235-247` sleep() → Promise; `VirtualTimeScheduler.ts:323-331` tick() resolves entries; `VirtualTimeScheduler.ts:347` setInterval fires tick

## SK3: live_loop Registration and Execution
1. evaluate() executes code — SYNC within eval scope
2. `live_loop("name", {sync: "x"}, fn)` registers task with scheduler — SYNC
3. scheduler.start() begins tick timer — SYNC
4. First tick: task's virtualTime=0 is <= targetTime → resolve initial sleep(0) — SYNC
5. Auto-cue fires at start of each iteration — SYNC
6. If sync target: waitForSync parks until fresh cue fires — ASYNC
7. fn() begins executing (builds Program via ProgramBuilder) — SYNC
8. AudioInterpreter walks Program steps, queuing OSC messages — ASYNC
9. On sleep: flushMessages() dispatches ALL queued OSC as one bundle — SYNC
10. Hot-swap: replace asyncFn reference, loopSynced persists, next iteration uses new fn — SYNC

**Common violation:** Starting fn() before scheduler.start() (no tick to resolve sleeps).
**REF:** `VirtualTimeScheduler.ts:139-164` registerLoop: creates task, starts async chain at sleep(0); `VirtualTimeScheduler.ts:277-293` cue/sync; `VirtualTimeScheduler.ts:147-148` hot-swap; `SonicPiEngine.ts:429-443` fxAwareWrappedLiveLoop registration

## SK4: Audio Message Pipeline (Sonic Pi's 3-layer model)
**REF:** `SoundLayer.ts:191` pipeline order; `AudioInterpreter.ts:4` interpreter; `SuperSonicBridge.ts:367-401` queueMessage + flushMessages; `osc.ts` OSC encoding

1. DSL play()/sample() called at virtual time T — SYNC
2. ProgramBuilder creates Step data — SYNC
3. AudioInterpreter processes step:
   a. Compute audioTime = T + schedAheadTime — SYNC
   b. **SoundLayer:** normalizePlayParams/normalizeSampleParams/normalizeControlParams/normalizeFxParams — resolve symbols, inject defaults, alias, munge, BPM scale (ALL four functions scale time params by 60/BPM, including FX phase/decay/max_phase)
   c. Queue OSC message via bridge.queueMessage(audioTime, '/s_new', args) — SYNC
4. On sleep/sync/end: bridge.flushMessages() — SYNC
   a. Encode ALL queued messages as ONE OSC bundle with single NTP timetag
   b. sonic.sendOSC(bundle) → SuperSonic
5. SuperSonic classifies bundle:
   a. nearFuture (<500ms): direct to AudioWorklet via SAB/postMessage
   b. farFuture (>500ms): Prescheduler min-heap, dispatched 500ms early
6. AudioWorklet's scsynth WASM: sample-accurate execution from NTP timetag — AUDIO THREAD
7. scsynth output → sonic-pi-mixer (Limiter.ar + LeakDC + gain) → ReplaceOut bus 0
8. Web Audio: splitter → merger → analyser → gain → speakers

**Common violation:** Sending messages immediately instead of batching (breaks SV9).
**Common violation:** Reading event log as proof of audio output (breaks SV8/Lokayata).

## SK5: FX Lifecycle (FIXED — two paths)

**Path A: Top-level FX (wrapping live_loop) — PERSISTENT**
1. SonicPiEngine.topLevelWithFx captures FX chain + assigns scope ID — SYNC
2. fxAwareWrappedLiveLoop stores scope ID in loopFxScope, chain in fxScopeChains — SYNC
3. First iteration: asyncFn checks !persistentFx.has(scopeId) — creates FX nodes ONCE
4. allocateBus + createFxGroup + applyFx for each FX in chain — ASYNC
5. Stores {buses, groups, outBus} in persistentFx keyed by scope ID
6. All subsequent iterations: task.outBus = persistentFx.get(scopeId).outBus — SYNC
7. Multiple loops under same with_fx share one scope (one set of FX nodes)
8. Cleared on stop() and re-evaluate (freeAllNodes kills group 101)

**Path B: Inner FX (b.with_fx inside loop body) — PER-ITERATION**
1. AudioInterpreter encounters 'fx' step — SYNC
2. Allocate private audio bus — SYNC
3. Create FX container group inside group 101 — SYNC
4. Create FX synth (in_bus=private, out_bus=parent) — queued message
5. Set task.outBus = private bus, run inner program — ASYNC
6. Restore outBus — SYNC
7. setTimeout(kill_delay) → freeGroup + freeBus — ASYNC

**This matches desktop:** top-level FX persists (GC blocked by subthread.join), inner FX is per-block.
**REF:** `SonicPiEngine.ts:73,305-332` persistentFx (Path A); `AudioInterpreter.ts` fx step handling (Path B); `SuperSonicBridge.ts:630-657` createFxGroup + FX synth creation

## SK6: FX Lifecycle (Desktop Sonic Pi — target)
1. with_fx allocates bus, creates container group + synth group inside — SYNC
2. Creates FX synth at TAIL of container (with t_minus_delta timing) — SYNC
3. Sets thread-local out_bus and job_group to FX's bus/group — SYNC
4. Spawns GC thread — ASYNC
5. Executes block (may contain live_loop which spawns its own thread) — SYNC/ASYNC
6. Block returns, delivers subthreads to GC — SYNC
7. GC thread waits: subthread.join → tracker.block_until_finished → sleep(kill_delay) → group.kill — ASYNC
8. For live_loop wrapping: subthread.join blocks FOREVER → FX persists until Stop
**REF:** Reference target — describes Desktop SP behavior (not our code). Consult `GROUND_TRUTH_DESKTOP_SP.md#stage-8` when verifying parity.

## SK7: Capture Mode (Fast-Forward for queryArc)
1. Create fresh scheduler in capture mode — SYNC
2. Register loops from evaluate — SYNC
3. Run scheduler.runUntilCapture(endTime) — ASYNC
4. For each queue entry <= endTime: resolve immediately (no real-time wait) — SYNC
5. Each resolve triggers play() which captures event instead of triggering audio — SYNC
6. Continue until all tasks have virtualTime > endTime or max iterations hit — LOOP
7. Return collected events — SYNC

**Common violation:** Infinite loop if live_loop body has no sleep (SP6 error pattern).
**REF:** `QueryInterpreter.ts:2` QueryInterpreter description; `QueryInterpreter.ts:167` zero-sleep guard; `ProgramBuilder.ts:18-24` budget system for capture mode

## SK8: scsynth Node Tree (Current)
```
Root Group (0):
  Group 100 (synths, before FX)          ← ALL synths go here (even inside with_fx)
  Group 101 (FX, before mixer)           ← FX container groups + FX synth nodes
  Mixer Group (head of root)             ← sonic-pi-mixer node
```
Execution order: 100 → 101 → mixer. Correct for signal flow.

**Gap:** Inner synths should go in the FX container's synth group (like desktop), not group 100.
**REF:** `SuperSonicBridge.ts:265-269` group creation (mixer→101→100 order); `SuperSonicBridge.ts:477` synths go to group 100; `SuperSonicBridge.ts:657` FX goes to group 101

## SK9: scsynth Node Tree (Desktop Sonic Pi — target)
```
Root Group (0):
  STUDIO-SYNTHS (before FX)
    Run-{jobId}-Synths (per-run)
  STUDIO-FX (before mixer)
    Run-{jobId}-FX (per-run)
      FX-container (per with_fx)
        FX-synths group (head) ← inner synths HERE
        FX synth node (tail)   ← reads in_bus, writes out_bus
  STUDIO-MIXER (head of root)
    sonic-pi-mixer node
  STUDIO-MONITOR (after mixer)
    scope, amp_monitor, recorder
```
**REF:** Reference target — describes Desktop SP node tree (not our code). Consult `GROUND_TRUTH_DESKTOP_SP.md#initialization-sequence` when verifying parity.

## SK10: Cold-Start Init Lifecycle (Cross-Platform Comparison)

**Desktop SP init (GROUND_TRUTH_DESKTOP_SP.md#initialization-sequence):**
1. Boot scsynth as separate OS process — `scsynthexternal.rb:110`
2. Poll `/status` every 1s until response — `scsynthexternal.rb:154`
3. `/notify 1` — `server.rb:63`
4. `/d_loadDir` all synthdefs, wait for `/done` — `server.rb:66`
5. `/s_new "sonic-pi-server-info"` probe synth, wait for response — `server.rb:93`
6. `/clearSched` + sleep 0.1 + `/g_freeAll 0` — `server.rb:169`
7. Create 4 groups (SYNTHS, FX, MIXER, MONITOR) — `studio.rb:463-480`
8. `/s_new "sonic-pi-mixer"` — `studio.rb:490`
9. Root group PAUSED until first job starts — `studio.rb:394`
→ User code runs AFTER all 9 steps complete. No cold-start possible.

**Sonic Tau init (GROUND_TRUTH_SONIC_TAU.md#initialization-sequence):**
1. Fetch + compile WASM on main thread
2. Create AudioContext
3. Register AudioWorklet, WASM instantiated synchronously in constructor — `tau_processor.js` constructor
4. SuperSonic.init() + loadSynthDefs + createGroups + mixer
5. Create OscChannel (SAB), transfer to AudioWorklet
6. OscChannel is null-gated in process() — `tau_processor.js:477`
→ VM cannot emit events before process() fires. Cold-start impossible by construction.

**Sonic Pi Web init (our system):**
1. `SonicPiEngine.init()` → SuperSonic constructor + sonic.init()
2. loadSynthDefs (async)
3. Create groups (100, 101) + mixer
4. `evaluate(code)` → transpile → register loops
5. `play()` → scheduler.start() → first tick → first `/s_new`
→ ~~GAP: No warmup between step 3 and step 5.~~ RESOLVED: The "cold-start gap" was a misdiagnosis (SP22 updated). The actual issue was env_curve: 2 injection in SoundLayer causing silence for overlapping synths. No warmup needed.
**REF:** SV15 (SUPERSEDED); SP22 (updated root cause: env_curve: 2, not init timing)
