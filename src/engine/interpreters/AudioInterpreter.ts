/**
 * AudioInterpreter — runs a Program against real audio.
 *
 * The only interpreter that touches SuperSonic and the scheduler.
 * Walks the step array, triggers synths/samples, awaits sleep via
 * the VirtualTimeScheduler.
 */

import type { Program } from '../Program'
import { normalizePlayParams, normalizeControlParams, normalizeFxParams } from '../SoundLayer'

/** Visual duration used for note events in the sound event stream (seconds). */
const NOTE_EVENT_VISUAL_DURATION = 0.25
/** Visual duration used for sample events in the sound event stream (seconds). */
const SAMPLE_EVENT_VISUAL_DURATION = 0.5
import type { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import type { SuperSonicBridge } from '../SuperSonicBridge'
import type { SoundEventStream, SoundEvent } from '../SoundEventStream'

export interface AudioContext {
  bridge: SuperSonicBridge | null
  scheduler: VirtualTimeScheduler
  taskId: string
  eventStream: SoundEventStream
  schedAheadTime: number
  printHandler?: (msg: string) => void
  nodeRefMap: Map<number, number>
}

/**
 * Run a Program's steps for one loop iteration.
 * Called by the scheduler's loop runner.
 */
export async function runProgram(
  program: Program,
  ctx: AudioContext
): Promise<void> {
  let currentSynth = 'beep'
  let currentBpm = ctx.scheduler.getTask(ctx.taskId)?.bpm ?? 60
  let nextNodeRef = 1

  for (const step of program) {
    const task = ctx.scheduler.getTask(ctx.taskId)
    if (!task?.running) break

    switch (step.tag) {
      case 'play': {
        // Sonic Pi's should_trigger?: skip if on: is present and falsy
        if ('on' in step.opts && !step.opts.on) break

        const audioTime = task.virtualTime + ctx.schedAheadTime
        const synth = step.synth ?? currentSynth
        const nodeRef = nextNodeRef++

        if (ctx.bridge) {
          const rawParams: Record<string, number> = { ...step.opts, note: step.note }
          const params = normalizePlayParams(synth, rawParams, currentBpm)
          ctx.bridge.triggerSynth(synth, audioTime, { ...params, out_bus: task.outBus })
            .then(realNodeId => ctx.nodeRefMap.set(nodeRef, realNodeId))
            .catch((err: Error) => {
              ctx.printHandler?.(`Synth '${synth}' failed: ${err.message}`)
            })
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
          ctx.bridge.playSample(step.name, audioTime, sampleOpts, currentBpm)
            .catch((err: Error) => {
              ctx.printHandler?.(`Sample '${step.name}' failed: ${err.message}`)
            })
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

      case 'useSynth':
        currentSynth = step.name
        if (task) task.currentSynth = step.name
        break

      case 'useBpm':
        currentBpm = step.bpm
        if (task) task.bpm = step.bpm
        break

      case 'control': {
        const realNodeId = ctx.nodeRefMap.get(step.nodeRef)
        if (realNodeId && ctx.bridge) {
          const audioTime = task.virtualTime + ctx.schedAheadTime
          const normalized = normalizeControlParams(step.params, currentBpm)
          const paramList: (string | number)[] = []
          for (const [k, v] of Object.entries(normalized)) {
            paramList.push(k, v)
          }
          ctx.bridge.sendTimedControl(audioTime, realNodeId, paramList)
        }
        break
      }

      case 'cue':
        ctx.scheduler.fireCue(step.name, ctx.taskId, step.args ?? [])
        break

      case 'sync':
        ctx.bridge?.flushMessages()
        await ctx.scheduler.waitForSync(step.name, ctx.taskId)
        break

      case 'fx': {
        if (!ctx.bridge) {
          // No audio — just run inner program
          await runProgram(step.body, ctx)
          break
        }
        const prevOutBus = task.outBus
        const newBus = ctx.bridge.allocateBus()
        // Create container group for this FX chain — matches Sonic Pi's fx_container_group.
        // All FX nodes + inner synths live inside this group.
        // On cleanup, killing the group atomically frees everything.
        const fxGroupId = ctx.bridge.createFxGroup()
        let fxNodeId: number | undefined
        try {
          const audioTime = task.virtualTime + ctx.schedAheadTime
          const fxOpts = normalizeFxParams(step.opts)
          fxNodeId = await ctx.bridge.applyFx(step.name, audioTime, fxOpts, newBus, prevOutBus)
          if (step.nodeRef && fxNodeId !== undefined) {
            ctx.nodeRefMap.set(step.nodeRef, fxNodeId)
          }
          task.outBus = newBus
          // Flush FX creation message before running inner program
          ctx.bridge.flushMessages()
          await runProgram(step.body, ctx)
        } finally {
          task.outBus = prevOutBus
          // Flush any remaining inner messages
          ctx.bridge.flushMessages()
          // Kill FX container group after kill_delay — lets tails decay.
          // Matches Sonic Pi: Kernel.sleep(kill_delay) then fx_container_group.kill(true)
          const killDelay = (step.opts.kill_delay as number) ?? 1.0
          setTimeout(() => {
            ctx.bridge!.freeGroup(fxGroupId)
            ctx.bridge!.freeBus(newBus)
          }, killDelay * 1000)
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
        })
        break
      }

      case 'liveAudio': {
        if (ctx.bridge) {
          ctx.bridge.startLiveAudio(step.name, { stereo: !!step.opts.stereo })
            .catch((err: Error) => ctx.printHandler?.(`live_audio failed: ${err.message}`))
        }
        break
      }

      case 'print':
        ctx.printHandler?.(step.message)
        break

      case 'stop':
        ctx.bridge?.flushMessages()
        if (task) task.running = false
        return
    }
  }
  // Flush any remaining queued messages at end of program
  ctx.bridge?.flushMessages()
}
