import { MinHeap } from './MinHeap'

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
}

export interface TaskState {
  id: string
  virtualTime: number
  bpm: number
  density: number
  currentSynth: string
  outBus: number
  /** The async loop body */
  asyncFn: () => Promise<void>
  /** Whether this task is actively running */
  running: boolean
}

export interface SchedulerEvent {
  type: 'synth' | 'sample' | 'control'
  taskId: string
  virtualTime: number
  audioTime: number
  params: Record<string, unknown>
}

export type EventHandler = (event: SchedulerEvent) => void

export interface SchedulerOptions {
  /** AudioContext (or mock) for timing */
  getAudioTime?: () => number
  /** Lookahead in seconds (default: 0.1) */
  schedAheadTime?: number
  /** Tick interval in ms (default: 25) */
  tickInterval?: number
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
  private schedAheadTime: number
  private tickInterval: number
  private eventHandlers: EventHandler[] = []
  /** Monotonic counter for deterministic ordering of same-time entries */
  private insertionOrder = 0
  /** Map from `${time}:${taskId}` to insertion order for stable sorting */
  private entryOrder = new Map<string, number>()
  private _running = false
  /** Cue state: last cue per name with virtual time and args */
  private cueMap = new Map<string, { time: number; args: unknown[] }>()
  /** Tasks waiting for a cue */
  private syncWaiters = new Map<string, Array<{
    taskId: string
    resolve: (args: unknown[]) => void
  }>>()

  constructor(options: SchedulerOptions = {}) {
    this.getAudioTime = options.getAudioTime ?? (() => 0)
    this.schedAheadTime = options.schedAheadTime ?? 0.1
    this.tickInterval = options.tickInterval ?? 25

    // Priority: by time, then by insertion order for determinism (SP1)
    this.queue = new MinHeap<SleepEntry>((entry) => {
      const orderKey = this.entryOrder.get(`${entry.time}:${entry.taskId}`) ?? 0
      // Combine time with a tiny fraction of insertion order for stable sort
      return entry.time + orderKey * 1e-12
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
  }): void {
    const existing = this.tasks.get(name)
    if (existing && existing.running) {
      // Hot-swap: replace the function, keep the virtual time (SV6)
      existing.asyncFn = asyncFn
      return
    }

    const task: TaskState = {
      id: name,
      virtualTime: 0,
      bpm: options?.bpm ?? 60,
      density: 1,
      currentSynth: options?.synth ?? 'beep',
      outBus: 0,
      asyncFn,
      running: true,
    }
    this.tasks.set(name, task)

    // Immediately start the async chain — it will suspend at sleep(0)
    this.runLoop(task)
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
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
    // Hot-swap or start loops
    for (const [name, fn] of loops) {
      const existing = this.tasks.get(name)
      if (existing && existing.running) {
        // Hot-swap: preserve virtual time (SV6)
        existing.asyncFn = fn
      } else {
        this.registerLoop(name, fn, options)
      }
    }

    // Stop loops that are no longer present
    for (const [name, task] of this.tasks) {
      if (!loops.has(name) && task.running) {
        task.running = false
      }
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
      this.entryOrder.set(`${wakeTime}:${taskId}`, order)
      this.queue.push({ time: wakeTime, taskId, resolve })
    })
  }

  // ---------------------------------------------------------------------------
  // Event dispatch
  // ---------------------------------------------------------------------------

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler)
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
   */
  fireCue(name: string, taskId: string, args: unknown[] = []): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    this.cueMap.set(name, { time: task.virtualTime, args })

    // Wake any tasks waiting for this cue
    const waiters = this.syncWaiters.get(name)
    if (waiters && waiters.length > 0) {
      for (const waiter of waiters) {
        const waiterTask = this.tasks.get(waiter.taskId)
        if (waiterTask) {
          // Inherit cue's virtual time (SV5)
          waiterTask.virtualTime = task.virtualTime
        }
        waiter.resolve(args)
      }
      this.syncWaiters.delete(name)
    }
  }

  /**
   * Wait for a cue. The calling task suspends until fireCue(name) is called.
   * On resume, the task inherits the cue's virtual time (SV5).
   */
  waitForSync(name: string, taskId: string): Promise<unknown[]> {
    // Check if cue already fired
    const existing = this.cueMap.get(name)
    if (existing) {
      const task = this.tasks.get(taskId)
      if (task) {
        task.virtualTime = existing.time
      }
      return Promise.resolve(existing.args)
    }

    // Park this task until cue fires
    return new Promise<unknown[]>((resolve) => {
      const waiters = this.syncWaiters.get(name) ?? []
      waiters.push({ taskId, resolve })
      this.syncWaiters.set(name, waiters)
    })
  }

  // ---------------------------------------------------------------------------
  // Tick — the scheduler heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Resolve all sleep entries up to targetTime.
   * Entries are resolved in deterministic order (time, then insertion order).
   */
  tick(targetTime?: number): void {
    const target = targetTime ?? (this.getAudioTime() + this.schedAheadTime)

    while (this.queue.peek() && this.queue.peek()!.time <= target) {
      const entry = this.queue.pop()!
      this.entryOrder.delete(`${entry.time}:${entry.taskId}`)
      entry.resolve()
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
    this.entryOrder.clear()
    this.eventHandlers.length = 0
    this.cueMap.clear()
    this.syncWaiters.clear()
  }

  // ---------------------------------------------------------------------------
  // Internal: loop execution
  // ---------------------------------------------------------------------------

  private async runLoop(task: TaskState): Promise<void> {
    // Initial sleep(0) so the loop doesn't start until tick fires
    await this.scheduleSleep(task.id, 0)

    while (task.running) {
      try {
        await task.asyncFn()
      } catch (err) {
        console.error(`[SonicPi] Error in loop "${task.id}":`, err)
        task.running = false
        break
      }
    }
  }
}
