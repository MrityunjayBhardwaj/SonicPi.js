import { describe, it, expect, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import type { SoundEvent } from '../SoundEventStream'

/**
 * GAP M (#496) — engine-level proof of the path/glob Time State surface that the
 * unified EventHistory now provides. Unit-level matcher + store behaviour is in
 * PathMatcher.test.ts / EventHistoryGlob.test.ts; these drive the real
 * DSL → transpile → builder → EventHistory path.
 */
type SchedulerLike = { tick: (t: number) => void }

async function drive(engine: SonicPiEngine, targetVt = 5, steps = 5) {
  const scheduler = (engine as unknown as { scheduler: SchedulerLike | null }).scheduler
  if (!scheduler) return
  for (let i = 1; i <= steps; i++) {
    scheduler.tick((targetVt * i) / steps)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const notes = (events: SoundEvent[]) =>
  events.filter((e) => typeof e.midiNote === 'number').map((e) => e.midiNote as number)

describe('GAP M — hierarchical path Time State (set/get)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('an absolute path key round-trips through set/get', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
      set "/synth/lead", 60
      play get("/synth/lead")
    `)
    engine.play()
    await drive(engine, 2, 2)

    expect(notes(events)).toContain(60)
    engine.dispose()
  })

  it('a path glob read resolves a matching absolute set', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    await engine.evaluate(`
      set "/synth/lead", 64
      play get("/synth/*")
    `)
    engine.play()
    await drive(engine, 2, 2)

    expect(notes(events)).toContain(64)
    engine.dispose()
  })

  it('a symbol get sees a symbol set (the /{cue,set,live_loop} read union)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    // set :foo writes /set/foo; get :foo reads /{cue,set,live_loop}/foo and finds it.
    await engine.evaluate(`
      set :foo, 67
      play get(:foo)
    `)
    engine.play()
    await drive(engine, 2, 2)

    expect(notes(events)).toContain(67)
    engine.dispose()
  })
})

describe('GAP M2 — sync arg_matcher (value predicate)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('a sync with arg_matcher wakes only on a cue whose value passes', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const events: SoundEvent[] = []
    engine.components.streaming!.eventStream.on((e) => events.push(e))

    // driver cues :beat with value 9; listener only wakes when arg[0] == 9.
    await engine.evaluate(`
      live_loop :driver do
        cue :beat, 9
        sleep 1
      end
      live_loop :listener do
        sync :beat, arg_matcher: ->(a){ a[0] == 9 }
        play 72
        sleep 1
      end
    `)
    engine.play()
    await drive(engine, 4, 4)

    expect(notes(events)).toContain(72)
    engine.dispose()
  })
})
