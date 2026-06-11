import { MinHeap } from './MinHeap'
import { EventHistory, cueDelivers, compareEvent } from './EventHistory'
import { pathMatch, toWritePath, toReadPath } from './PathMatcher'

// Cue/sync matching (#150 glob, GAP M1c path semantics) is now the shared
// `pathMatch` from PathMatcher — the registered read glob is matched against the
// concrete fired path. The old `cueGlobMatch` (`*`/`?`-only on the raw name) was
// subsumed by it. `pathMatch` keeps the exact-string fast path for glob-free keys.

// ---------------------------------------------------------------------------
// Scheduling constants
// ---------------------------------------------------------------------------

/**
 * How far ahead (seconds) events are submitted to the audio graph.
 *
 * Desktop Sonic Pi uses 0.5s. Events are scheduled via OSC bundles with NTP
 * timetags — the audio is sample-accurate regardless of schedAheadTime.
 * A larger value gives the scheduler more runway to process microtask work
 * from multiple concurrent loops without events arriving late.
 *
 * At 0.1s with 7 loops, tick + microtask work (~40ms) leaves only 60ms of
 * buffer — events barely make their window, causing audible drift (#71).
 * At 0.3s, the buffer is 260ms — comfortable even at high loop density.
 */
export const DEFAULT_SCHED_AHEAD_TIME = 0.3

/** Scheduler heartbeat interval in ms — 25ms = 40Hz. */
export const DEFAULT_TICK_INTERVAL_MS = 25

/**
 * Fallback BPM used by `fireCue` for synthetic external sources (`__midi__`,
 * `__osc__`) whose tasks aren't tracked. Matches `SonicPiEngine`'s startup
 * `defaultBpm = 60`. If you change one, change the other.
 */
export const DEFAULT_TASK_BPM = 60

/**
 * Tiebreak weight applied to insertion order when two sleep entries share the same
 * virtual time. 1e-12 s is far below any audio scheduling precision (≥1 ms), so it
 * never shifts actual timing — it only produces a deterministic total order in the heap.
 */
const HEAP_TIEBREAK_EPSILON = 1e-12

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SleepEntry {
  /** Virtual time to wake at (in seconds) */
  time: number
  /** Which task to resume */
  taskId: string
  /** Promise resolver — only tick() calls this (SV2) */
  resolve: () => void
  /** Insertion order for deterministic tiebreaking (#75 — avoids string allocation) */
  order: number
}

/**
 * Pending one-shot callback bound to audio time (SV41).
 *
 * Used by AudioInterpreter's reusableFx kill_delay — virtual-time-scheduled
 * kill so cancellation by next-iteration reuse is independent of real-time
 * iter pacing (SP87). Fired at `audioTime <= getAudioTime()` (no schedAhead),
 * which is one schedAhead behind sleep entries — this guarantees that when
 * an iter resumes via tick() and cancels its kill in its microtask, the
 * cancellation lands before the corresponding kill horizon is checked.
 */
interface PendingCallback {
  audioTime: number
  cb: () => void
  cancelled: boolean
}

