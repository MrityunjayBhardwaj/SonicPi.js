/**
 * #557 — `control p, …` on a RUNNING SYNTH node (not an FX node) must reach
 * scsynth and target THIS iteration's live synth.
 *
 * Symptom (found via fm_noise, which "sounds like a static piano, not FM" on
 * web — user's ears): a `control p, divisor: X` change to a running :fm synth
 * is inaudible on web while desktop applies it (exp-019: web with-ctrl vs
 * no-ctrl spectral cosine 0.97 = IGNORED; desktop 0.14 = applied).
 *
 * Root cause (proven via the live OSC log, not this harness — see below): the
 * play case bound nodeRefMap via the ASYNC `.then` on triggerSynth, a microtask
 * that runs only AFTER the iteration's synchronous steps. So a same-iteration
 * `control` (fm_noise has NO sleep between play and control) read either an
 * empty map (iteration 1 → /n_set dropped) or the PREVIOUS iteration's
 * already-freed node (iteration N → /n_set to a dead node). Real web OSC log:
 *   [t:2.97] /s_new sonic-pi-fm 11003 …   (iter 1 synth)
 *   [t:8.97] /s_new sonic-pi-fm 11004 …   (iter 2 synth)
 *   [t:8.97] /n_set 11003 {divisor: 30}   ← targets 11003 (freed), not 11004
 * Fix: reserve the node id synchronously (bridge.reserveNodeId) and bind
 * nodeRefMap BEFORE the next step runs, so control resolves the live node.
 *
 * NB: a fake-scheduler unit test cannot reproduce the browser's exact
 * microtask timing (the drive loop's awaits flush the .then early), so the
 * DECISIVE regression evidence is the Level-2 OSC capture + Level-3 audio A/B
 * (web ctrl vs no-ctrl spectral cosine drops from 1.0000). This test guards the
 * SYNC-BINDING CONTRACT: with a reserveNodeId-capable bridge, every control
 * targets a node that was reserved THIS run and carries the controlled value.
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
 * Spy bridge modelling the real SuperSonicBridge's #557 contract: reserveNodeId
 * hands out the id synchronously and triggerSynth honours that pre-reserved id
 * for its /s_new. Records every synth id and every sendTimedControl target.
 */
function createSpyBridge() {
  const synths: Array<{ id: number; params: Record<string, number> }> = []
  const samples: Array<{ id: number; name: string }> = []
  const controls: Array<{ nodeId: number; params: (string | number)[] }> = []
  let nextNode = 9000
  let nextBus = 16
  const impl: Record<string, unknown> = {
    allocateBus: () => nextBus++,
    createFxGroup: () => nextNode++,
    async applyFxOrdered() { return nextNode++ },
    reserveNodeId: () => nextNode++,
    async triggerSynth(_name: string, _t: number, params: Record<string, number>, nodeId?: number) {
      const id = nodeId ?? nextNode++
      synths.push({ id, params: { ...params } })
      return id
    },
    async playSample(name: string, _t: number, _o?: Record<string, number>, _b?: number, nodeId?: number) {
      const id = nodeId ?? nextNode++
      samples.push({ id, name })
      return id
    },
    async ensureSamplePlaybackDuration() { return 1 },
    sendTimedControl(_time: number, nodeId: number, params: (string | number)[]) {
      controls.push({ nodeId, params })
    },
    freeNode() { /* no-op */ },
    get audioContext() { return null },
  }
  const proxy = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop]
      return () => undefined
    },
  })
  return { bridge: proxy, synths, samples, controls }
}

function paramsToObj(params: (string | number)[]): Record<string, number> {
  const o: Record<string, number> = {}
  for (let i = 0; i + 1 < params.length; i += 2) o[String(params[i])] = Number(params[i + 1])
  return o
}

