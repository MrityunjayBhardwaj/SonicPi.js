import { VirtualTimeScheduler, type SchedulerEvent } from './VirtualTimeScheduler'
import { SeededRandom } from './SeededRandom'
import { Ring, ring, knit, range, line } from './Ring'
import { spread } from './EuclideanRhythm'
import { noteToMidi, midiToFreq, noteToFreq } from './NoteToFreq'
import { chord, scale, chord_invert, note, note_range } from './ChordScale'

export { Ring, ring, knit, range, line, spread, noteToMidi, midiToFreq, noteToFreq }
export { chord, scale, chord_invert, note, note_range }

/** Interface for FX bus management — implemented by SuperSonicBridge */
export interface FxBridge {
  allocateBus(): number
  freeBus(busNum: number): void
  applyFx(fxName: string, params: Record<string, number>, inBus: number, outBus: number): Promise<number>
  freeNode(nodeId: number): void
}

export interface DSLOptions {
  scheduler: VirtualTimeScheduler
  fxBridge?: FxBridge | null
}

/**
 * Task-bound DSL functions.
 * Each live_loop gets its own set of these, bound to the task's ID.
 * This eliminates shared mutable state across async interleaving.
 */
export interface TaskDSL {
  play(note: string | number, opts?: Record<string, number>): Promise<{ nodeId: number } | void>
  sleep(beats: number): Promise<void>
  sample(name: string, opts?: Record<string, number>): Promise<void>
  cue(name: string, ...args: unknown[]): void
  sync(name: string): Promise<unknown[]>
  control(nodeRef: { nodeId: number }, opts: Record<string, number>): void
  with_fx(name: string, opts: Record<string, number>, fn: (ctx: TaskDSL) => Promise<void>): Promise<void>
  with_fx(name: string, fn: (ctx: TaskDSL) => Promise<void>): Promise<void>
  use_synth(name: string): void
  use_bpm(bpm: number): void
  rrand(min: number, max: number): number
  rrand_i(min: number, max: number): number
  rand(max?: number): number
  rand_i(max?: number): number
  choose<T>(arr: T[]): T
  dice(sides: number): number
  one_in(n: number): boolean
  use_random_seed(seed: number): void
  tick(name?: string): number
  look(name?: string): number
  ring: typeof ring
  knit: typeof knit
  range: typeof range
  line: typeof line
  spread: typeof spread
  chord: typeof chord
  scale: typeof scale
  chord_invert: typeof chord_invert
  note: typeof note
  note_range: typeof note_range
  noteToMidi: typeof noteToMidi
  midiToFreq: typeof midiToFreq
  noteToFreq: typeof noteToFreq
}