export interface TaskState {
  id: string
  virtualTime: number
  bpm: number
  density: number
  currentSynth: string
  /** #421/SV55: transpose (semitones) and synth_defaults inherited at the loop's
   *  source position — seeded into each iteration's builder, mirroring
   *  currentSynth. Desktop snapshots both thread-locals at fork (runtime.rb:1067). */
  transpose: number
  synthDefaults: Record<string, number>
  /** #353: use_osc target (host/port) inherited at the loop's source position,
   *  mirroring transpose/synth — a nested live_loop inherits the surrounding
   *  in_thread's `use_osc` so `osc` inside the body targets the right host.
   *  Desktop `:sonic_pi_osc_client` thread-local snapshotted at fork. */
  oscHost: string
  oscPort: number
  outBus: number
  /** The async loop body */
  asyncFn: () => Promise<void>
  /** Whether this task is actively running */
  running: boolean
  /**
   * GAP A — hierarchical thread-id path (desktop's `ThreadId`, `thread_id.rb`).
   * The main/run thread is `[0]`; a forked child appends its parent's spawn index
   * (`parentPath ++ [spawnIdx]`, mirroring `runtime.rb:1071-1074`
   * `parent_path << n_threads_spawned`). Used at equal virtual time as the
   * cross-thread tiebreak — `(t, idPath)` lexicographic, longer-prefix-greater
   * (`cueevent.rb:64-74` → `thread_id.rb:41-55`). Inline top-level constructs
   * (`__run_once` / bare `loop` / `with_fx`-wrapped bare loop) stay `[0]`; they
   * run in the main thread, they don't fork (PARITY-GAPS GAP A §2 table).
   *
   * A1 plumbs this additively (assigned everywhere, read NOWHERE) — the
   * comparator flip is A2. Default `[0]` keeps any un-tagged path inert.
   */
  idPath: number[]
  /**
   * GAP A — count of child threads this task has forked. A child's spawn index
   * is this counter's value at fork time; it post-increments (desktop
   * `n_threads_spawned`, `runtime.rb:1072`). Per-task so each parent numbers its
   * own children independently.
   */
  childSpawnCount: number
  /**
   * GAP A / #489 — the cue this task most recently consumed via `sync` (its
   * `(t, idPath)`). Desktop tracks this as `:sonic_pi_local_last_sync`
   * (`core.rb:4551-4571`): a RE-sync's matcher is the LAST CONSUMED cue, and
   * `event_history.rb:139` `ce > matcher.ce` is STRICT, so the same cue is never
   * re-matched — only the next strictly-greater cue is. Without it an inline/main
   * waiter (`[0]`) that catches an equal-vt ancestor cue (`[0,0]`) re-catches the
   * SAME cue every iteration (its vt never advances) → runaway. The FIRST sync
   * has no `lastSyncedCue`, so the `(t,idPath)` wake-phase (`cueDelivers`, #400)
   * is unaffected. Lifecycle: a fresh Run registers a NEW task (undefined →
   * first-sync semantics); a hot-swap KEEPS the task (and this field), matching
   * desktop's persistent thread-local — virtual time continues monotonically so
   * the next cue is still strictly-greater. No explicit reset needed.
   */
  lastSyncedCue?: { t: number; idPath: number[] }
}

export interface SchedulerEvent {
  type: 'synth' | 'sample' | 'control' | 'cue'
  taskId: string
  virtualTime: number
  audioTime: number
  params: Record<string, unknown>
}

export type EventHandler = (event: SchedulerEvent) => void

/**
 * Payload returned to a sync waiter when the cue fires (#236).
 * `bpm` carries the cuer's BPM at fire-time so waiters using `bpm_sync: true`
 * can inherit it (matches desktop `__change_spider_bpm_time_and_beat!`).
 *
 * Breaking change since v1.5.x: `waitForSync` previously returned
 * `Promise<unknown[]>`. External embedders calling `scheduler.waitForSync`
 * directly should migrate `args = await waitForSync(...)` to
 * `{ args } = await waitForSync(...)`.
 */
export interface SyncPayload {
  args: unknown[]
  bpm: number
}

export interface SchedulerOptions {
  /** AudioContext (or mock) for timing */
  getAudioTime?: () => number
  /** Lookahead in seconds (default: 0.1) */
  schedAheadTime?: number
  /** Tick interval in ms (default: 25) */
  tickInterval?: number
  /**
   * GAP M1c — the shared coordination store. When the engine injects its
   * EventHistory, `set`/`get` (engine side) and `cue`/`sync` (scheduler side)
   * use the SAME store, so a `get :foo` sees a `cue :foo` (desktop's single
   * `@event_history`). Omitted ⇒ the scheduler owns a private store (raw
   * scheduler usage / unit tests, behaviour unchanged).
   */
  eventHistory?: EventHistory
}

// ---------------------------------------------------------------------------
// VirtualTimeScheduler
// ---------------------------------------------------------------------------

/**
 * Cooperative async scheduler with virtual time.
 *
 * Core innovation: sleep() returns a Promise that ONLY tick() can resolve.
 * Multiple live_loops run concurrently via cooperative async suspension.
 *
 * Invariants:
 * - SV1: virtualTime per task is non-decreasing, advances only on sleep/sync
 * - SV2: sleep Promises are resolved exclusively by tick()
 * - SV3: deterministic ordering — entries sorted by (time, taskId)
 * - SV4: three-clock separation — wall/audio/virtual clocks are independent
 */
