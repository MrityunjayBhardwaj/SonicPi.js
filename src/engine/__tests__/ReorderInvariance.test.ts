/**
 * Loop-declaration-order parity with desktop (SV47 Slice 3 / #400 — GAP A2).
 *
 * WHAT THIS PROVES: our engine now matches desktop's declaration-order
 * DEPENDENCE via the `(t, idPath)` total order (EventHistory, a port of
 * `event_history.rb`). director-first → {55, 59}; player-first → {52, 57}.
 *
 * Root (grounded ×3, 2026-05-28; ported 2026-06-06): desktop `get`/`sync` resolve
 * over the full CueEvent total order; at equal virtual time the thread-id path
 * `i` (assigned at thread spawn = declaration order, runtime.rb:1071-1074) breaks
 * the tie. The first-declared live_loop gets idPath [0,0], the second [0,1].
 *  - director-first: director [0,0] writes :root; player [0,1] reads at the
 *    equal cue vt. (vt,[0,0]) ≤ (vt,[0,1]) → the write IS visible → {55,59}.
 *  - player-first: player [0,0] reads; director [0,1] writes. (vt,[0,1]) is
 *    GREATER than (vt,[0,0]) → NOT yet visible → player reads the PRIOR ring
 *    value → {52,57}.
 *
 * This REPLACES the prior "web self-consistency" assertion (both {55,59}), which
 * was the documented Slice-3 divergence — now closed. No ε is relaxed; the flip
 * is structural (the idPath axis), falsifiable, and ε-insensitive (SP126/SV61).
 *
 * Companion Level-3 reproducers: /tmp/s8/r1_director_section.rb (normal {55,59})
 * + /tmp/s8/r1_director_section_reversed.rb (reversed {52,57} = desktop).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { SoundEvent } from '../SoundEventStream'

type SchedulerLike = { tick: (t: number) => void }

async function drive(engine: SonicPiEngine, targetVt = 6, steps = 6) {
  const scheduler = (engine as unknown as { scheduler: SchedulerLike | null }).scheduler
  if (!scheduler) return
  for (let i = 1; i <= steps; i++) {
    scheduler.tick((targetVt * i) / steps)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const DIRECTOR_FIRST = `
  use_bpm 120
  live_loop :director do
    set :root, (ring 52, 55, 57, 59).tick
    sleep 1
  end
  live_loop :player do
    sync :director
    play get(:root), release: 0.4
    sleep 1
  end
`

const PLAYER_FIRST = `
  use_bpm 120
  live_loop :player do
    sync :director
    play get(:root), release: 0.4
    sleep 1
  end
  live_loop :director do
    set :root, (ring 52, 55, 57, 59).tick
    sleep 1
  end
`

async function playerPrefix(src: string, n = 2): Promise<number[]> {
  delete (globalThis as Record<string, unknown>).SuperSonic
  const engine = new SonicPiEngine()
  await engine.init()
  const events: SoundEvent[] = []
  engine.components.streaming!.eventStream.on((e) => events.push(e))
  await engine.evaluate(src)
  engine.play()
  await drive(engine, 6, 6)
  const notes = events
    .filter((e) => typeof e.midiNote === 'number' && e.trackId === 'player')
    .map((e) => e.midiNote as number)
  engine.dispose()
  return notes.slice(0, n)
}

describe('Loop reorder parity with desktop (SV47 Slice 3 / #400)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('declaration order determines the read: director-first {55,59}, player-first {52,57}', async () => {
    const a = await playerPrefix(DIRECTOR_FIRST, 2)
    const b = await playerPrefix(PLAYER_FIRST, 2)
    // director-first: director [0,0] write ≤ player [0,1] read → visible → {55,59}.
    expect(a).toEqual([55, 59])
    // player-first: director [0,1] write > player [0,0] read → not yet visible →
    // reads prior ring value → {52,57}. Desktop parity (was a divergence).
    expect(b).toEqual([52, 57])
    // The two prefixes now DIVERGE by source order — the (t, idPath) total order
    // reproduces desktop's declaration-order dependence (no longer self-consistent).
    expect(b).not.toEqual(a)
  })
})