export function createDSLContext(options: DSLOptions) {
  const { scheduler, fxBridge } = options
  const randoms = new Map<string, SeededRandom>()

  function getRandom(taskId: string): SeededRandom {
    let r = randoms.get(taskId)
    if (!r) {
      r = new SeededRandom(0)
      randoms.set(taskId, r)
    }
    return r
  }

  /**
   * Create a full set of DSL functions bound to a specific task.
   */
  // Per-task tick counters (reset each loop iteration)
  const tickCounters = new Map<string, Map<string, number>>()

  function getTickMap(taskId: string): Map<string, number> {
    let m = tickCounters.get(taskId)
    if (!m) { m = new Map(); tickCounters.set(taskId, m) }
    return m
  }

  let nextNodeRef = 1

  function makeTaskDSL(taskId: string): TaskDSL {
    async function play(note: string | number, opts?: Record<string, number>): Promise<{ nodeId: number }> {
      const task = scheduler.getTask(taskId)!
      const midi = noteToMidi(note)
      const freq = midiToFreq(midi)
      const nodeId = nextNodeRef++
      scheduler.emitEvent({
        type: 'synth',
        taskId,
        virtualTime: task.virtualTime,
        audioTime: task.virtualTime,
        params: { synth: task.currentSynth, note: midi, freq, _nodeRef: nodeId, out_bus: task.outBus, ...opts },
      })
      return { nodeId }
    }

    async function sleep(beats: number): Promise<void> {
      await scheduler.scheduleSleep(taskId, beats)
    }

    async function sample(name: string, opts?: Record<string, number>): Promise<void> {
      const task = scheduler.getTask(taskId)!
      scheduler.emitEvent({
        type: 'sample',
        taskId,
        virtualTime: task.virtualTime,
        audioTime: task.virtualTime,
        params: { name, out_bus: task.outBus, ...opts },
      })
    }

    async function with_fx(
      nameOrOpts: string,
      optsOrFn: Record<string, number> | ((ctx: TaskDSL) => Promise<void>),
      maybeFn?: (ctx: TaskDSL) => Promise<void>
    ): Promise<void> {
      // Handle both: with_fx("reverb", {room: 0.8}, fn) and with_fx("reverb", fn)
      let fxName: string
      let fxOpts: Record<string, number>
      let fn: (ctx: TaskDSL) => Promise<void>

      if (typeof optsOrFn === 'function') {
        fxName = nameOrOpts
        fxOpts = {}
        fn = optsOrFn
      } else {
        fxName = nameOrOpts
        fxOpts = optsOrFn
        fn = maybeFn!
      }

      if (!fxBridge) {
        // No audio bridge available — just execute the block without FX
        await fn(makeTaskDSL(taskId))
        return
      }

      const task = scheduler.getTask(taskId)!
      const prevOutBus = task.outBus
      const newBus = fxBridge.allocateBus()

      // Create FX synth: reads from newBus, writes to prevOutBus
      let fxNodeId: number | undefined
      try {
        fxNodeId = await fxBridge.applyFx(fxName, fxOpts, newBus, prevOutBus)
      } catch {
        // FX SynthDef not available — run block without FX
        fxBridge.freeBus(newBus)
        await fn(makeTaskDSL(taskId))
        return
      }

      // Route all inner synths to the new bus
      task.outBus = newBus

      try {
        await fn(makeTaskDSL(taskId))
      } finally {
        // Restore previous bus routing
        task.outBus = prevOutBus
        fxBridge.freeBus(newBus)
        // Don't free the FX node immediately — let it finish processing
        // scsynth will auto-free when the FX synth's envelope completes
      }
    }

    function control(nodeRef: { nodeId: number }, opts: Record<string, number>): void {
      const task = scheduler.getTask(taskId)!
      scheduler.emitEvent({
        type: 'control',
        taskId,
        virtualTime: task.virtualTime,
        audioTime: task.virtualTime,
        params: { _nodeRef: nodeRef.nodeId, ...opts },
      })
    }

    function cue(name: string, ...args: unknown[]): void {
      scheduler.fireCue(name, taskId, args)
    }

    function sync(name: string): Promise<unknown[]> {
      return scheduler.waitForSync(name, taskId)
    }

    function use_synth(name: string): void {
      scheduler.getTask(taskId)!.currentSynth = name
    }

    function use_bpm(bpm: number): void {
      scheduler.getTask(taskId)!.bpm = bpm
    }

    return {
      play,
      sleep,
      sample,
      cue,
      sync,
      control,
      with_fx: with_fx as TaskDSL['with_fx'],
      use_synth,
      use_bpm,
      rrand: (min: number, max: number) => getRandom(taskId).rrand(min, max),
      rrand_i: (min: number, max: number) => getRandom(taskId).rrand_i(min, max),
      rand: (max: number = 1) => getRandom(taskId).rrand(0, max),
      rand_i: (max: number = 2) => getRandom(taskId).rrand_i(0, max - 1),
      choose: <T>(arr: T[]) => getRandom(taskId).choose(arr),
      dice: (sides: number) => getRandom(taskId).dice(sides),
      one_in: (n: number) => getRandom(taskId).rrand_i(1, n) === 1,
      use_random_seed: (seed: number) => getRandom(taskId).reset(seed),
      tick: (name: string = '__default') => {
        const m = getTickMap(taskId)
        const v = (m.get(name) ?? -1) + 1
        m.set(name, v)
        return v
      },
      look: (name: string = '__default') => {
        return getTickMap(taskId).get(name) ?? 0
      },
      ring,
      knit,
      range,
      line,
      spread,
      chord,
      scale,
      chord_invert,
      note,
      note_range,
      noteToMidi,
      midiToFreq,
      noteToFreq,
    }
  }

  /**
   * Register a live_loop. The user's async function receives task-bound
   * DSL functions, eliminating shared state between concurrent tasks.
   */
  function live_loop(name: string, asyncFn: (ctx: TaskDSL) => Promise<void>): void {
    const taskDSL = makeTaskDSL(name)
    const wrappedFn = async () => {
      // Reset tick counters each iteration (Sonic Pi behavior)
      tickCounters.delete(name)
      await asyncFn(taskDSL)
    }
    scheduler.registerLoop(name, wrappedFn)
  }

  return {
    live_loop,
    ring,
    spread,
    noteToMidi,
    midiToFreq,
    noteToFreq,
    _makeTaskDSL: makeTaskDSL,
    _getRandom: getRandom,
  }
}

export type DSLFunctions = ReturnType<typeof createDSLContext>