export class VirtualTimeScheduler {
  private queue: MinHeap<SleepEntry>
  private tasks = new Map<string, TaskState>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private getAudioTime: () => number
  /** Public read of the current audio-context time (used by current_time at top level — #226). */
  get audioTime(): number { return this.getAudioTime() }
  private schedAheadTime: number
  private tickInterval: number
  private eventHandlers: EventHandler[] = []
  private loopErrorHandler: ((taskId: string, err: Error) => void) | null = null
  /** Monotonic counter for deterministic ordering of same-time entries */
  private insertionOrder = 0
  /** Map from `${time}:${taskId}` to insertion order for stable sorting */
  // entryOrder Map removed — insertion order stored directly on SleepEntry (#75)
  private _running = false
  /**
   * GAP A2 — cue history: the `(t, idPath)`-ordered store of fired cues (port of
   * the cue side of `event_history.rb`), replacing the old single-entry cueMap.
   * `sync` resolves over it (`getNext` = next cue strictly after the sync point),
   * which (a) fixes the with_fx registration race — a same-`t` higher-idPath cue
   * that fired before the waiter registered is still found in history — and (b)
   * applies the `(t, idPath)` tiebreak at equal vt (#481). Capped per key
   * (the auto-cue fires once per loop iteration; old cues are irrelevant to a
   * forward-looking `sync`) so it does not grow unbounded the way cueMap never
   * did. Value = `{ args, bpm }` (the cuer's BPM at fire time, for sync_bpm).
   */
  private cueHistory: EventHistory
  /**
   * GAP M1c: true only when this scheduler created its OWN cueHistory. When the
   * engine injects the shared store, the scheduler must NOT clear it on dispose —
   * the engine owns its lifecycle (cleared only on engine dispose, SK14). Without
   * this guard, re-evaluating (which disposes the prior scheduler) would wipe
   * set/get state, breaking #336 (set persists across Stop; desktop's
   * @event_history persists until quit).
   */
  private readonly ownsCueHistory: boolean
  /** Tasks waiting for a cue */
  private syncWaiters = new Map<string, Array<{
    taskId: string
    resolve: (payload: SyncPayload) => void
    /**
     * The waiter's sync point `(virtualTime, idPath)`. A cue is delivered only if
     * it is strictly GREATER in the `(t, idPath)` total order (desktop
     * `ce > matcher.ce`, event_history.rb:139) — so at equal vt a same-or-lower
     * idPath cue misses (the forked-sibling waiter waits a cycle, #481) while a
     * higher-idPath cue catches (the inline/main waiter, #481 with_fx/bare_loop).
     */
    waiterVt: number
    waiterIdPath: number[]
    /** GAP M2: desktop's `arg_matcher` — wakes only on a cue whose value passes. */
    valMatcher?: (value: unknown) => boolean
  }>>()
  /** One-shot audio-time-bound callbacks (SV41 — backs scheduleAtVirtualTime). */
  private pendingCallbacks: PendingCallback[] = []

  constructor(options: SchedulerOptions = {}) {
    this.getAudioTime = options.getAudioTime ?? (() => 0)
    this.schedAheadTime = options.schedAheadTime ?? DEFAULT_SCHED_AHEAD_TIME
    this.tickInterval = options.tickInterval ?? DEFAULT_TICK_INTERVAL_MS
    // GAP M1c: share the engine's coordination store if injected, else own one.
    this.ownsCueHistory = !options.eventHistory
    this.cueHistory = options.eventHistory ?? new EventHistory({ maxPerKey: 256 })

    // Priority: by time, then by insertion order for determinism (SP1)
    // Uses entry.order directly — no Map lookup or string allocation (#75)
    this.queue = new MinHeap<SleepEntry>((entry) => {
      return entry.time + entry.order * HEAP_TIEBREAK_EPSILON
    })
  }

  get running(): boolean {
    return this._running
  }


  // ---------------------------------------------------------------------------
  // Task registration
  // ---------------------------------------------------------------------------