describe('control of a running synth targets a live node (#557)', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).SuperSonic
  })

  it('every /n_set targets a synth reserved this run, carrying the controlled value (fm_noise shape)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const spy = createSpyBridge()
    ;(engine as unknown as { bridge: unknown }).bridge = spy.bridge

    // The transpiler emits `__b.play(...); p = __b.lastRef` for the in-loop
    // `p = play …`, then `__b.control(p, …)`. Same shape as fm_noise's sci_fi
    // loop: control immediately after play, NO sleep between.
    const r = await engine.evaluate(`use_synth :fm
live_loop :sci_fi do
  p = play 60, divisor: 1, depth: 2, sustain: 0.4, release: 0.1, amp: 0.7
  control p, divisor: 30
  sleep 1
end`)
    expect(r.error).toBeUndefined()
    engine.play()
    await drive(engine, 4, 8)

    expect(spy.synths.length).toBeGreaterThan(1)
    expect(spy.controls.length).toBeGreaterThan(0)

    // Every control targets a node that is actually a synth this run (never a
    // stale id from outside the run), and carries divisor: 30.
    const synthIds = new Set(spy.synths.map((s) => s.id))
    for (const c of spy.controls) {
      expect(synthIds.has(c.nodeId)).toBe(true)
      expect(paramsToObj(c.params).divisor).toBe(30)
    }
    engine.dispose()
  })

  it('top-level `p = play; control p` also resolves a ref (transpiler lastRef capture)', async () => {
    // Documents the second, distinct manifestation: at top level (NOT inside a
    // loop) the transpiler must still capture lastRef so `control p` gets a
    // numeric ref rather than the builder object (which never resolves in
    // nodeRefMap → control silently dropped). See TreeSitterTranspiler.
    const engine = new SonicPiEngine()
    await engine.init()
    const spy = createSpyBridge()
    ;(engine as unknown as { bridge: unknown }).bridge = spy.bridge
    const r = await engine.evaluate(`use_synth :fm
p = play 60, divisor: 1, depth: 2, sustain: 4, release: 0.5, amp: 0.7
control p, divisor: 30
sleep 7`)
    expect(r.error).toBeUndefined()
    engine.play()
    await drive(engine, 8, 16)

    expect(spy.synths.length).toBe(1)
    // The control must reach the one synth that was triggered.
    expect(spy.controls.length).toBeGreaterThan(0)
    expect(spy.controls.every((c) => c.nodeId === spy.synths[0].id)).toBe(true)
    expect(paramsToObj(spy.controls[0].params).divisor).toBe(30)
    engine.dispose()
  })

  it('control of a running SAMPLE targets the live sample node (#559)', async () => {
    // `s = sample …; control s, rate: 2` must reach the sample's scsynth node.
    // Pre-fix: `ProgramBuilder.sample` never set `_lastRef` and the sample
    // dispatch never bound `nodeRefMap` → control(s) resolved nothing → dropped.
    const engine = new SonicPiEngine()
    await engine.init()
    const spy = createSpyBridge()
    ;(engine as unknown as { bridge: unknown }).bridge = spy.bridge
    const r = await engine.evaluate(`live_loop :s do
  s = sample :loop_amen, rate: 1, sustain: 4
  control s, rate: 2
  sleep 1
end`)
    expect(r.error).toBeUndefined()
    engine.play()
    await drive(engine, 4, 8)

    expect(spy.samples.length).toBeGreaterThan(1)
    expect(spy.controls.length).toBeGreaterThan(0)
    // Every control targets a node that is actually a sample this run.
    const sampleIds = new Set(spy.samples.map((s) => s.id))
    for (const c of spy.controls) {
      expect(sampleIds.has(c.nodeId)).toBe(true)
      expect(paramsToObj(c.params).rate).toBe(2)
    }
    engine.dispose()
  })

  it('control p resolves when a with_fx precedes the controlled play (#560)', async () => {
    // Pre-fix: the builder counted `with_fx` in its ref namespace but the
    // interpreter's play-only counter did not → `control p` after a fx
    // resolved a non-existent ref → DROPPED. Build-time refs (one namespace
    // shared with fx) fix the drift.
    const engine = new SonicPiEngine()
    await engine.init()
    const spy = createSpyBridge()
    ;(engine as unknown as { bridge: unknown }).bridge = spy.bridge
    const r = await engine.evaluate(`play 60
with_fx :reverb do
  play 70
end
p = play 62, sustain: 4
control p, amp: 0.1
sleep 4`)
    expect(r.error).toBeUndefined()
    engine.play()
    await drive(engine, 4, 8)

    // Three synths (60, 70-inside-fx, 62); the control targets the n62 play.
    const n62 = spy.synths.find((s) => s.params.note === 62)
    expect(n62).toBeDefined()
    expect(spy.controls.length).toBeGreaterThan(0)
    expect(spy.controls.every((c) => c.nodeId === n62!.id)).toBe(true)
    expect(paramsToObj(spy.controls[0].params).amp).toBe(0.1)
    engine.dispose()
  })
})
