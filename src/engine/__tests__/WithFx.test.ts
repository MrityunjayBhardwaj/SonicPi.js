import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler, type SchedulerEvent } from '../VirtualTimeScheduler'
import { createDSLContext, type FxBridge } from '../DSLContext'
import { autoTranspile } from '../RubyTranspiler'
import { transpile, createExecutor } from '../Transpiler'

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

function createMockFxBridge(): FxBridge & { calls: string[] } {
  let nextBus = 16
  let nextNode = 5000
  const calls: string[] = []
  return {
    calls,
    allocateBus() { const b = nextBus++; calls.push(`alloc:${b}`); return b },
    freeBus(n) { calls.push(`free:${n}`) },
    async applyFx(name, params, inBus, outBus) {
      const id = nextNode++
      calls.push(`fx:${name}:in${inBus}:out${outBus}`)
      return id
    },
    freeNode(id) { calls.push(`freeNode:${id}`) },
  }
}

describe('with_fx', () => {
  it('allocates bus, creates FX, routes synths, restores bus', async () => {
    const events: SchedulerEvent[] = []
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    scheduler.onEvent((e) => events.push(e))
    const bridge = createMockFxBridge()
    const dsl = createDSLContext({ scheduler, fxBridge: bridge })

    dsl.live_loop('test', async (ctx) => {
      await ctx.with_fx('reverb', { room: 0.8 }, async (ctx) => {
        await ctx.play(60)
        await ctx.sleep(0.5)
      })
      await ctx.play(72) // after FX block — should be on bus 0
      await ctx.sleep(999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // FX bridge should have been called
    expect(bridge.calls).toContain('alloc:16')
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    expect(bridge.calls).toContain('free:16')

    // Synth inside FX block should route to bus 16
    const insideFx = events.find(e => e.type === 'synth' && e.params.note === 60)
    expect(insideFx).toBeDefined()
    expect(insideFx!.params.out_bus).toBe(16)

    // Synth after FX block should route to bus 0
    const afterFx = events.find(e => e.type === 'synth' && e.params.note === 72)
    expect(afterFx).toBeDefined()
    expect(afterFx!.params.out_bus).toBe(0)
  })

  it('nested FX chains buses correctly', async () => {
    const events: SchedulerEvent[] = []
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    scheduler.onEvent((e) => events.push(e))
    const bridge = createMockFxBridge()
    const dsl = createDSLContext({ scheduler, fxBridge: bridge })

    dsl.live_loop('test', async (ctx) => {
      await ctx.with_fx('reverb', async (ctx) => {
        await ctx.with_fx('echo', async (ctx) => {
          await ctx.play(60)
          await ctx.sleep(999999)
        })
      })
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // Outer FX: bus 16 → bus 0
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    // Inner FX: bus 17 → bus 16
    expect(bridge.calls).toContain('fx:echo:in17:out16')

    // Play inside inner FX should route to bus 17
    const innerPlay = events.find(e => e.type === 'synth' && e.params.note === 60)
    expect(innerPlay).toBeDefined()
    expect(innerPlay!.params.out_bus).toBe(17)
  })

  it('works without FX bridge (graceful fallback)', async () => {
    const events: SchedulerEvent[] = []
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    scheduler.onEvent((e) => events.push(e))
    // No fxBridge
    const dsl = createDSLContext({ scheduler })

    dsl.live_loop('test', async (ctx) => {
      await ctx.with_fx('reverb', async (ctx) => {
        await ctx.play(60)
        await ctx.sleep(999999)
      })
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // Play still works, just no FX routing
    const play = events.find(e => e.type === 'synth' && e.params.note === 60)
    expect(play).toBeDefined()
  })

  it('transpiled Ruby with_fx runs correctly', async () => {
    const events: SchedulerEvent[] = []
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    scheduler.onEvent((e) => events.push(e))
    const bridge = createMockFxBridge()
    const dsl = createDSLContext({ scheduler, fxBridge: bridge })

    const ruby = `live_loop :test do
  with_fx :reverb, room: 0.9 do
    play 60
    sleep 0.5
  end
  sleep 999999
end`

    const jsCode = autoTranspile(ruby)
    const { code: transpiledCode } = transpile(jsCode)
    const executor = createExecutor(transpiledCode, ['live_loop'])
    await executor(dsl.live_loop)

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    expect(bridge.calls).toContain('alloc:16')
    expect(bridge.calls).toContain('fx:reverb:in16:out0')
    expect(events.find(e => e.params.note === 60)).toBeDefined()
  })
})