  /**
   * Register a named live_loop and immediately start its async chain.
   * The loop suspends at an initial sleep(0) — it won't execute until tick().
   */
  registerLoop(name: string, asyncFn: () => Promise<void>, options?: {
    bpm?: number
    synth?: string
    // #421/SV55: transpose / synth_defaults snapshotted at the loop's source
    // position (mirrors `synth`), seeded into TaskState below.
    transpose?: number
    synthDefaults?: Record<string, number>
    // #353: use_osc target snapshotted at the loop's source position (mirrors transpose).
    oscHost?: string
    oscPort?: number
    outBus?: number
    // #475: anchor the new task's start virtual time to a specific cursor
    // instead of the wall-clock getAudioTime(). A thread spawned mid-run by a
    // nested `in_thread`/`at` (AudioInterpreter `case 'thread'`) must fork at
    // the SPAWNING thread's current virtualTime — desktop SP semantics: a child
    // thread inherits the spawner's clock (in_thread doesn't advance the
    // spawner). Without this, the child starts at getAudioTime(), which lags
    // the spawner's logical cursor by ~schedAheadTime → fires ~0.3s early.
    // Launch-time registrations (top-level live_loop/in_thread via
    // SonicPiEngine) omit it and keep getAudioTime() — their offset is handled
    // by the #448 start-gate cue, not here.
    virtualTime?: number
    // GAP A: the hierarchical thread-id path for this task (see TaskState.idPath).
    // The caller (spawn site) computes it: `[0]` for the main/inline thread,
    // `[0, n]` for a top-level fork, `parentPath ++ [spawnIdx]` for a nested fork.
    // Omitted → `[0]` (treat as main/inline — inert under A2's compare).
    idPath?: number[]
  }): void {
    const existing = this.tasks.get(name)
    if (existing && existing.running) {
      // Hot-swap: replace the function, keep the virtual time (SV6)
      existing.asyncFn = asyncFn
      return
    }

    const task: TaskState = {
      id: name,
      virtualTime: options?.virtualTime ?? this.getAudioTime(),
      bpm: options?.bpm ?? 60,
      density: 1,
      currentSynth: options?.synth ?? 'beep',
      transpose: options?.transpose ?? 0,
      synthDefaults: options?.synthDefaults ?? {},
      oscHost: options?.oscHost ?? 'localhost',
      oscPort: options?.oscPort ?? 4560,
      outBus: options?.outBus ?? 0,
      asyncFn,
      running: true,
      // GAP A: caller-supplied thread-id path; `[0]` (main/inline) when omitted.
      idPath: options?.idPath ?? [0],
      childSpawnCount: 0,
    }
    this.tasks.set(name, task)

    // Immediately start the async chain — it will suspend at sleep(0)
    this.runLoop(task)
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  /** Get names of all currently running loops. */
  getRunningLoopNames(): string[] {
    const names: string[] = []
    for (const [name, task] of this.tasks) {
      if (task.running) names.push(name)
    }
    return names
  }

  /** Stop a named loop from outside. Returns true if the loop was running. */
  stopLoop(name: string): boolean {
    const task = this.tasks.get(name)
    if (!task || !task.running) return false
    task.running = false
    return true
  }


  /**
   * Hot-swap a running loop's function.
   * Preserves virtualTime, bpm, density, random state (SV6).
   * The new function takes effect on the next loop iteration.
   */
  hotSwap(loopName: string, newFn: () => Promise<void>): boolean {
    const task = this.tasks.get(loopName)
    if (!task || !task.running) return false
    task.asyncFn = newFn
    return true
  }

  /**
   * Re-evaluate: given a new set of loop names and functions,
   * hot-swap loops that persist, stop removed loops, start new ones.
   */
  reEvaluate(loops: Map<string, () => Promise<void>>, options?: {
    bpm?: number
    synth?: string
  }): void {
    // Save previous state for rollback on failure
    const previousFns = new Map<string, () => Promise<void>>()
    const newlyStarted: string[] = []

    try {
      // Hot-swap or start loops
      for (const [name, fn] of loops) {
        const existing = this.tasks.get(name)
        if (existing && existing.running) {
          // Save previous function for rollback
          previousFns.set(name, existing.asyncFn)
          // Hot-swap: preserve virtual time (SV6)
          existing.asyncFn = fn
        } else {
          this.registerLoop(name, fn, options)
          newlyStarted.push(name)
        }
      }

      // Stop loops that are no longer present
      for (const [name, task] of this.tasks) {
        if (!loops.has(name) && task.running) {
          task.running = false
        }
      }
    } catch (err) {
      // Rollback: restore previous functions for swapped loops
      for (const [name, prevFn] of previousFns) {
        const task = this.tasks.get(name)
        if (task) task.asyncFn = prevFn
      }
      // Stop newly started loops
      for (const name of newlyStarted) {
        const task = this.tasks.get(name)
        if (task) task.running = false
      }
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // sleep — the core primitive
  // ---------------------------------------------------------------------------

  /**
   * Schedule a sleep for the given task.
   * Returns a Promise that ONLY tick() can resolve (SV2).
   *
   * Virtual time advances immediately on call (SV1).
   */
  scheduleSleep(taskId: string, beats: number): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return Promise.reject(new Error(`Unknown task: ${taskId}`))

    const seconds = (beats / task.bpm) * 60
    const wakeTime = task.virtualTime + seconds
    task.virtualTime = wakeTime

    return new Promise<void>((resolve) => {
      const order = this.insertionOrder++
      this.queue.push({ time: wakeTime, taskId, resolve, order })
    })
  }

  /**
   * Schedule a one-shot callback to fire when audio time reaches `audioTime` (SV41).
   *
   * Distinct from `scheduleSleep`:
   * - sleep entries fire at `audioTime + schedAhead >= entry.time` (lookahead horizon)
   * - pending callbacks fire at `audioTime >= entry.audioTime` (no lookahead)
   *
   * The schedAhead-stripped horizon is intentional: it gives a task that resumed
   * from a sleep firing in the same tick (lookahead horizon) time to drain its
   * microtask queue and call `.cancel()` before the corresponding callback's
   * horizon is checked. Used by `AudioInterpreter.reusableFx` to schedule
   * inner-FX kill_delay in virtual time instead of real-time setTimeout
   * (SP87, SV41 — iter pacing in real time is unstable post SV40 purge).
   *
   * Returns `{ cancel }` — call it to prevent the callback from firing.
   */
  scheduleAtVirtualTime(audioTime: number, cb: () => void): { cancel: () => void } {
    const entry: PendingCallback = { audioTime, cb, cancelled: false }
    this.pendingCallbacks.push(entry)
    return {
      cancel: () => { entry.cancelled = true },
    }
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler)
  }

  /** Register a handler called when a loop throws a runtime error. */
  onLoopError(handler: (taskId: string, err: Error) => void): void {
    this.loopErrorHandler = handler
  }

  emitEvent(event: SchedulerEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }

  // ---------------------------------------------------------------------------
  // sync/cue — inter-task synchronization
  // ---------------------------------------------------------------------------

  /**
   * Broadcast a cue event. Any tasks waiting via waitForSync
   * are woken and inherit the cuer's virtual time (SV5).
   *
   * `taskId` may identify a real scheduler task (normal DSL cue from inside
   * a live_loop) OR a synthetic external source (e.g. `'__midi__'` from the
   * MIDI bridge, `'__osc__'` from incoming OSC — #151). When the task does
   * not exist, fall back to the current audio time so external sources still
   * wake sync waiters instead of silently returning.
   */
  fireCue(name: string, taskId: string, args: unknown[] = [], op: 'cue' | 'live_loop' = 'cue'): void {
    const task = this.tasks.get(taskId)
    const cueVirtualTime = task?.virtualTime ?? this.getAudioTime()
    // Synthetic external sources ('__midi__', '__osc__', #151) have no real
    // task — fall back to the engine's startup BPM so sync_bpm waiters still
    // get a defined value rather than NaN.
    const cueBpm = task?.bpm ?? DEFAULT_TASK_BPM
    // GAP A2: the cuer's thread-id path — the equal-vt tiebreak. Synthetic
    // external sources (no task) cue as main `[0]`.
    const cueIdPath = task?.idPath ?? [0]

    // GAP M1c: namespace the write by op — `cue :foo`→/cue/foo, a live_loop
    // heartbeat→/live_loop/foo. An absolute key (external `/midi:*`) is kept
    // verbatim (toWritePath's leading-`/` rule). A `sync :foo` reads the union
    // `/{cue,set,live_loop}/foo`, so it matches whichever root the writer used.
    const firedPath = toWritePath(name, op)

    // Record the cue in the (t, idPath)-ordered history so a late or
    // forked-sibling syncer resolves it correctly (replaces the single-entry
    // cueMap). Value carries the cuer's BPM for sync_bpm waiters (#236).
    const value = { args, bpm: cueBpm }
    this.cueHistory.insert(firedPath, cueVirtualTime, cueIdPath, value)

    // Emit cue event for UI (CueLog panel)
    this.emitEvent({
      type: 'cue',
      taskId,
      virtualTime: cueVirtualTime,
      audioTime: this.getAudioTime(),
      params: { name, args },
    })

    // Wake any parked sync waiters. Desktop runs `@event_matchers.match(ce)` from
    // the SAME EventHistory.set both `cue` and `set` flow through (event_history.rb
    // :204) — so the wake loop is shared via notifyWaiters and also reachable from
    // the `set` path (#498, notifySet below).
    this.notifyWaiters(firedPath, cueVirtualTime, cueIdPath, value)
  }

  /**
   * Wake the parked sync waiters a just-recorded event satisfies. Desktop's
   * `EventHistory.set` calls `@event_matchers.match(ce)` after every insert
   * (event_history.rb:204) — for cues (via {@link fireCue}) AND for `set`s (via
   * {@link notifySet}, #498). The store insert is the CALLER's responsibility;
   * this runs only the match, so it never double-records.
   *
   * `storedValue` is the value exactly as it sits in the history: `{ args, bpm }`
   * for a cue, a raw value for a `set`. Both the live wake (here) and the
   * history-first scan ({@link waitForSync}) pass that same stored value to the
   * waiter's `valMatcher` and resolve from it, so a set-before-park and a
   * park-before-set deliver identically.
   *
   * Supports exact match AND glob patterns (asterisk, ?) in sync targets (#150):
   * a `sync` glob like `/midi:_:_/note_on` matches a concrete fired midi path.
   */
  notifyWaiters(firedPath: string, vt: number, idPath: number[], storedValue: unknown): void {
    for (const [pattern, waiters] of this.syncWaiters) {
      if (waiters.length === 0) continue
      // GAP M1c: a waiter is registered under its READ path (a glob like
      // `/{cue,set,live_loop}/foo`); match it against the concrete fired path.
      if (!pathMatch(pattern, firedPath)) continue
      // Wake-phase (cueDelivers, observed desktop #481/#400): deliver iff the event
      // is strictly LATER, or — at EQUAL vt — the waiter is a strict ANCESTOR of
      // the firer (its thread spawned the firer, then synced → happens-after). A
      // forked-SIBLING waiter ([0,1]) misses a driver cue ([0,0]) and waits a
      // cycle (#481 in_thread / #350 met / #400 player); an inline/main waiter
      // ([0]) catches a driver cue ([0,0]) at the same vt (#481 with_fx/bare_loop).
      const kept: typeof waiters = []
      for (const waiter of waiters) {
        const waiterTask = this.tasks.get(waiter.taskId)
        // #489: don't re-deliver an event at or before the one this waiter already
        // consumed (desktop's last-sync matcher). The wake-phase (cueDelivers) is
        // unchanged; this only excludes an already-seen event on a re-sync.
        const after = waiterTask?.lastSyncedCue
        const delivers = cueDelivers(vt, idPath, waiter.waiterVt, waiter.waiterIdPath)
          && (!after || compareEvent({ t: vt, idPath }, after) > 0)
          // GAP M2: arg_matcher — the waiter only wakes if the event's value passes.
          && (!waiter.valMatcher || waiter.valMatcher(storedValue))
        if (delivers) {
          if (waiterTask) {
            // Inherit the event's virtual time (SV5) and advance the re-sync matcher.
            waiterTask.virtualTime = vt
            waiterTask.lastSyncedCue = { t: vt, idPath }
          }
          // Resolve from the stored value the same way history-first does
          // (waitForSync): a cue's `{ args, bpm }` round-trips; a raw set value
          // yields `{ args: undefined, bpm: undefined }` (set→sync value retrieval
          // is a separate, pre-existing limitation, not this fix's concern).
          const payload = storedValue as { args: unknown[]; bpm: number }
          waiter.resolve({ args: payload.args, bpm: payload.bpm })
        } else {
          kept.push(waiter)
        }
      }
      if (kept.length > 0) this.syncWaiters.set(pattern, kept)
      else this.syncWaiters.delete(pattern)
    }
  }

  /**
   * Wake parked syncs for a live `set` (#498). The eager build-time write already
   * landed `value` in the shared store ({@link ProgramBuilder.set} → TimeStateView);
   * this runs the match desktop's `EventHistory.set` does afterwards
   * (event_history.rb:204), so a `set` that fires while a `sync` is already parked
   * wakes it — not just the set-before-sync case the history-first scan covers.
   * The `set` write namespaces the key under `/set/` (toWritePath), matching the
   * union read `sync :foo` registers (`/{cue,set,live_loop}/foo`).
   */
  notifySet(name: string, vt: number, idPath: number[], value: unknown): void {
    this.notifyWaiters(toWritePath(name, 'set'), vt, idPath, value)
  }

  /**
   * Wait for a cue. The calling task suspends until fireCue(name) is called.
   * On resume, the task inherits the cue's virtual time (SV5). The resolved
   * payload also carries the cuer's BPM so callers using `bpm_sync: true`
   * (sync_bpm, #236) can mutate the waiter's task.bpm.
   */
  waitForSync(name: string, taskId: string, argMatcher?: (args: unknown) => boolean): Promise<SyncPayload> {
    // GAP A2: desktop `sync` (event_history.rb:215) checks history FIRST —
    // `get_next` returns the next cue strictly after the sync point if one is
    // already recorded — and only blocks if none. This is the with_fx
    // registration-race fix: the driver's vt0 cue fired before this inline
    // waiter (in __run_once = main `[0]`) registered, but it is in cueHistory,
    // and `getNext('tick', 0, [0])` finds it (the same-`t` higher-idPath cue is
    // strictly greater) → deliver now, no missed cycle. A forked-sibling waiter
    // ([0,1]) gets `null` from getNext (the cue is ≤ it) and blocks for the next
    // cycle — desktop's "a freshly-started synced loop waits a cycle" (#350/#481).
    // SV11 is preserved: a genuinely-past cue has lower vt, so it is NOT strictly
    // greater and is not delivered.
    const task = this.tasks.get(taskId)
    const waiterVt = task?.virtualTime ?? 0
    const waiterIdPath = task?.idPath ?? [0]

    // GAP M1c: read via the union path (`sync :foo` → `/{cue,set,live_loop}/foo`,
    // an explicit/external `/midi:*` kept verbatim). The store is shared with
    // set/get, so this glob also sees a `set :foo` — desktop's single
    // @event_history (the cross-namespace wake).
    const readPath = toReadPath(name)

    // GAP M2: `arg_matcher` filters by the cue's VALUE. A cue's stored value is
    // `{ args, bpm }`; desktop's matcher receives the cue's `val` (= the args),
    // so unwrap to `.args`. A `set`-sourced event (cross-namespace) stores a raw
    // value — pass it through. Both EventHistory's history-first scan and the live
    // wake loop use this same predicate over the stored value.
    const valMatcher = argMatcher
      ? (stored: unknown): boolean => {
          const v = stored && typeof stored === 'object' && 'args' in (stored as object)
            ? (stored as { args: unknown }).args
            : stored
          return argMatcher(v)
        }
      : undefined

    // History-first (event_history.rb:215): if a deliverable cue is already
    // recorded, resolve now — this is the with_fx registration-race fix
    // (#350/#481), and via the union glob it also catches a set/cue that fired
    // before this sync registered. getNextDelivered (GAP M1b) scans every key the
    // glob matches. #489: a re-sync excludes the cue this task last consumed.
    const after = task?.lastSyncedCue
    const hit = this.cueHistory.getNextDelivered(readPath, waiterVt, waiterIdPath, after, valMatcher)
    if (hit) {
      if (task) {
        task.virtualTime = hit.t // inherit the cue's vt (SV5)
        task.lastSyncedCue = { t: hit.t, idPath: hit.idPath } // #489: advance matcher
      }
      const payload = hit.value as { args: unknown[]; bpm: number }
      return Promise.resolve({ args: payload.args, bpm: payload.bpm })
    }

    return new Promise<SyncPayload>((resolve) => {
      const waiters = this.syncWaiters.get(readPath) ?? []
      waiters.push({ taskId, resolve, waiterVt, waiterIdPath, valMatcher })
      this.syncWaiters.set(readPath, waiters)
    })
  }

  // ---------------------------------------------------------------------------
  // Tick — the scheduler heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Resolve all sleep entries up to targetTime.
   * Entries are resolved in deterministic order (time, then insertion order).
   *
   * With 10ms tick interval + 300ms schedAheadTime (#71), events are resolved
   * more frequently (100Hz vs 40Hz) and have 3x more runway before their
   * target audio time, reducing the impact of microtask processing delays.
   */
  tick(targetTime?: number): void {
    const target = targetTime ?? (this.getAudioTime() + this.schedAheadTime)

    while (this.queue.peek() && this.queue.peek()!.time <= target) {
      const entry = this.queue.pop()!
      entry.resolve()
    }

    // SV41: fire/cleanup pending audio-time-bound callbacks AFTER sleep entries.
    // Horizon is `target - schedAhead` (the underlying audio time), so any task
    // resumed from the sleep heap above has a chance to drain its microtask
    // queue and cancel its kill before the kill's horizon is reached.
    //
    // CRITICAL: fired callbacks are deferred via `queueMicrotask`. Sleep entries
    // resolved above queued their await-resumption microtasks FIRST; deferring
    // the kill fire ensures an iter that resumes from sleep and synchronously
    // cancels its kill in a with_fx reuse-check lands BEFORE the kill wrapper
    // checks `cancelled`. Without the deferral, kill fires synchronously inside
    // tick() (before any microtask drain), so when the same tick resolves both
    // iter N+1's sleep and the kill horizon, the kill executes before iter N+1
    // can call .cancel() — and the FX is wrongly freed (SP87).
    if (this.pendingCallbacks.length > 0) {
      const cbHorizon = target - this.schedAheadTime
      let writeIdx = 0
      for (let i = 0; i < this.pendingCallbacks.length; i++) {
        const pc = this.pendingCallbacks[i]
        if (pc.cancelled) continue // drop cancelled
        if (pc.audioTime <= cbHorizon) {
          const fired = pc
          queueMicrotask(() => {
            if (fired.cancelled) return
            try { fired.cb() } catch (err) {
              if (this.loopErrorHandler) this.loopErrorHandler('__pendingCallback__', err as Error)
            }
          })
          continue // drop fired (queued)
        }
        this.pendingCallbacks[writeIdx++] = pc
      }
      this.pendingCallbacks.length = writeIdx
    }
  }

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  /** Start the tick timer. Loops are already running (suspended at sleep). */
  start(): void {
    if (this._running) return
    this._running = true
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval)
  }

  /** Pause the tick timer without stopping tasks. Used during hot-swap. */
  pauseTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /** Resume the tick timer after a pause. */
  resumeTick(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    if (!this._running) { this.tickTimer = null; return }
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval)
  }

