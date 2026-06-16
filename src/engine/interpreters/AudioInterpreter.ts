/**
 * AudioInterpreter — runs a Program against real audio.
 *
 * The only interpreter that touches SuperSonic and the scheduler.
 * Walks the step array, triggers synths/samples, awaits sleep via
 * the VirtualTimeScheduler.
 */

import type { Program } from '../Program'
import { TimeState } from '../TimeState'
import { TimeStateView } from '../EventHistory'
import { normalizePlayParams, normalizeControlParams, normalizeFxParams, resolveSynthName } from '../SoundLayer'
import { noteToMidi } from '../NoteToFreq'

/** Visual duration used for note events in the sound event stream (seconds). */
const NOTE_EVENT_VISUAL_DURATION = 0.25
/** Visual duration used for sample events in the sound event stream (seconds). */
const SAMPLE_EVENT_VISUAL_DURATION = 0.5
import type { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import type { SuperSonicBridge } from '../SuperSonicBridge'
import type { SoundEventStream, SoundEvent } from '../SoundEventStream'
import type { MidiBridge } from '../MidiBridge'

/**
 * State for one live inner FX node. Pre-#452 this was REUSED across loop
 * iterations (one node per loop position); since #452 each iteration creates a
 * fresh node (desktop parity) and this tracks one live INSTANCE — overlapping
 * instances coexist in `reusableFx` under nodeId-suffixed keys, each freed by
 * its own kill timer kill_delay after its inner audio finishes.
 */
interface ReusableFxState {
  bus: number
  groupId: number
  nodeId: number
  outBus: number
  /**
   * Pending kill_delay handle — cancelled if FX is reused before it fires (SV41).
   * Backed by `scheduler.scheduleAtVirtualTime` (audio-time scheduled) instead
   * of `setTimeout` (real-time scheduled) so cancellation is independent of
   * real-time iter pacing (SP87 — post-purge real-time-paced iterations broke
   * the setTimeout-based reuse logic).
   */
  killTimer?: { cancel: () => void }
  /**
   * Latest virtual time at which any synth dispatched inside this FX scope's
   * inner block will still be audible (= max over plays/samples of
   *   playStartVt + attack + decay + sustain + release).
   * Used to delay FX bus teardown until inner audio has finished, mirroring
   * desktop SP's `tracker.block_until_finished` THEN `Kernel.sleep(kill_delay)`
   * sequence in sound.rb:1817-1822. Without this, `with_fx :reverb { play
   * release: 60 }` truncated web audio at vt + 1 (the killDelay default) while
   * desktop sustained ~61s — the mod_303_phade regression class.
   */
  aliveUntil: number
}

export interface AudioContext {
  bridge: SuperSonicBridge | null
  scheduler: VirtualTimeScheduler
  taskId: string
  eventStream: SoundEventStream
  schedAheadTime: number
  printHandler?: (msg: string) => void
  nodeRefMap: Map<number, number>
  /**
   * audioTime at which each nodeRef's `/s_new` was scheduled this iteration.
   * SP153/#567: a `control` that follows its `play`/`sample` with NO `sleep`
   * between (same `task.virtualTime`) would otherwise co-bundle its `/n_set`
   * with the `/s_new` at an identical timestamp — and SuperSonic's WASM scsynth
   * then initializes a `*_slide` param's `Lag` UGen at the control TARGET rather
   * than the play value, skipping the glide. We record the creation time here so
   * the `control` case can land the `/n_set` strictly AFTER it (mirrors desktop,
   * whose `/n_set` arrives a control-block after the `/s_new`). Lazily created.
   */
  nodeCreationTime?: Map<number, number>
  /**
   * Live inner FX node instances — keyed by "taskId:fxIndex#nodeId".
   * Since #452 a with_fx inside a live_loop creates a FRESH FX node every
   * iteration (matching desktop SP), so several instances of the same loop
   * position can be alive at once (overlapping, bounded by kill_delay). The
   * nodeId suffix keeps them distinct so iteration N+1 can't overwrite N's
   * entry. Used for inner-play `aliveUntil` bumping + hot-swap teardown.
   * (Pre-#452 this reused one node per loop position to avoid additive
   * stacking — issue #70 — but that diverged from desktop, which overlaps.)
   */
  reusableFx: Map<string, ReusableFxState>
  /**
   * Stack of currently-active with_fx scopes (innermost last), holding the
   * per-instance keys ("taskId:fxIndex#nodeId") that index `reusableFx`.
   * Lazily initialised in `case 'fx'`; absent in paths that never enter an FX.
   * When a play/sample fires, every enclosing FX's `aliveUntil` is extended so
   * the FX bus outlives the audible synth (mirrors desktop sound.rb:1817-1822).
   */
  currentFxStack?: string[]
  /**
   * Global store for set/get. SP95(d) #350 slice 2: now a virtual-time-indexed
   * TimeState. The write is applied EAGERLY at build (ProgramBuilder.set), so
   * the deferred `case 'set'` is a no-op on the TimeState path (Decision Q3 /
   * option a) — re-applying at interpret vt would write a phantom shadow entry
   * at a near-but-different vt and reintroduce the stale read #350 closes.
   * Still typed to permit a plain Map for any non-engine caller; only the
   * TimeState path is no-op'd.
   */
  globalStore?: TimeState | TimeStateView | Map<string | symbol, unknown>
  /** Host-provided OSC send handler. If not set, osc_send is a silent no-op. */
  oscHandler?: (host: string, port: number, path: string, ...args: unknown[]) => void
  /** MIDI bridge for deferred midi-out steps (issue #195). */
  midiBridge?: MidiBridge
  /**
   * Volume-change callback (issue #201). Deferred `set_volume` steps fire at
   * scheduled time and need to update the engine's closure-local
   * `currentVolume` so the next iteration's `current_volume` returns the
   * new value. The engine wires this to its setVolumeShared closure;
   * unset means: just push the bridge change (legacy path).
   */
  onVolumeChange?: (vol: number) => void
  /**
   * Recording lifecycle callback (#228). Fires at scheduled virtual time
   * for `recordingStart` / `recordingStop` / `recordingSave` /
   * `recordingDelete` steps. Engine-side state machine (Recorder instance,
   * lastRecording Blob) lives in SonicPiEngine; this callback is the
   * narrow seam through which the interpreter mutates it. Unset = no-op
   * (e.g. tests with no Recorder host).
   */
  onRecordingEvent?: (
    kind: 'start' | 'stop' | 'save' | 'delete',
    filename?: string,
  ) => void | Promise<void>
}

/**
 * Dispatch a controllable LEAF VOICE (synth or sample) and bind its node ref
 * into `nodeRefMap` SYNCHRONOUSLY, so a same-instant `control`/`kill` (no
 * intervening sleep — e.g. fm_noise's `p = play …; control p, …`) resolves THIS
 * dispatch's live scsynth node. Shared by `case 'play'` and `case 'sample'`
 * (#557/#559); the two FX paths bind their own refs differently (bus+group
 * routing nodes) and are intentionally NOT folded in here.
 *
 * `nodeRef` is the BUILD-TIME ref the ProgramBuilder stamped on the step (one
 * ref namespace with `fx`, so no play-vs-fx counter drift — #560). Reserve the
 * scsynth id up front (a free counter increment), write the map before the next
 * step runs, then fire `produce` with that id. `produce` still loads its
 * synthdef/sample async and still REJECTS on a CDN miss (SV43/SP89). Falls back
 * to the legacy async bind (on the producer's resolved id) when the bridge has
 * no `reserveNodeId` (older mock bridges) or the step carries no ref.
 */
/**
 * SP153/#567: minimum gap between a node's `/s_new` and a `control`'s `/n_set`
 * when they would otherwise share a timestamp (control follows play with no
 * sleep). Must exceed one scsynth control block (64 samples ≈ 1.3ms @48k) and
 * the AudioWorklet render quantum (128 samples ≈ 2.7ms @48k) so the creation
 * bundle is fully processed — the `*_slide` Lag latched at the play value —
 * before the control sets the target. Empirically WASM scsynth needs ~20ms
 * here (5ms still skipped the Lag; a 20ms gap recovers it fully) — larger than
 * native's ~10ms, likely a transport/worklet batching window. 25ms clears the
 * threshold with margin and is far below any audible slide-onset shift (a 25ms
 * shift on a multi-second glide is imperceptible).
 */
const CONTROL_AFTER_CREATE_OFFSET = 0.025

function dispatchNode(
  ctx: AudioContext,
  nodeRef: number | undefined,
  produce: (nodeId?: number) => Promise<number>,
  onError: (err: Error) => void,
): void {
  const bridge = ctx.bridge
  let preReservedNodeId: number | undefined
  if (nodeRef !== undefined && bridge && typeof bridge.reserveNodeId === 'function') {
    preReservedNodeId = bridge.reserveNodeId()
    ctx.nodeRefMap.set(nodeRef, preReservedNodeId)
  }
  produce(preReservedNodeId)
    .then(realNodeId => {
      if (preReservedNodeId === undefined && nodeRef !== undefined) {
        ctx.nodeRefMap.set(nodeRef, realNodeId)
      }
    })
    .catch(onError)
}

/**
 * Run a Program's steps for one loop iteration.
 * Called by the scheduler's loop runner.
 *
 * fxCounter tracks the Nth FX step encountered in this iteration, used as a
 * stable key to reuse inner FX nodes across iterations. The program structure
 * is identical each iteration (same builder), so the Nth FX always corresponds
 * to the same with_fx block.
 */
export async function runProgram(
  program: Program,
  ctx: AudioContext,
  fxCounter?: { value: number },
): Promise<void> {
  if (!fxCounter) fxCounter = { value: 0 }
  let currentSynth = 'beep'
  let currentBpm = ctx.scheduler.getTask(ctx.taskId)?.bpm ?? 60

  for (const step of program) {
    const task = ctx.scheduler.getTask(ctx.taskId)
    if (!task?.running) break

    switch (step.tag) {
      case 'play': {
        // Sonic Pi's should_trigger?: skip if on: is present and falsy
        if ('on' in step.opts && !step.opts.on) break

        // B7 (#387) / B4 (#388): validate-at-boundary. A non-finite note never
        // reaches scsynth — it would produce audible garbage with no diagnostic.
        // Two sources converge here:
        //   - B4: an unparseable note-name string ("not a note") resolves to NaN
        //     and carries the original string in step.noteName, so we can name it
        //     rather than silently sounding middle C.
        //   - B7: arithmetic like `60 / 0` (Infinity) or `0 / 0` (NaN).
        // Skip the trigger, surface a visible warning. Valid notes around it are
        // independent steps and still fire.
        if (!Number.isFinite(step.note)) {
          const reason = step.noteName !== undefined
            ? `"${step.noteName}" isn't a valid note name (use e.g. 60, :c4, :eb3)`
            : `note resolved to ${step.note}. Check for division by zero or invalid arithmetic (e.g. \`play 60 / 0\`).`
          ctx.printHandler?.(`[Warning] play skipped — ${reason}`)
          break
        }

        const audioTime = task.virtualTime + ctx.schedAheadTime
        const synth = resolveSynthName(step.synth ?? currentSynth)

        if (ctx.bridge) {
          // Auto-start mic input on the FIRST dispatch of sound_in per run (#152).
          // The live_loop re-dispatches every ~100ms; without this gate the mic
          // would churn (stop → getUserMedia → reconnect) 10×/sec and the
          // browser's recording indicator would flicker. The bridge is already
          // idempotent + race-safe, but the cheap sync check here also avoids
          // spamming "Mic input failed" from the .catch on every dispatch.
          if ((synth === 'sound_in' || synth === 'sound_in_stereo') &&
              !ctx.bridge.isLiveAudioStreaming(synth)) {
            ctx.bridge.startLiveAudio(synth, { stereo: synth === 'sound_in_stereo' })
              .catch((err: Error) => ctx.printHandler?.(`Mic input failed: ${err.message}`))
          }

          // Mutate step.opts directly — normalizePlayParams copies internally.
          // Avoids 3 object spreads per event that cause GC pressure (#75).
          step.opts.note = step.note
          const playWarn = ctx.printHandler
            ? (m: string) => ctx.printHandler!(`[Warning] play :${synth} — ${m}`)
            : undefined
          const params = normalizePlayParams(synth, step.opts, currentBpm, playWarn)
          params.out_bus = task.outBus
          // #557: bind nodeRefMap SYNCHRONOUSLY (via dispatchNode) so a
          // same-iteration `control p` / `kill p` (no intervening sleep — e.g.
          // fm_noise's `p = play …; control p, divisor: …`) resolves THIS
          // synth's live node, not the previous iteration's freed one.
          const bridge = ctx.bridge
          dispatchNode(
            ctx,
            step.nodeRef,
            (nodeId) => bridge.triggerSynth(synth, audioTime, params, nodeId),
            (err) => ctx.printHandler?.(`Synth '${synth}' failed: ${err.message}`),
          )
          // SP153/#567: remember when this node was created so a same-instant
          // `control` lands its `/n_set` strictly after the `/s_new`.
          if (step.nodeRef !== undefined) {
            (ctx.nodeCreationTime ??= new Map()).set(step.nodeRef, audioTime)
          }

          // Extend enclosing FX scopes' aliveUntil so the FX bus outlives this
          // synth's audible envelope. Mirrors desktop sound.rb:1817-1822
          // (`tracker.block_until_finished` THEN `Kernel.sleep(kill_delay)`).
          // Uses post-normalization envelope values (BPM-scaled).
          if (ctx.currentFxStack && ctx.currentFxStack.length > 0) {
            const a = (params.attack as number | undefined) ?? 0
            const d = (params.decay as number | undefined) ?? 0
            const s = (params.sustain as number | undefined) ?? 0
            const r = (params.release as number | undefined) ?? 1
            const playEnd = task.virtualTime + a + d + s + r
            for (const key of ctx.currentFxStack) {
              const fx = ctx.reusableFx.get(key)
              if (fx && playEnd > fx.aliveUntil) fx.aliveUntil = playEnd
            }
          }
        }

        // Emit sound event
        const audioCtxTime = ctx.bridge?.audioContext?.currentTime ?? 0
        ctx.eventStream.emitEvent({
          audioTime,
          audioDuration: NOTE_EVENT_VISUAL_DURATION,
          scheduledAheadMs: (audioTime - audioCtxTime) * 1000,
          midiNote: step.note,
          s: synth,
          srcLine: step.srcLine ?? null,
          trackId: ctx.taskId,
        })
        break
      }

      case 'sample': {
        // Sonic Pi's should_trigger?: skip if on: is present and falsy
        if (step.opts && 'on' in step.opts && !step.opts.on) break

        const audioTime = task.virtualTime + ctx.schedAheadTime
        if (ctx.bridge) {
          // Merge out_bus from task — samples inside with_fx must write to the FX bus,
          // not the default bus 0. Without this, samples bypass FX entirely.
          const sampleOpts = task.outBus !== 0
            ? { ...step.opts, out_bus: task.outBus }
            : step.opts
          // #559: bind nodeRefMap SYNCHRONOUSLY (via dispatchNode) so a
          // same-iteration `control s` / `kill s` on a running sample resolves
          // THIS sample's live node — symmetric with `play` (#557).
          const bridge = ctx.bridge
          dispatchNode(
            ctx,
            step.nodeRef,
            (nodeId) => bridge.playSample(step.name, audioTime, sampleOpts, currentBpm, nodeId),
            (err) => ctx.printHandler?.(`Sample '${step.name}' failed: ${err.message}`),
          )
          // SP153/#567: see play case — same-instant `control` must land after.
          if (step.nodeRef !== undefined) {
            (ctx.nodeCreationTime ??= new Map()).set(step.nodeRef, audioTime)
          }

          // Extend enclosing FX scopes' aliveUntil so the FX bus outlives this
          // sample. SP135/#506: a sample's audible end is its BUFFER PLAYOUT
          // (bufferFrames/sampleRate, rate/start/finish/stretch-scaled, + release
          // tail), NOT its amp-envelope sum. The old `attack+decay+sustain+
          // release` estimate froze a rate-stretched / long one-shot (e.g.
          // dark_neon's `bass_trance_c, rate:0.5, release:0.2`) at vt+0.2 while the
          // buffer played for seconds → the FX bus was freed mid-buffer → silence.
          // Use the SAME horizon the bridge schedules the sample node's own
          // /n_free with, so bus and node die together. Mirrors desktop
          // `tracker.block_until_finished` (sound.rb:1821). The bridge decodes the
          // buffer on first use, so even the first iteration inside with_fx is
          // correct (vs the cached-only path that would truncate iteration 1).
          if (ctx.currentFxStack && ctx.currentFxStack.length > 0) {
            const playDur = await ctx.bridge.ensureSamplePlaybackDuration(
              step.name,
              step.opts as Record<string, number> | undefined,
              currentBpm,
            )
            const playEnd = task.virtualTime + playDur
            for (const key of ctx.currentFxStack) {
              const fx = ctx.reusableFx.get(key)
              if (fx && playEnd > fx.aliveUntil) fx.aliveUntil = playEnd
            }
          }
        }

        const audioCtxTime = ctx.bridge?.audioContext?.currentTime ?? 0
        ctx.eventStream.emitEvent({
          audioTime,
          audioDuration: SAMPLE_EVENT_VISUAL_DURATION,
          scheduledAheadMs: (audioTime - audioCtxTime) * 1000,
          midiNote: null,
          s: step.name,
          srcLine: step.srcLine ?? null,
          trackId: ctx.taskId,
        })
        break
      }

      case 'sleep':
        // Flush queued OSC messages BEFORE sleeping — matches Sonic Pi's
        // __schedule_delayed_blocks_and_messages! All events since last
        // sleep share one NTP timetag in a single OSC bundle.
        ctx.bridge?.flushMessages()
        await ctx.scheduler.scheduleSleep(ctx.taskId, step.beats)
        break

      case 'timeWarp': {
        // #357: inline (same-thread) time shift. Run the body at
        // `task.virtualTime + delta` (delta NOT density-scaled — desktop
        // core.rb:1108), then RESTORE the pre-warp vt — discarding the shift AND
        // any sleeps inside the body (desktop `__with_preserved_spider_time_and_beat`,
        // core.rb:1040-1092). Same ctx/taskId → shared ticks/synth/FX scope.
        const entryVt = task.virtualTime
        const shiftSec = (step.deltaBeats / task.bpm) * 60
        let warpedVt = entryVt + shiftSec
        // Desktop: "you cannot travel backwards beyond the current_sched_ahead_time"
        // (core.rb:1106). A play schedules at `vt + schedAhead`; for it not to land
        // in the past, `vt >= audioTime - schedAhead`. Clamp + warn on over-shift.
        const floorVt = ctx.scheduler.audioTime - ctx.schedAheadTime
        if (warpedVt < floorVt) {
          ctx.printHandler?.(
            `[Warning] time_warp ${step.deltaBeats} shifts further back than the schedule-ahead window allows — clamped.`,
          )
          warpedVt = floorVt
        }
        task.virtualTime = warpedVt
        await runProgram(step.body, ctx, fxCounter)
        // Restore even if the body left the task stopped — a no-op then.
        task.virtualTime = entryVt
        break
      }

      case 'useSynth':
        currentSynth = resolveSynthName(step.name)
        if (task) task.currentSynth = currentSynth
        break

      case 'useBpm':
        currentBpm = step.bpm
        if (task) task.bpm = step.bpm
        break

      case 'useRealTime':
        // Set schedule-ahead to 0 for responsive MIDI input (#149).
        // Desktop SP Ch 11.1: use_real_time disables latency for current thread.
        ctx.schedAheadTime = 0
        break

      case 'control': {
        const realNodeId = ctx.nodeRefMap.get(step.nodeRef)
        if (realNodeId && ctx.bridge) {
          const audioTime = task.virtualTime + ctx.schedAheadTime
          // SP153/#567: a `control` that follows `play`/`sample` with no `sleep`
          // between (same virtualTime) targets a node whose `/s_new` is still in
          // this iteration's pending message queue. The bridge flushes the whole
          // queue as ONE OSC bundle sharing ONE timetag, so `/s_new` and `/n_set`
          // would execute at the SAME scsynth time — and WASM scsynth then inits a
          // `*_slide` Lag at the control TARGET, skipping the glide (cutoff_slide).
          // An OSC bundle has a single timetag, so separating their execution
          // times requires separate bundles: flush now (emit the node's `/s_new`
          // at its creation time), then queue the `/n_set` at creation+offset so
          // it flushes later, in its own bundle, strictly after the node exists.
          // This mirrors what `sleep` does between play and control (the only
          // thing that previously rendered the slide correctly). A control after
          // an elapsed sleep has audioTime > creation → guard false → untouched.
          const created = ctx.nodeCreationTime?.get(step.nodeRef)
          const coincident = created !== undefined && audioTime <= created
          if (coincident && typeof ctx.bridge.flushMessages === 'function') {
            ctx.bridge.flushMessages(created)
          }
          const ctlTime = coincident ? created! + CONTROL_AFTER_CREATE_OFFSET : audioTime
          const ctlWarn = ctx.printHandler
            ? (m: string) => ctx.printHandler!(`[Warning] control — ${m}`)
            : undefined
          const normalized = normalizeControlParams(step.params, currentBpm, ctlWarn)
          const paramList: (string | number)[] = []
          for (const [k, v] of Object.entries(normalized)) {
            paramList.push(k, v)
          }
          ctx.bridge.sendTimedControl(ctlTime, realNodeId, paramList)
        }
        break
      }

      case 'kill': {
        const killNodeId = ctx.nodeRefMap.get(step.nodeRef)
        if (killNodeId && ctx.bridge) {
          ctx.bridge.freeNode(killNodeId)
        }
        break
      }

      case 'cue':
        ctx.scheduler.fireCue(step.name, ctx.taskId, step.args ?? [])
        break

      case 'set':
        // SP95(d) #350 slice 2: on the TimeState path the write was already
        // applied EAGERLY at build (ProgramBuilder.set) timestamped by
        // current_time(); re-applying here at the interpret vt would create a
        // phantom shadow entry at a near-but-different vt (build vs interpret
        // arithmetic differ) and reintroduce the stale read (Decision Q3,
        // option a) — so the deferred apply is a no-op for TimeState. The step
        // is retained only for SV20/SP41 contract + event-stream/capture. A
        // plain Map (any non-engine caller) keeps the legacy blind-overwrite.
        // GAP M1c: the engine path is now a TimeStateView over the shared
        // EventHistory — also eager, also a no-op here (and its `.set` needs a
        // vt/idPath the deferred step doesn't carry). Only a plain Map writes.
        if (ctx.globalStore instanceof Map) {
          ctx.globalStore.set(step.key, step.value)
        }
        break

      case 'sync': {
        ctx.bridge?.flushMessages()
        const payload = await ctx.scheduler.waitForSync(step.name, ctx.taskId, step.argMatcher)
        if (step.bpmSync) {
          // Inherit cuer's BPM (sync_bpm, #236). Mutate both runtime locals
          // so subsequent sleep/play/FX steps in this iteration use the
          // new BPM. Matches desktop `__change_spider_bpm_time_and_beat!`.
          currentBpm = payload.bpm
          if (task) task.bpm = payload.bpm
        }
        break
      }

      case 'fx': {
        const reps = (step.opts.reps as number) ?? 1
        if (!ctx.bridge) {
          // No audio — just run inner program
          for (let rep = 0; rep < reps; rep++) await runProgram(step.body, ctx, fxCounter)
          break
        }
        const fxIndex = fxCounter.value++
        const baseKey = `${ctx.taskId}:fx${fxIndex}`
        const prevOutBus = task.outBus

        // #452: create a FRESH inner FX node EVERY iteration — desktop parity.
        // Desktop SP's with_fx block instantiates a new FX synth each pass and
        // frees it kill_delay after its inner audio finishes (block_until_finished
        // then Kernel.sleep(kill_delay), sound.rb:1817-1822); overlapping
        // iterations therefore overlap FX nodes. Pre-#452 we REUSED one node per
        // loop position (issue #70 anti-stacking), but that diverged: when an
        // inner synth's release ran past the next iteration the kill timer never
        // fired, collapsing N desktop nodes to 1 and skipping the per-iteration
        // LFO reset on modulating FX (wobble/slicer/panslicer). Now every pass
        // re-creates; overlap is bounded by the same kill_delay desktop uses.
        // Lazy-init the FX scope stack so non-FX paths pay nothing; each entry is
        // a per-INSTANCE key into `ctx.reusableFx` (nodeId-suffixed) so concurrent
        // live instances of the same loop position never collide.
        const fxStack = (ctx.currentFxStack ??= [])

        {
          const newBus = ctx.bridge.allocateBus()
          const fxGroupId = ctx.bridge.createFxGroup()
          let fxNodeId: number | undefined
          // Per-instance key — finalised to `${baseKey}#${nodeId}` once the node
          // id is known (below). Until then `baseKey` is a harmless placeholder
          // (only read by the kill scheduler, which no-ops if no state was set).
          let instanceKey = baseKey
          try {
            // SP83/#423: create the FX node with an IMMEDIATE timetag (0), not
            // the future `vt + schedAhead`. A future timetag puts the /s_new in
            // the prescheduler's time-ordered queue; sibling FX in a nested
            // chain (reverb→slicer) share that exact timetag because no sleep
            // separates the with_fx entry from its body, and the WASM
            // prescheduler does not guarantee FIFO for equal-timetag bundles
            // under the bundle pressure a concurrent live_loop adds. The two FX
            // /s_new then land in either tree order within group 101 — and
            // `applyFxImmediate` uses addToHead, so a reversed processing order
            // inverts the chain (reverb runs before slicer, reading an unwritten
            // bus) → the whole node lifetime is silent (~20% of mod_303_phade
            // runs; OSC byte-identical between good and silent runs — the race
            // is purely scsynth-side ordering). Timetag 0/1 bypasses the
            // prescheduler (`bypassImmediate`) → FIFO dispatch → the outer FX is
            // instantiated before the inner, deterministically. This is exactly
            // how preCreatePersistentFx (SV37) keeps loop-WRAPPING FX race-free;
            // the inline `__run_once` path was the one create site still using a
            // future timetag. The inner synth still plays at vt + schedAhead, so
            // it lands after the (already-instantiated) FX chain.
            //
            // Drain any messages already queued THIS iteration (e.g. a `play`
            // earlier in the same iteration with no intervening sleep) at THEIR
            // own time first — keeps that future-timed /s_new out of the FX
            // bundle. No-op when the queue is empty (the mod_303 case).
            ctx.bridge.flushMessages()
            const fxWarn = ctx.printHandler
              ? (m: string) => ctx.printHandler!(`[Warning] with_fx :${step.name} — ${m}`)
              : undefined
            const fxOpts = normalizeFxParams(step.name, step.opts, currentBpm, fxWarn)
            // #424: accumulate this FX into the ordered immediate-FX bundle
            // (applyFxOrdered) rather than flushing it as its own timetag-0
            // bundle. The whole nested chain (outer reverb → inner slicer) is
            // emitted as ONE bundle when the inner synth is queued (or by the
            // finally below). scsynth runs a bundle's messages in array order,
            // so outer-before-inner is deterministic — the scsynth-side
            // same-timetag /s_new reorder that left the chain reversed (reverb
            // at the head of group 101) and silent ~6% of runs cannot occur.
            // The inner synth still plays at vt+schedAhead, landing after the
            // (already-instantiated) FX chain. Replaces the #423 per-FX
            // flushMessages(0), whose two separate timetag-0 bundles raced.
            fxNodeId = await ctx.bridge.applyFxOrdered(step.name, fxOpts, newBus, prevOutBus)
            if (step.nodeRef && fxNodeId !== undefined) {
              ctx.nodeRefMap.set(step.nodeRef, fxNodeId)
            }
            task.outBus = newBus
            // Finalise the per-instance key now that the node id exists. nodeId
            // is globally unique, so overlapping iterations of THIS loop position
            // get distinct keys — iteration N+1 can't overwrite N's entry, and
            // N's kill timer deletes only its own slot (a stable position key
            // would mis-delete N+1's live entry → hot-swap leak / wrong free).
            instanceKey = `${baseKey}#${fxNodeId}`
            // Track this live instance — pending kill timer scheduled in finally.
            // aliveUntil starts at the current vt (no plays yet); `case 'play'`
            // bumps it as inner synths dispatch.
            const state: ReusableFxState = {
              bus: newBus,
              groupId: fxGroupId,
              nodeId: fxNodeId!,
              outBus: prevOutBus,
              aliveUntil: task.virtualTime,
            }
            ctx.reusableFx.set(instanceKey, state)
            fxStack.push(instanceKey)
            try {
              for (let rep = 0; rep < reps; rep++) await runProgram(step.body, ctx, fxCounter)
            } finally {
              fxStack.pop()
            }
          } finally {
            task.outBus = prevOutBus
            // #424: emit any FX still pending in the ordered immediate-FX bundle
            // (e.g. an FX block with no inner synth, so no queueMessage fired the
            // flush). By here the full chain is accumulated, so this still sends
            // one ordered bundle. No-op once an inner synth already flushed it.
            ctx.bridge.flushImmediateFx()
            ctx.bridge.flushMessages()
            // Schedule this instance's kill in VIRTUAL TIME (SV41). killAt =
            // max(vt_at_block_exit, aliveUntil) + kill_delay — waits for inner
            // audio (aliveUntil, bumped by inner plays/samples) THEN kill_delay,
            // mirroring desktop block_until_finished + Kernel.sleep(kill_delay).
            // Overlapping instances each free themselves under their own key;
            // hot-swap cancels these timers before freeing (no double-free).
            const killDelay = (step.opts.kill_delay as number) ?? 1.0
            const state = ctx.reusableFx.get(instanceKey)
            if (state) {
              const killAt = Math.max(task.virtualTime, state.aliveUntil) + killDelay
              state.killTimer = ctx.scheduler.scheduleAtVirtualTime(killAt, () => {
                ctx.bridge!.freeNode(state.nodeId)
                ctx.bridge!.freeGroup(state.groupId)
                ctx.bridge!.freeBus(state.bus)
                ctx.reusableFx.delete(instanceKey)
              })
            }
          }
        }
        break
      }

      case 'thread': {
        const task = ctx.scheduler.getTask(ctx.taskId)
        if (!task) break
        const threadName = `${ctx.taskId}__thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const threadBody = step.body

        // Spawn a one-shot "loop" that runs the thread body once, then stops
        ctx.scheduler.registerLoop(threadName, async () => {
          await runProgram(threadBody, {
            ...ctx,
            taskId: threadName,
          })
          // One-shot: stop after first run
          const t = ctx.scheduler.getTask(threadName)
          if (t) t.running = false
        }, {
          bpm: task.bpm,
          synth: task.currentSynth,
          outBus: task.outBus,
          // #475: fork at the SPAWNING thread's current cursor, not the
          // scheduler's wall-clock getAudioTime(). A nested `in_thread`/`at`
          // reaches this step while `task` is at its logical virtualTime (e.g.
          // a with_fx block cursor at vt 2.0); getAudioTime() lags that by
          // ~schedAheadTime, so without this anchor the child fires ~0.3s early
          // (SP118-family residual — #448's start-gate only covered TOP-LEVEL
          // in_thread; the nested path forks here). Desktop SP: a child thread
          // inherits the spawner's clock.
          virtualTime: task.virtualTime,
          // GAP A: a nested `in_thread`/`at` forks from the spawning task —
          // child idPath = `spawner.idPath ++ [spawner.childSpawnCount++]`
          // (desktop runtime.rb:1071-1074). The spawner is `task` (ctx.taskId),
          // already fetched above; its own idPath/counter were set at its
          // registration, so the tree composes to any depth without plumbing
          // through ctx. Counter post-increments, so each iteration's fork (a
          // live_loop body re-runs `in_thread` per cycle) gets a fresh distinct
          // index — matching desktop's per-spawn `n_threads_spawned`.
          idPath: [...task.idPath, task.childSpawnCount++],
        })
        break
      }

      case 'liveAudio': {
        if (ctx.bridge) {
          if (step.stop) {
            // live_audio :name, :stop (#236) — kill the named live audio.
            // Synchronous; mirrors hot-swap reconciliation at SonicPiEngine.ts:309.
            ctx.bridge.stopLiveAudio(step.name)
          } else {
            ctx.bridge.startLiveAudio(step.name, { stereo: !!step.opts.stereo })
              .catch((err: Error) => ctx.printHandler?.(`live_audio failed: ${err.message}`))
          }
        }
        break
      }

      case 'oscSend':
        if (ctx.oscHandler) {
          ctx.oscHandler(step.host, step.port, step.path, ...step.args)
        } else {
          ctx.printHandler?.(`[Warning] osc_send: no handler set — message to ${step.host}:${step.port}${step.path} dropped`)
        }
        break

      case 'print':
        ctx.printHandler?.(step.message)
        break

      case 'stop':
        ctx.bridge?.flushMessages()
        if (task) task.running = false
        return

      // --- Deferred-step DSL fixes (issue #193) ---

      case 'stopLoop':
        // Stop a named live_loop at the scheduled time (#194). Without this,
        // stop_loop fired at BUILD time, killing target loops at beat 0.
        ctx.scheduler.stopLoop(step.name)
        break

      case 'setVolume': {
        // Master-volume change at the scheduled time (#197). Ducking patterns
        // were broken because both calls fired at beat 0; now the second call
        // happens after the intermediate sleep.
        // Route through onVolumeChange (#201) so the engine's closure-local
        // currentVolume — read by current_volume — is also updated. Without
        // this, `set_volume 0.3; sleep 4; puts current_volume` printed 1.0.
        const vol = Math.max(0, Math.min(5, step.vol))
        if (ctx.onVolumeChange) {
          ctx.onVolumeChange(vol)
        } else {
          // Fallback when the engine didn't wire onVolumeChange: 1.0 = unity,
          // pass the 0-5 value through (no `/5` — see #579).
          ctx.bridge?.setMasterVolume(vol)
        }
        break
      }

      case 'setMixerControl':
        // Mixer-param sweep at the scheduled time (#255). Same lifecycle
        // reasoning as setVolume: top-level immediate would collapse a
        // `set_mixer_control! lpf: 30; sleep 4; reset_mixer!` pair to two
        // calls at beat 0.
        ctx.bridge?.setMixerControl(step.opts)
        break

      case 'resetMixer':
        // Restore the MIXER config defaults (#255).
        ctx.bridge?.resetMixer()
        break

      case 'useOsc':
        // Mutates builder defaults at build; this step is here so the change
        // is also visible to a step-time observer (no-op effect on bridge,
        // but keeps the lifecycle parity-correct against desktop SP).
        break

      case 'recordingStart':
        await ctx.onRecordingEvent?.('start')
        break

      case 'recordingStop':
        // Await so recording_save in the next step sees lastRecording set.
        // The engine's stop() handler returns a Promise that resolves once
        // MediaRecorder.onstop has fired and the WAV re-encode finishes.
        await ctx.onRecordingEvent?.('stop')
        break

      case 'recordingSave':
        await ctx.onRecordingEvent?.('save', step.filename)
        break

      case 'recordingDelete':
        await ctx.onRecordingEvent?.('delete')
        break

      case 'midiOut': {
        // 14 MIDI-output entry points (#195). All routed through one tag
        // with a `kind` discriminator. Without these, every midi_* call
        // inside a live_loop fired at beat 0 — scheduled MIDI was broken.
        const mb = ctx.midiBridge
        if (!mb) break
        const a = step.args as unknown[]
        switch (step.kind) {
          case 'noteOn': {
            const [note, vel, ch] = a as [number | string, number, number]
            const n = typeof note === 'string' ? noteToMidi(note) : note
            mb.noteOn(n, vel, ch)
            break
          }
          case 'noteOff': {
            const [note, ch, sustainBeats] = a as [number | string, number, number]
            const n = typeof note === 'string' ? noteToMidi(note) : note
            if (sustainBeats > 0) {
              // BPM-aware delay tracked by MidiBridge so engine.stop() can
              // cancel-and-fire-now to prevent hung notes on the device (#200).
              const seconds = sustainBeats * 60 / currentBpm
              mb.scheduleNoteOff(n, ch, seconds)
            } else {
              mb.noteOff(n, ch)
            }
            break
          }
          case 'cc':              { const [c, v, ch] = a as [number, number, number]; mb.cc(c, v, ch); break }
          case 'pitchBend':       { const [v, ch] = a as [number, number]; mb.pitchBend(v, ch); break }
          case 'channelPressure': { const [v, ch] = a as [number, number]; mb.channelPressure(v, ch); break }
          case 'polyPressure':    { const [n, v, ch] = a as [number, number, number]; mb.polyPressure(n, v, ch); break }
          case 'progChange':      { const [p, ch] = a as [number, number]; mb.programChange(p, ch); break }
          case 'clockTick':       mb.clockTick(); break
          case 'start':           mb.midiStart(); break
          case 'stop':            mb.midiStop(); break
          case 'continue':        mb.midiContinue(); break
          case 'allNotesOff':     { const [ch] = a as [number]; mb.allNotesOff(ch); break }
        }
        break
      }
    }
  }
  // Flush any remaining queued messages at end of program
  ctx.bridge?.flushMessages()
}

