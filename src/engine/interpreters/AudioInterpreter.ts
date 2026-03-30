/**
 * AudioInterpreter — runs a Program against real audio.
 *
 * The only interpreter that touches SuperSonic and the scheduler.
 * Walks the step array, triggers synths/samples, awaits sleep via
 * the VirtualTimeScheduler.
 */

import type { Program } from '../Program'

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
        const audioTime = task.virtualTime + ctx.schedAheadTime
        const synth = step.synth ?? currentSynth
        const nodeRef = nextNodeRef++

        if (ctx.bridge) {
          const params: Record<string, number> = { ...step.opts, note: step.note }
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
        const audioTime = task.virtualTime + ctx.schedAheadTime
        if (ctx.bridge) {
          ctx.bridge.playSample(step.name, audioTime, step.opts, currentBpm)
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
          const paramList: (string | number)[] = []
          for (const [k, v] of Object.entries(step.params)) {
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
        let fxNodeId: number | undefined
        try {
          const audioTime = task.virtualTime + ctx.schedAheadTime
          fxNodeId = await ctx.bridge.applyFx(step.name, audioTime, step.opts, newBus, prevOutBus)
          // Store FX node ID so control() can target it via nodeRefMap
          if (step.nodeRef && fxNodeId !== undefined) {
            ctx.nodeRefMap.set(step.nodeRef, fxNodeId)
          }
          task.outBus = newBus
          await runProgram(step.body, ctx)
        } finally {
          task.outBus = prevOutBus
          // Free FX node after kill_delay — lets reverb/echo tails decay naturally.
          // Sonic Pi uses a GC thread with Kernel.sleep(kill_delay) before group.kill(true).
          // Default kill_delay: 1 second (matches Sonic Pi's default of 1 beat at 60 BPM).
          const killDelay = (step.opts.kill_delay as number) ?? 1.0
          if (fxNodeId !== undefined) {
            setTimeout(() => {
              ctx.bridge!.freeNode(fxNodeId!)
              ctx.bridge!.freeBus(newBus)
            }, killDelay * 1000)
          } else {
            ctx.bridge.freeBus(newBus)
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
        if (task) task.running = false
        return
    }
  }
}
