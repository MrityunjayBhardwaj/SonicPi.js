/**
 * EventHistory — the `(t, idPath)`-ordered store (GAP A2 / Spike 2), ported from
 * desktop `event_history.rb`. These tests are the CONTRACT for the total order
 * and the two query modes, asserted directly so the scheduler/TimeState wiring
 * (which adds Promise/blocking glue) can rely on them.
 *
 * Grounded refs (sonic-pi-net/sonic-pi @ main):
 *   - cueevent.rb:64-74   — `<=>`: t → priority(0) → thread_id → delta(0)
 *   - thread_id.rb:41-55  — lexicographic idPath, longer-prefix-greater
 *   - event_history.rb:505-511 — find_most_recent_event (inclusive `e <= ge`)
 *   - event_history.rb:513-545 — find_next_event (strict `e > ge`)
 */
import { describe, it, expect } from 'vitest'
import { EventHistory, compareIdPath, compareEvent, isStrictPrefix, cueDelivers } from '../EventHistory'

describe('compareIdPath (thread_id.rb:41-55)', () => {
  it('equal paths compare 0', () => {
    expect(compareIdPath([0], [0])).toBe(0)
    expect(compareIdPath([0, 1, 2], [0, 1, 2])).toBe(0)
  })
  it('element-wise on the shared prefix', () => {
    expect(compareIdPath([0, 0], [0, 1])).toBe(-1)
    expect(compareIdPath([0, 2], [0, 1])).toBe(1)
  })
  it('longer path is GREATER on a shared prefix (child > ancestor)', () => {
    expect(compareIdPath([0, 0], [0])).toBe(1) // child after ancestor
    expect(compareIdPath([0], [0, 0])).toBe(-1)
    expect(compareIdPath([0, 0, 0], [0, 0])).toBe(1)
  })
})

describe('compareEvent (cueevent.rb:64-74 — t then idPath)', () => {
  it('orders by t first', () => {
    expect(compareEvent({ t: 0, idPath: [9] }, { t: 1, idPath: [0] })).toBe(-1)
    expect(compareEvent({ t: 2, idPath: [0] }, { t: 1, idPath: [9] })).toBe(1)
  })
  it('falls through to idPath at equal t (within epsilon)', () => {
    expect(compareEvent({ t: 0, idPath: [0, 0] }, { t: 0, idPath: [0, 1] })).toBe(-1)
    expect(compareEvent({ t: 0, idPath: [0, 0] }, { t: 0, idPath: [0] })).toBe(1)
  })
  it('compares t EXACTLY (no epsilon) — desktop time_r is a Rational', () => {
    // The old fireCue +1e-9 epsilon broke the exact "last ≤ t" boundary; the
    // faithful order is exact, so genuinely-equal vts (synced inherit / bit-exact
    // launch origin) fall to idPath while a 1e-12 difference still orders by t.
    expect(compareEvent({ t: 0.5, idPath: [0] }, { t: 0.5, idPath: [0] })).toBe(0)
    expect(compareEvent({ t: 0.5, idPath: [0] }, { t: 0.5 + 1e-12, idPath: [0] })).toBe(-1)
  })
})

describe('EventHistory.insert — descending (t, idPath) order', () => {
  it('keeps the list greatest-first regardless of insertion order', () => {
    const h = new EventHistory()
    h.insert('k', 1, [0], 'a')
    h.insert('k', 0, [0], 'b') // out of order (smaller t)
    h.insert('k', 2, [0], 'c')
    // latest() reads events[0] — must be the greatest (t=2).
    expect(h.latest('k')).toBe('c')
    // most recent at or before t=0.5 is the t=0 entry.
    expect(h.getMostRecent('k', 0.5, [0])!.value).toBe('b')
  })
})

