import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { ProgramBuilder } from '../ProgramBuilder'
import { runProgram, type AudioContext as AudioCtx } from '../interpreters/AudioInterpreter'
import { SoundEventStream } from '../SoundEventStream'

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

function makeAudioCtx(
  scheduler: VirtualTimeScheduler,
  taskId: string,
  eventStream: SoundEventStream,
  nodeRefMap: Map<number, number>,
): AudioCtx {
  return {
    bridge: null,
    scheduler,
    taskId,
    eventStream,
    schedAheadTime: 100,
    nodeRefMap,
    reusableFx: new Map(),
  }
}

describe('sync/cue', () => {
  it('sync waits for cue and inherits virtual time (SV5)', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const soundEvents: import('../SoundEventStream').SoundEvent[] = []
    eventStream.on((e) => soundEvents.push(e))
    const nodeRefMap = new Map<number, number>()

    // Metro loop: sleep 1, cue 'tick', play 60 (proof cue ran), then park
    const metroProgram = new ProgramBuilder(0)
      .sleep(1)
      .cue('tick')
      .play(60)
      .sleep(999999)
      .build()

    scheduler.registerLoop('metro', async () => {
      await runProgram(metroProgram, makeAudioCtx(scheduler, 'metro', eventStream, nodeRefMap))
    })

    // Player loop: sync on 'tick', play 72 (proof sync resolved), then park.
    // Manual builder (no scheduler wired) → sync uses the legacy runtime-step
    // path; call it as a statement since its return type is now a union (SP95d).
    const playerBuilder = new ProgramBuilder(0)
    playerBuilder.sync('tick')
    const playerProgram = playerBuilder.play(72).sleep(999999).build()

    scheduler.registerLoop('player', async () => {
      await runProgram(playerProgram, makeAudioCtx(scheduler, 'player', eventStream, nodeRefMap))
    })

    scheduler.tick(100)
    await flushMicrotasks()

    scheduler.tick(100)
    await flushMicrotasks()

    // Metro played note 60 after cue — proof the cue step executed
    const metroPlay = soundEvents.find(e => e.midiNote === 60 && e.trackId === 'metro')
    expect(metroPlay).toBeDefined()

    // Player played note 72 after sync — proof sync resolved
    const playerPlay = soundEvents.find(e => e.midiNote === 72 && e.trackId === 'player')
    expect(playerPlay).toBeDefined()

    // Player's play happened at VT=1 (inherited from cue source).
    // audioTime = VT + schedAheadTime = 1 + 100 = 101
    expect(playerPlay!.audioTime).toBe(101)
  })

  it('multiple tasks can sync on the same cue', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const soundEvents: import('../SoundEventStream').SoundEvent[] = []
    eventStream.on((e) => soundEvents.push(e))
    const nodeRefMap = new Map<number, number>()

    // Source: sleep 1, cue 'go', park
    const sourceProgram = new ProgramBuilder(0)
      .sleep(1)
      .cue('go')
      .sleep(999999)
      .build()

    scheduler.registerLoop('source', async () => {
      await runProgram(sourceProgram, makeAudioCtx(scheduler, 'source', eventStream, nodeRefMap))
    })

    // Waiter 1: sync on 'go', play 60 (proof), park (legacy runtime-step path)
    const waiter1Builder = new ProgramBuilder(0)
    waiter1Builder.sync('go')
    const waiter1Program = waiter1Builder.play(60).sleep(999999).build()

    scheduler.registerLoop('waiter1', async () => {
      await runProgram(waiter1Program, makeAudioCtx(scheduler, 'waiter1', eventStream, nodeRefMap))
    })

    // Waiter 2: sync on 'go', play 72 (proof), park (legacy runtime-step path)
    const waiter2Builder = new ProgramBuilder(0)
    waiter2Builder.sync('go')
    const waiter2Program = waiter2Builder.play(72).sleep(999999).build()

    scheduler.registerLoop('waiter2', async () => {
      await runProgram(waiter2Program, makeAudioCtx(scheduler, 'waiter2', eventStream, nodeRefMap))
    })

    scheduler.tick(100)
    await flushMicrotasks()

    scheduler.tick(100)
    await flushMicrotasks()

    // Both waiters should have synced (proved by play events emitted after sync)
    const w1Play = soundEvents.find(e => e.midiNote === 60 && e.trackId === 'waiter1')
    const w2Play = soundEvents.find(e => e.midiNote === 72 && e.trackId === 'waiter2')
    expect(w1Play).toBeDefined()
    expect(w2Play).toBeDefined()

    // Both plays happened at VT=1 (inherited from cue source).
    // audioTime = VT + schedAheadTime = 1 + 100 = 101
    expect(w1Play!.audioTime).toBe(101)
    expect(w2Play!.audioTime).toBe(101)
  })

  it('sync does not resolve from a genuinely-PAST cue (lower vt); waits for a fresh one (SV11)', async () => {
    // GAP A2: `sync` resolves over the (t, idPath) event history via get_next —
    // "the next cue strictly AFTER my sync point" (event_history.rb:215). A cue
    // recorded at a LOWER virtual time than the syncer's point is in its PAST, so
    // it is NOT "next" and is NOT delivered — the syncer waits for a future cue.
    // (This is the real SV11 invariant. NB: unlike the pre-A2 web rule, a cue at a
    // HIGHER vt already in history IS the next cue and DOES deliver — faithful
    // find_next; see EventHistory.test.ts ":140 contrived".)
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })

    scheduler.registerLoop('source', async () => {
      await scheduler.scheduleSleep('source', 999999)
    })
    scheduler.tick(100)
    await flushMicrotasks()

    // A cue fires at vt 0 (in the past relative to the syncer below).
    scheduler.getTask('source')!.virtualTime = 0
    scheduler.fireCue('ready', 'source')

    let syncedTime = -1
    scheduler.registerLoop('late', async () => {
      // The syncer is already AHEAD (vt 2.5) when it syncs — the vt-0 cue is past.
      scheduler.getTask('late')!.virtualTime = 2.5
      await scheduler.waitForSync('ready', 'late')
      syncedTime = scheduler.getTask('late')!.virtualTime
      await scheduler.scheduleSleep('late', 999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()

    // The vt-0 cue is in the syncer's past → NOT delivered.
    expect(syncedTime).toBe(-1)

    // A fresh cue strictly after the syncer's point (vt 5) — this one wakes it.
    scheduler.getTask('source')!.virtualTime = 5.0
    scheduler.fireCue('ready', 'source')
    await flushMicrotasks()

    expect(syncedTime).toBe(5.0)
  })

  it('cue passes arguments to sync', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()

    // Note: cue args are handled at the scheduler level (fireCue/waitForSync).
    // The ProgramBuilder.cue() step stores args, and AudioInterpreter passes them
    // to fireCue. However, sync step doesn't capture return value in the program model.
    // So we test cue arg passing at the scheduler level directly.
    let receivedArgs: unknown[] = []

    scheduler.registerLoop('sender', async () => {
      await scheduler.scheduleSleep('sender', 0.5)
      scheduler.fireCue('data', 'sender', [42, 'hello'])
      await scheduler.scheduleSleep('sender', 999999)
    })

    scheduler.registerLoop('receiver', async () => {
      const payload = await scheduler.waitForSync('data', 'receiver')
      receivedArgs = payload.args
      await scheduler.scheduleSleep('receiver', 999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    expect(receivedArgs).toEqual([42, 'hello'])
  })

  it('sync_bpm — fireCue captures cuer\'s task.bpm and sync waiter inherits it', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    scheduler.registerLoop('sender', async () => {
      await scheduler.scheduleSleep('sender', 0.5)
      scheduler.fireCue('beat', 'sender', [])
      await scheduler.scheduleSleep('sender', 999999)
    })
    const senderTask = scheduler.getTask('sender')!
    senderTask.bpm = 140

    let receivedBpm: number | undefined
    scheduler.registerLoop('follower', async () => {
      const result = await scheduler.waitForSync('beat', 'follower')
      receivedBpm = result.bpm
      await scheduler.scheduleSleep('follower', 999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    expect(receivedBpm).toBe(140)
  })

  it('sync_bpm: subsequent sleep in the iteration runs at cuer\'s BPM (#242 observation gate)', async () => {
    // Inference-level test (the next one) proves task.bpm is set; this one
    // proves the user-facing semantic — the sleep AFTER sync_bpm advances
    // virtual time at the cuer's BPM, not the follower's original BPM.
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()

    // Sender at 240 BPM fires a cue at virtualTime 0.5
    scheduler.registerLoop('sender', async () => {
      await scheduler.scheduleSleep('sender', 0.5)
      scheduler.fireCue('beat', 'sender', [])
      await scheduler.scheduleSleep('sender', 999999)
    })
    scheduler.getTask('sender')!.bpm = 240

    // Follower at 60 BPM, sync_bpm pulls to 240, then sleep 1 beat = 0.25s.
    // After the sync wakes and the sleep step registers, task.virtualTime
    // is set by scheduleSleep — observable WITHOUT waiting for the sleep
    // resolve. This is the deterministic measurement point.
    const followerProgram = new ProgramBuilder(0)
      .sync_bpm('beat')
      .sleep(1)
      .sleep(999999)  // park forever after the measurable sleep
      .build()
    scheduler.registerLoop('follower', async () => {
      await runProgram(followerProgram, makeAudioCtx(scheduler, 'follower', eventStream, nodeRefMap))
    })
    scheduler.getTask('follower')!.bpm = 60

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    // Sender's sleep(0.5) at 240 BPM resolves at VT=0.125 (registerLoop's
    // runLoop kickoff is microtask-deferred so my bpm=240 assignment lands
    // before the first scheduleSleep call). Follower inherits VT=0.125.
    // Sleep 1 beat at 240 BPM = 60/240 = 0.25s → final task.virtualTime = 0.375.
    // If the sleep had run at the follower's ORIGINAL 60 BPM, virtualTime would
    // be 0.125 + 1.0 = 1.125 — distinguishable signal.
    expect(scheduler.getTask('follower')!.virtualTime).toBeCloseTo(0.375, 5)
  })

  it('sync step with bpmSync flag mutates task.bpm to cuer\'s bpm after wake', async () => {
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })
    const eventStream = new SoundEventStream()
    const nodeRefMap = new Map<number, number>()

    // Sender at 200 BPM fires a cue
    scheduler.registerLoop('sender', async () => {
      await scheduler.scheduleSleep('sender', 0.1)
      scheduler.fireCue('beat', 'sender', [])
      await scheduler.scheduleSleep('sender', 999999)
    })
    const senderTask = scheduler.getTask('sender')!
    senderTask.bpm = 200

    // Follower starts at 60 BPM, sync_bpm :beat should pull it to 200
    const followerProgram = new ProgramBuilder(0)
      .sync_bpm('beat')
      .play(72)
      .sleep(999999)
      .build()

    scheduler.registerLoop('follower', async () => {
      await runProgram(followerProgram, makeAudioCtx(scheduler, 'follower', eventStream, nodeRefMap))
    })
    const followerTask = scheduler.getTask('follower')!
    followerTask.bpm = 60

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    expect(followerTask.bpm).toBe(200)
  })
})

describe('sync/cue — SP95(d) build-time payload + wake-phase (#350/#351)', () => {
  it('build-time sync returns the cue payload map; e[:val] reads it', async () => {
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    scheduler.registerLoop('receiver', async () => {})
    scheduler.registerLoop('sender', async () => {})
    const receiver = scheduler.getTask('receiver')!
    const sender = scheduler.getTask('sender')!
    receiver.virtualTime = 0

    // Builder wired with scheduler (audio build path) → sync awaits + returns payload.
    const b = new ProgramBuilder(0)
    b.setSyncContext(scheduler, 'receiver')
    const pending = b.sync('beat')
    expect(pending).toBeInstanceOf(Promise)

    // Cue fires strictly later (vt=1) carrying a kwargs payload.
    sender.virtualTime = 1
    scheduler.fireCue('beat', 'sender', [{ val: 64 }])
    const payload = (await pending) as Record<string, unknown>
    // Ruby `e = sync :beat; e[:val]` → e is the kwargs map, e["val"] === 64.
    expect(payload).toEqual({ val: 64 })
    expect(payload['val']).toBe(64)
  })

  it('a freshly-started sync misses a SIMULTANEOUS cue and catches the next (wake-phase, SK15)', async () => {
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    scheduler.registerLoop('receiver', async () => {})
    scheduler.registerLoop('sender', async () => {})
    const receiver = scheduler.getTask('receiver')!
    const sender = scheduler.getTask('sender')!
    receiver.virtualTime = 0

    let resolved: unknown = 'PENDING'
    scheduler.waitForSync('beat', 'receiver').then((p) => { resolved = p })

    // Cue at the SAME virtual instant the receiver registered (vt=0) — desktop's
    // sender fires its first cue before the receiver is ready, so this is missed.
    sender.virtualTime = 0
    scheduler.fireCue('beat', 'sender', [{ val: 60 }])
    await flushMicrotasks()
    expect(resolved).toBe('PENDING') // simultaneous cue NOT delivered

    // Next cue, strictly later (vt=0.5) — this one is caught.
    sender.virtualTime = 0.5
    scheduler.fireCue('beat', 'sender', [{ val: 64 }])
    await flushMicrotasks()
    expect(resolved).toEqual({ args: [{ val: 64 }], bpm: sender.bpm })
  })

  it('the #481 idPath split: at equal vt0 an inline/main waiter CATCHES the cue; a forked-sibling MISSES', async () => {
    // GAP A2 — the #481 fix in miniature. Driver `[0,0]` cues at vt0. A waiter
    // INLINE in main (`[0]`, e.g. with_fx/bare_loop in __run_once) is < the cue's
    // idPath at equal vt, so the cue is STRICTLY GREATER → delivered now (onset 0).
    // A forked-sibling waiter (`[0,1]`, e.g. in_thread) is > the cue's idPath, so
    // the cue is NOT strictly greater → it waits for the next cycle (onset 0.5).
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    scheduler.registerLoop('driver', async () => {}, { idPath: [0, 0] })
    scheduler.registerLoop('mainWaiter', async () => {}, { idPath: [0] })
    scheduler.registerLoop('forkWaiter', async () => {}, { idPath: [0, 1] })
    for (const n of ['driver', 'mainWaiter', 'forkWaiter']) scheduler.getTask(n)!.virtualTime = 0

    // Driver fires its vt0 cue FIRST (it is in history before either waiter syncs)
    // — reproduces the with_fx registration race.
    scheduler.fireCue('tick', 'driver', [{ beat: 0 }])

    let mainRes: unknown = 'PENDING'
    let forkRes: unknown = 'PENDING'
    scheduler.waitForSync('tick', 'mainWaiter').then((p) => { mainRes = p })
    scheduler.waitForSync('tick', 'forkWaiter').then((p) => { forkRes = p })
    await flushMicrotasks()

    // main/inline waiter caught the vt0 cue (history-first getNext finds it).
    expect(mainRes).toEqual({ args: [{ beat: 0 }], bpm: scheduler.getTask('driver')!.bpm })
    // forked sibling missed it — still pending.
    expect(forkRes).toBe('PENDING')
    expect(scheduler.getTask('mainWaiter')!.virtualTime).toBe(0) // inherited the cue's vt0

    // Driver's NEXT cue at vt0.5 — the forked sibling catches this one.
    scheduler.getTask('driver')!.virtualTime = 0.5
    scheduler.fireCue('tick', 'driver', [{ beat: 1 }])
    await flushMicrotasks()
    expect(forkRes).toEqual({ args: [{ beat: 1 }], bpm: scheduler.getTask('driver')!.bpm })
    expect(scheduler.getTask('forkWaiter')!.virtualTime).toBe(0.5)
  })

  it('manual builder sync (no scheduler) keeps the legacy runtime-step path + returns this', () => {
    const b = new ProgramBuilder(0)
    const ret = b.sync('x')
    expect(ret).toBe(b) // chainable; runtime sync STEP, not a Promise
    expect(b.build()).toEqual([{ tag: 'sync', name: 'x' }])
  })

  it('sync_bpm always uses the runtime step (never build-time await), even with scheduler wired', () => {
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    scheduler.registerLoop('r', async () => {})
    const b = new ProgramBuilder(0)
    b.setSyncContext(scheduler, 'r')
    const ret = b.sync_bpm('beat')
    expect(ret).toBe(b)
    expect(b.build()).toEqual([{ tag: 'sync', name: 'beat', bpmSync: true }])
  })

  it('sync inside with_fx stays a runtime-step even when the outer builder is sync-wired — N synced plays interleave, never batch (#490)', () => {
    // #490: `with_fx :reverb { 8.times { sync :tick; synth :saw } }` must spread
    // the saws at the cue cadence, not pile them at one vt. The outer __run_once
    // builder IS sync-wired (top-level `sync; play get(:x)` needs the build-time
    // await), but `with_fx` builds its body through forkBuilder('same-thread'),
    // which deliberately does NOT propagate _syncScheduler/_syncTaskId. So the
    // inner `sync` falls to the RUNTIME-STEP path: it pushes a `{tag:'sync'}`
    // step interleaved with each play, and AudioInterpreter `case 'sync'` blocks
    // on it at interpret time — exactly like desktop's blocking with_fx thread.
    //
    // If forkBuilder were ever "consistency-refactored" to inherit the scheduler,
    // the inner sync would build-await (return a Promise) inside the SYNCHRONOUS
    // with_fx buildFn — un-awaited, dropped — pushing NO sync step and piling the
    // plays. This test catches exactly that regression: the body would collapse
    // to ['play','play','play'] and the assertion below would fail.
    const scheduler = new VirtualTimeScheduler({ getAudioTime: () => 0, schedAheadTime: 100 })
    scheduler.registerLoop('__run_once', async () => {})
    const b = new ProgramBuilder(0)
    b.setSyncContext(scheduler, '__run_once') // build-time-await wiring on the OUTER builder

    b.with_fx('reverb', (inner) => {
      for (let i = 0; i < 3; i++) {
        const ret = inner.sync('tick')
        expect(ret).toBe(inner) // runtime-step path: chainable, NOT a Promise
        inner.play(52, { synth: 'saw' })
      }
      return inner
    })

    const fx = b.build().find((s) => s.tag === 'fx')
    expect(fx).toBeDefined()
    const body = (fx as { body: { tag: string }[] }).body
    // Interleaved runtime steps — proof the syncs were NOT consumed at build time.
    expect(body.map((s) => s.tag)).toEqual(['sync', 'play', 'sync', 'play', 'sync', 'play'])
  })
})
