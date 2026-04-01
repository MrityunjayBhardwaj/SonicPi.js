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

    // Player loop: sync on 'tick', play 72 (proof sync resolved), then park
    const playerProgram = new ProgramBuilder(0)
      .sync('tick')
      .play(72)
      .sleep(999999)
      .build()

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

    // Waiter 1: sync on 'go', play 60 (proof), park
    const waiter1Program = new ProgramBuilder(0)
      .sync('go')
      .play(60)
      .sleep(999999)
      .build()

    scheduler.registerLoop('waiter1', async () => {
      await runProgram(waiter1Program, makeAudioCtx(scheduler, 'waiter1', eventStream, nodeRefMap))
    })

    // Waiter 2: sync on 'go', play 72 (proof), park
    const waiter2Program = new ProgramBuilder(0)
      .sync('go')
      .play(72)
      .sleep(999999)
      .build()

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

  it('sync waits for fresh cue, does not resolve from stale cueMap', async () => {
    // In Sonic Pi, sync always waits for a FRESH cue — never resolves from stale ones.
    // This prevents synced loops from starting at vt=0 when the sync target's
    // auto-cue fires before the synced loop calls waitForSync.
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
    })

    scheduler.registerLoop('source', async () => {
      await scheduler.scheduleSleep('source', 999999)
    })
    scheduler.tick(100)
    await flushMicrotasks()

    scheduler.getTask('source')!.virtualTime = 2.5
    scheduler.fireCue('ready', 'source')

    let syncedTime = -1
    scheduler.registerLoop('late', async () => {
      const args = await scheduler.waitForSync('ready', 'late')
      syncedTime = scheduler.getTask('late')!.virtualTime
      await scheduler.scheduleSleep('late', 999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()

    // sync should NOT have resolved yet — cue was stale
    expect(syncedTime).toBe(-1)

    // Now fire a fresh cue — this should wake the synced loop
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
      receivedArgs = await scheduler.waitForSync('data', 'receiver')
      await scheduler.scheduleSleep('receiver', 999999)
    })

    scheduler.tick(100)
    await flushMicrotasks()
    scheduler.tick(100)
    await flushMicrotasks()

    expect(receivedArgs).toEqual([42, 'hello'])
  })
})
