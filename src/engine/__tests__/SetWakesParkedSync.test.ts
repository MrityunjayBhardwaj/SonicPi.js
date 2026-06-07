import { describe, it, expect } from 'vitest'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { EventHistory, TimeStateView } from '../EventHistory'
import { ProgramBuilder } from '../ProgramBuilder'
import { toWritePath } from '../PathMatcher'

/**
 * #498 task 1 — a LIVE `set` must wake an already-parked `sync`.
 *
 * Desktop's `EventHistory.set` runs `@event_matchers.match(ce)` after every
 * insert (event_history.rb:204), so a `set` that fires while a `sync` is already
 * parked wakes it — not only the set-before-sync case the history-first scan
 * covers. Pre-#498 our `set` eager-wrote to the shared store but never ran the
 * match, so a parked syncer stayed parked forever (only `cue`/`live_loop`
 * heartbeats via fireCue ran the wake loop).
 */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('#498 — a live set wakes an already-parked sync', () => {
  it('notifySet wakes a syncer that parked before the set fired (insert alone does not)', async () => {
    const eventHistory = new EventHistory({ maxPerKey: 256 })
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
      eventHistory,
    })

    let woke = false
    let payload: { args: unknown[]; bpm: number } | null = null
    scheduler.registerLoop('waiter', async () => {
      payload = await scheduler.waitForSync('foo', 'waiter')
      woke = true
    })

    // Release the loop's initial sleep(0) so the waiter runs, finds nothing in
    // history for /{cue,set,live_loop}/foo, and parks.
    scheduler.tick(100)
    await flush()
    expect(woke).toBe(false)

    // Reproduce what ProgramBuilder.set does on the audio path: eager-write the
    // value into the shared store, THEN run the match. The write alone must NOT
    // wake the parked syncer (that is the residual) ...
    eventHistory.insert(toWritePath('foo', 'set'), 1, [0, 1], 99)
    await flush()
    expect(woke).toBe(false)

    // ... and notifySet (the fix) does.
    scheduler.notifySet('foo', 1, [0, 1], 99)
    await flush()
    expect(woke).toBe(true)
    // set→sync resolves with the history-first shape: a raw set value yields
    // {args: undefined} (set-value retrieval is a separate, pre-existing gap).
    expect(payload).not.toBeNull()
  })

  it('ProgramBuilder.set wires notifySet end-to-end (a wired setter builder wakes a parked sync)', async () => {
    const eventHistory = new EventHistory({ maxPerKey: 256 })
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
      eventHistory,
    })

    let woke = false
    scheduler.registerLoop('waiter', async () => {
      await scheduler.waitForSync('foo', 'waiter')
      woke = true
    })
    scheduler.tick(100)
    await flush()
    expect(woke).toBe(false)

    // A setter builder wired exactly as SonicPiEngine wires loop builders:
    // shared TimeStateView for the eager write + the scheduler for notifySet.
    const setter = new ProgramBuilder(0)
    setter.setSyncContext(scheduler, 'setter')
    setter.setTimeStateContext(new TimeStateView(eventHistory), [0, 1])
    setter.sleep(1) // advance build vt so the set is strictly after the waiter's vt 0
    setter.set('foo', 42)

    await flush()
    expect(woke).toBe(true)
  })

  it('set-before-sync still resolves via the history-first scan (no regression)', async () => {
    const eventHistory = new EventHistory({ maxPerKey: 256 })
    const scheduler = new VirtualTimeScheduler({
      getAudioTime: () => 0,
      schedAheadTime: 100,
      eventHistory,
    })

    // Write the set BEFORE any syncer registers.
    eventHistory.insert(toWritePath('foo', 'set'), 1, [0], 7)

    let woke = false
    scheduler.registerLoop('waiter', async () => {
      await scheduler.waitForSync('foo', 'waiter')
      woke = true
    })
    scheduler.tick(100)
    await flush()
    expect(woke).toBe(true)
  })
})