describe('EventHistory.getMostRecent — `get :key` (inclusive e <= ge)', () => {
  it('returns the greatest event at or before the reader (INCLUSIVE)', () => {
    const h = new EventHistory()
    h.insert('root', 0, [0], 52)
    h.insert('root', 1, [0], 55)
    expect(h.getMostRecent('root', 0, [0])!.value).toBe(52) // inclusive at t=0
    expect(h.getMostRecent('root', 0.9, [0])!.value).toBe(52)
    expect(h.getMostRecent('root', 1, [0])!.value).toBe(55)
  })
  it('returns null when nothing is at or before the reader', () => {
    const h = new EventHistory()
    h.insert('root', 5, [0], 1)
    expect(h.getMostRecent('root', 1, [0])).toBeNull()
    expect(h.getMostRecent('missing', 1, [0])).toBeNull()
  })

  it('#400: at equal t, writer idPath ≤ reader idPath is visible; greater is NOT', () => {
    // director-first: director [0,0] sets, player [0,1] reads at same t=0.
    const h = new EventHistory()
    h.insert('root', 0, [0, 0], 55) // director writes
    expect(h.getMostRecent('root', 0, [0, 1])!.value).toBe(55) // player [0,1] sees [0,0]
    // player-first: player [0,0] reads, director [0,1] writes at same t=0.
    const h2 = new EventHistory()
    h2.insert('root', 0, [0, 1], 55) // director [0,1] writes
    // player [0,0] reads at (0,[0,0]) — director's (0,[0,1]) is GREATER → not ≤ →
    // not visible → reads prior (null here). This is the #400/#350-reversed flip.
    expect(h2.getMostRecent('root', 0, [0, 0])).toBeNull()
  })
})

describe('cueDelivers — the observed wake-phase (strict-later OR equal-vt strict-ancestor)', () => {
  it('isStrictPrefix: proper ancestor only', () => {
    expect(isStrictPrefix([0], [0, 0])).toBe(true)
    expect(isStrictPrefix([0], [0, 5, 2])).toBe(true)
    expect(isStrictPrefix([0], [0])).toBe(false) // equal, not strict
    expect(isStrictPrefix([0, 0], [0, 1])).toBe(false) // siblings
    expect(isStrictPrefix([0, 0], [0])).toBe(false) // descendant→ancestor
  })
  it('delivers a strictly-later cue regardless of idPath', () => {
    expect(cueDelivers(1, [9], 0, [0])).toBe(true)
    expect(cueDelivers(0, [0], 1, [9])).toBe(false) // earlier → never
  })
  it('at EQUAL vt: ancestor waiter catches; sibling/descendant misses', () => {
    expect(cueDelivers(0, [0, 0], 0, [0])).toBe(true) // #481 with_fx: waiter [0] ⊏ cue [0,0]
    expect(cueDelivers(0, [0, 0], 0, [0, 1])).toBe(false) // #481 in_thread: siblings
    expect(cueDelivers(0, [0, 1], 0, [0, 0])).toBe(false) // #400 player: siblings
    expect(cueDelivers(0, [0], 0, [0, 0])).toBe(false) // descendant cue, ancestor waiter
    expect(cueDelivers(0, [0], 0, [0])).toBe(false) // equal idPath: not strict
  })
})

