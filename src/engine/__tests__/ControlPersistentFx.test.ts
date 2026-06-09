/**
 * #511 — `control c` inside a TOP-LEVEL `with_fx` block must reach scsynth and
 * target the persistent FX node.
 *
 * Bug (found via illusionist/filtered_dnb, which rendered near-silent on web —
 * RMS 0.003 vs desktop 0.17): the top-level `with_fx` handler
 * (`SonicPiEngine.topLevelWithFx`) executed the block as `fn(null)`, so the
 * block param `|c|` bound to `null`. `control c, …` became `control(null, …)`,
 * and at runtime `nodeRefMap.get(null)` is `undefined` → the control step was
 * silently skipped (guard at `AudioInterpreter` `case 'control'`). The rlpf
 * opened `cutoff: 10` (~13 Hz) and the `control` meant to sweep it open never
 * fired → the filter stayed shut → near-silence.
 *
 *   with_fx :rlpf, cutoff: 10 do |c|
 *     live_loop :dnb do
 *       play 60
 *       sleep 1
 *       control c, cutoff: 100   # opens the filter — was DROPPED on web
 *     end
 *   end
 *
 * The inner `ProgramBuilder.with_fx` path passes `fn(inner, fxRef)` correctly,
 * but loop-wrapping (top-level) `with_fx` uses a separate lazy-`persistentFx`
 * path that dropped the ref and never populated `nodeRefMap` for the FX node.
 *
 * Fix: `topLevelWithFx` mints a negative `fxRef` per `with_fx` and hands it to
 * the block; the persistent-FX creation sites bind `nodeRefMap[fxRef] = nodeId`.
 *
 * Observation: a spy bridge records every `sendTimedControl(time, nodeId, …)`
 * and the node id returned by `applyFx` for the rlpf. The fix is proven when a
 * control fires AND its target nodeId is exactly the rlpf's node — no audio
 * hardware needed; the divergence is pure routing/ref resolution.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

type SchedulerLike = { tick: (t: number) => void }

async function drive(engine: SonicPiEngine, targetVt = 4, steps = 8) {
  const scheduler = (engine as unknown as { scheduler: SchedulerLike | null }).scheduler
  if (!scheduler) return
  for (let i = 1; i <= steps; i++) {
    scheduler.tick((targetVt * i) / steps)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Spy bridge — records the rlpf node id (from applyFx/applyFxOrdered) and every
 * sendTimedControl. A Proxy supplies no-op defaults for the rest of the
 * SuperSonicBridge surface so the engine's create/tick/teardown paths run.
 */
function createSpyBridge() {
  const fxNodes: Array<{ name: string; id: number }> = []
  const controls: Array<{ nodeId: number; params: (string | number)[] }> = []
  let nextNode = 9000
  let nextBus = 16
  const impl: Record<string, unknown> = {
    allocateBus: () => nextBus++,
    createFxGroup: () => nextNode++,
    async applyFx(name: string, _t: number, _p: Record<string, number>, _in: number, _out: number) {
      const id = nextNode++; fxNodes.push({ name, id }); return id
    },
    async applyFxOrdered(name: string, _p: Record<string, number>, _in: number, _out: number) {
      const id = nextNode++; fxNodes.push({ name, id }); return id
    },
    async triggerSynth() { return nextNode++ },
    async playSample() { return nextNode++ },
    async ensureSamplePlaybackDuration() { return 1 },
    sendTimedControl(_time: number, nodeId: number, params: (string | number)[]) {
      controls.push({ nodeId, params })
    },
    get audioContext() { return null },
  }
  const proxy = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop]
      return () => undefined // permissive no-op for the rest of the surface
    },
  })
  return { bridge: proxy, fxNodes, controls }
}

/** Read `params` array [k, v, k, v, …] as a record. */
function paramsToObj(params: (string | number)[]): Record<string, number> {
  const o: Record<string, number> = {}
  for (let i = 0; i + 1 < params.length; i += 2) o[String(params[i])] = Number(params[i + 1])
  return o
}

describe('control inside a top-level with_fx targets the persistent FX node (#511)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('sends /n_set to the rlpf node when the loop calls control c', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const spy = createSpyBridge()
    ;(engine as unknown as { bridge: unknown }).bridge = spy.bridge

    // JS DSL form = exactly what the transpiler emits for the Ruby:
    //   with_fx :rlpf, cutoff: 10 do |c|
    //     live_loop :dnb do; play 60; sleep 1; control c, cutoff: 100; end
    //   end
    const r = await engine.evaluate(`
      with_fx("rlpf", { cutoff: 10 }, (c) => {
        live_loop("dnb", (b) => {
          b.play(60)
          b.sleep(1)
          b.control(c, { cutoff: 100 })
        })
      })
    `)
    expect(r.error).toBeUndefined()
    engine.play()
    await drive(engine, 4, 8)

    // The rlpf FX node was created.
    const rlpf = spy.fxNodes.find((f) => f.name === 'rlpf')
    expect(rlpf).toBeDefined()

    // At least one control fired (pre-fix: ZERO — control(null) was skipped).
    expect(spy.controls.length).toBeGreaterThan(0)

    // Every control targets the rlpf node, and carries the opened cutoff.
    for (const c of spy.controls) {
      expect(c.nodeId).toBe(rlpf!.id)
      expect(paramsToObj(c.params).cutoff).toBe(100)
    }
    engine.dispose()
  })
})