  stop(): void {
    this._running = false

    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }

    // Mark all tasks as not running — breaks their while loops
    for (const task of this.tasks.values()) {
      task.running = false
    }
  }

  dispose(): void {
    this.stop()
    this.tasks.clear()
    this.queue.clear()
    this.eventHandlers.length = 0
    // GAP M1c: only clear a store we OWN. An injected (shared) store is the
    // engine's — clearing it here would wipe set/get + cue state on every
    // re-evaluate (which disposes the prior scheduler). #336 / SK14.
    if (this.ownsCueHistory) this.cueHistory.clear()
    this.syncWaiters.clear()
    this.pendingCallbacks.length = 0
  }

  // ---------------------------------------------------------------------------
  // Internal: loop execution
  // ---------------------------------------------------------------------------

  private async runLoop(task: TaskState): Promise<void> {
    // Initial sleep(0) so the loop doesn't start until tick fires
    await this.scheduleSleep(task.id, 0)

    // No-sleep iteration counter — detects live_loops that forgot sleep.
    // Each iteration that completes without advancing virtual time increments this.
    // After MAX_NOSLEEP_ITERATIONS, the loop is killed with InfiniteLoopError.
    // A successful sleep resets the counter. Matches Desktop SP's "did you forget a sleep?" error.
    const MAX_NOSLEEP_ITERATIONS = 1024
    let noSleepCount = 0

    while (task.running) {
      // Auto-cue: Sonic Pi fires cue(:loop_name) at the start of each iteration.
      // This is how sync: :name works on other live_loops.
      // Note: SonicPiEngine also fires a cue after each iteration (line ~290).
      // Having it here ensures it works for raw scheduler usage too.
      this.fireCue(task.id, task.id, [], 'live_loop')
      const vtBefore = task.virtualTime
      try {
        await task.asyncFn()
      } catch (err) {
        // StopSignal is expected — it means `stop` was called in user code
        if (err instanceof Error && err.name === 'StopSignal') {
          task.running = false
          break
        }
        // InfiniteLoopError — stop the loop immediately, do not retry
        if (err instanceof Error && err.name === 'InfiniteLoopError') {
          task.running = false
          if (this.loopErrorHandler) {
            this.loopErrorHandler(task.id, err)
          } else {
            console.error(`[SonicPi] Error in loop "${task.id}":`, err)
          }
          break
        }
        const error = err instanceof Error ? err : new Error(String(err))
        if (this.loopErrorHandler) {
          this.loopErrorHandler(task.id, error)
        } else {
          console.error(`[SonicPi] Error in loop "${task.id}":`, error)
        }
        // Recovery sleep: pause 1 beat so we don't spin on a tight error loop
        if (task.running) {
          await this.scheduleSleep(task.id, 1)
        }
      }

      // No-sleep detection: if virtual time didn't advance, the loop body
      // had no sleep/sync. After MAX_NOSLEEP_ITERATIONS, kill the loop.
      // This prevents browser tab freeze from `live_loop :x do; play 60; end`.
      if (task.virtualTime === vtBefore) {
        noSleepCount++
        if (noSleepCount >= MAX_NOSLEEP_ITERATIONS) {
          const err = new Error('Infinite loop detected — did you forget a sleep?')
          err.name = 'InfiniteLoopError'
          task.running = false
          if (this.loopErrorHandler) {
            this.loopErrorHandler(task.id, err)
          } else {
            console.error(`[SonicPi] Error in loop "${task.id}":`, err)
          }
          break
        }
      } else {
        noSleepCount = 0
      }
    }
  }
}