describe('EventHistory.getNextDelivered — `sync` wake-phase (cueDelivers)', () => {
  it('returns the SMALLEST event strictly after the sync point', () => {
    const h = new EventHistory()
    h.insert('tick', 0.5, [0, 0], 'a')
    h.insert('tick', 1.0, [0, 0], 'b')
    h.insert('tick', 1.5, [0, 0], 'c')
    // syncer at t=0.7 → next is the t=1.0 event.
    expect(h.getNextDelivered('tick', 0.7, [0])!.value).toBe('b')
  })
  it('returns null when no event is strictly after (must block)', () => {
    const h = new EventHistory()
    h.insert('tick', 0, [0, 0], 'a')
    // syncer at t=1 with everything in the past → block.
    expect(h.getNextDelivered('tick', 1, [0])).toBeNull()
  })

  it('#481 with_fx race: same-t higher-idPath cue IS delivered (the registration-race fix)', () => {
    // driver [0,0] cued at vt0; inline with_fx waiter is in __run_once = main [0].
    const h = new EventHistory()
    h.insert('tick', 0, [0, 0], 'driver')
    // idx === -1 (cue (0,[0,0]) is NOT <= (0,[0])); last > ge → deliver → onset 0.
    expect(h.getNextDelivered('tick', 0, [0])!.value).toBe('driver')
  })
  it('#481 in_thread: same-t cue with LOWER idPath than waiter is NOT delivered (waits a cycle)', () => {
    // driver [0,0] cued at vt0; forked in_thread waiter is [0,1].
    const h = new EventHistory()
    h.insert('tick', 0, [0, 0], 'driver')
    // (0,[0,0]) <= (0,[0,1]) → idx 0, last ≯ ge → null → block → catches next@0.5.
    expect(h.getNextDelivered('tick', 0, [0, 1])).toBeNull()
    // ...then the driver's next cue at vt0.5 IS strictly after → delivered.
    h.insert('tick', 0.5, [0, 0], 'driver-2')
    expect(h.getNextDelivered('tick', 0, [0, 1])!.value).toBe('driver-2')
  })

  it('real met/#350 scenario: a freshly-started syncer with a HIGHER idPath waits a cycle', () => {
    // met [0,0] auto-cues at vt0 BEFORE the synced loop [0,1] registers — the
    // cue is already in history. idPath order (met < syncer) gives the right MISS
    // WITH the history scan (the old code needed to ignore history only because
    // it had no idPath to distinguish).
    const h = new EventHistory()
    h.insert('met', 0, [0, 0], 'beat0')
    expect(h.getNextDelivered('met', 0, [0, 1])).toBeNull() // misses the simultaneous cue
  })

  it(':140 contrived (cue ahead of waiter, same idPath): faithful find_next DELIVERS it', () => {
    // The grounded desktop behavior (event_history.rb:529-543): a cue at t=2.5
    // recorded before a waiter syncs at t=0 (same idPath [0]) IS the "next" event
    // → delivered. (idx === -1, last (2.5) > ge (0).) This is the intended change
    // to SyncCue:140 — the old web rule blanket-ignored history.
    const h = new EventHistory()
    h.insert('ready', 2.5, [0], 'r')
    expect(h.getNextDelivered('ready', 0, [0])!.value).toBe('r')
  })

  // #489: the `after` (last-consumed cue) guard — desktop core.rb:4551-4571
  // `:sonic_pi_local_last_sync` + event_history.rb:139 strict `ce > matcher.ce`.
  describe('getNextDelivered `after` — re-sync excludes the consumed cue (#489)', () => {
    it('an inline/main waiter [0] does NOT re-catch the same equal-vt ancestor cue', () => {
      // The bare_loop runaway: driver [0,0] cues :tick at vt0; an inline `loop`
      // waiter [0] catches it (equal-vt ancestor). On the NEXT sync — still vt0,
      // still [0] — without the guard it re-delivers the SAME (0,[0,0]) cue
      // forever (1024-voice runaway). With `after` = the consumed cue, it does not.
      const h = new EventHistory()
      h.insert('tick', 0, [0, 0], 'tick0')
      const first = h.getNextDelivered('tick', 0, [0])
      expect(first!.value).toBe('tick0') // first sync catches the equal-vt cue
      // re-sync at the same point, excluding the just-consumed (0,[0,0]):
      expect(h.getNextDelivered('tick', 0, [0], { t: 0, idPath: [0, 0] })).toBeNull()
    })

    it('after a catch, the NEXT strictly-greater cue is delivered (spread, not pile)', () => {
      const h = new EventHistory()
      h.insert('tick', 0, [0, 0], 'tick0')
      h.insert('tick', 0.5, [0, 0], 'tick1')
      // consumed (0,[0,0]) → next delivered is (0.5,[0,0]), not a re-catch of vt0.
      expect(h.getNextDelivered('tick', 0, [0], { t: 0, idPath: [0, 0] })!.value).toBe('tick1')
      // and after THAT, exclude (0.5,[0,0]) → nothing left → block for the next.
      expect(h.getNextDelivered('tick', 0.5, [0], { t: 0.5, idPath: [0, 0] })).toBeNull()
    })

    it('a FIRST sync (after undefined) keeps the pure cueDelivers wake-phase (#400 intact)', () => {
      const h = new EventHistory()
      h.insert('tick', 0, [0, 0], 'tick0')
      // no `after` ⇒ inline [0] still catches the equal-vt ancestor cue,
      // sibling [0,1] still misses it — unchanged from the #400/#481 contract.
      expect(h.getNextDelivered('tick', 0, [0])!.value).toBe('tick0')
      expect(h.getNextDelivered('tick', 0, [0, 1])).toBeNull()
    })
  })
})
