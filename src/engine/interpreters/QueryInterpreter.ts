/**
 * QueryInterpreter — instant O(n) query of a Program.
 *
 * Walks the step array, accumulates time via sleep steps,
 * collects events that fall within [begin, end).
 * No scheduler, no Promises, no re-execution.
 *
 * For repeating loops: tile the program across the time range.
 */

import type { Program, Step } from '../Program'

export interface QueryEvent {
  type: 'synth' | 'sample'
  time: number
  duration: number
  params: Record<string, unknown>
}

/**
 * Query a single iteration of a Program for events in [begin, end).
 * Returns events sorted by time.
 */
export function queryProgram(
  program: Program,
  begin: number,
  end: number,
  bpm: number,
  startTime: number = 0
): QueryEvent[] {
  const events: QueryEvent[] = []
  let time = startTime
  let currentSynth = 'beep'
  let currentBpm = bpm
  const beatDuration = () => 60 / currentBpm

  for (const step of program) {
    if (time > end) break

    switch (step.tag) {
      case 'play':
        if (time >= begin) {
          events.push({
            type: 'synth',
            time,
            duration: (step.opts.release ?? 0.25) * beatDuration(),
            params: { synth: step.synth ?? currentSynth, note: step.note, ...step.opts },
          })
        }
        break

      case 'sample':
        if (time >= begin) {
          events.push({
            type: 'sample',
            time,
            duration: 1, // approximate — real duration depends on sample file
            params: { name: step.name, ...step.opts },
          })
        }
        break

      case 'sleep':
        time += step.beats * beatDuration()
        break

      case 'useSynth':
        currentSynth = step.name
        break

      case 'useBpm':
        currentBpm = step.bpm
        break

      case 'fx': {
        // Walk the sub-program
        const fxEvents = queryProgram(step.body, begin, end, currentBpm, time)
        events.push(...fxEvents)
        // Advance time by the sub-program's total duration (recursive, handles nested FX + BPM)
        time += programDuration(step.body, currentBpm)
        break
      }

      case 'thread': {
        // Thread starts at current time, runs in parallel
        const threadEvents = queryProgram(step.body, begin, end, currentBpm, time)
        events.push(...threadEvents)
        // Thread does NOT advance parent time (fire-and-forget)
        break
      }

      case 'stop':
        return events // halt here

      // sync, cue, control, print — no time effect for query
    }
  }

  return events
}

/**
 * Calculate total duration of a Program in seconds.
 * Handles nested FX bodies and BPM changes recursively.
 */
function programDuration(program: Program, bpm: number): number {
  let dur = 0
  let currentBpm = bpm
  for (const step of program) {
    if (step.tag === 'sleep') dur += step.beats * (60 / currentBpm)
    if (step.tag === 'useBpm') currentBpm = step.bpm
    if (step.tag === 'fx') dur += programDuration(step.body, currentBpm)
    // threads are parallel — don't add to parent duration
  }
  return dur
}

/**
 * Query a looping Program across a time range.
 * Tiles the program's duration to cover [begin, end).
 */
export function queryLoopProgram(
  program: Program,
  begin: number,
  end: number,
  bpm: number
): QueryEvent[] {
  const iterDuration = programDuration(program, bpm)
  if (iterDuration <= 0) return [] // no sleep = infinite loop, can't tile

  const events: QueryEvent[] = []
  const firstIter = Math.floor(begin / iterDuration)
  const lastIter = Math.ceil(end / iterDuration)

  for (let i = firstIter; i <= lastIter; i++) {
    const iterStart = i * iterDuration
    const iterEvents = queryProgram(program, begin, end, bpm, iterStart)
    events.push(...iterEvents)
  }

  return events.sort((a, b) => a.time - b.time)
}

/**
 * Capture all events from a Program up to a duration.
 * One-liner replacement for CaptureScheduler.
 */
export function captureAll(
  program: Program,
  duration: number,
  bpm: number
): QueryEvent[] {
  return queryLoopProgram(program, 0, duration, bpm)
}
