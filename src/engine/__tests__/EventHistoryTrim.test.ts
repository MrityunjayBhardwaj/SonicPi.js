import { describe, it, expect } from 'vitest'
import { EventHistory } from '../EventHistory'

/**
 * #402 — desktop-faithful auto-trim of per-key history (GAP L).
 *
 * Mirrors `__insert_event!`'s trim (event_history.rb:392-399): keep at least
 * `minHistorySize` events per key, and drop any OLDER than `historyDepthSeconds`
 * behind the newest event on that key. `t` is in audio seconds — the same unit
 * as desktop's wall-clock `@history_depth`. The hard `maxPerKey` ceiling bounds
 * pathological same-window bursts the age cutoff alone would not trim.
 *
 * The safety contract (issue #402): trimming must NOT break the "greatest event
 * ≤ reader-vt" read for an ACTIVE reader. An active reader tracks near the newest
 * set, so it always reads the retained head — these tests pin that.
 */
describe('EventHistory auto-trim (#402)', () => {
  const KEY = '/set/root'
  // tiny depth + min so the tests are cheap and the boundary is explicit.
  const opts = { trimHistory: true, minHistorySize: 4, historyDepthSeconds: 10 }

  it('is unbounded by default (trimHistory off) — preserves prior facade behaviour', () => {
    const h = new EventHistory()
    for (let i = 0; i < 100; i++) h.insert(KEY, i, [0], `v${i}`)
    expect(h.eventCount(KEY)).toBe(100)
  })

  it('after N≫K sets, the per-key history is bounded AND a reader at the latest vt reads the latest value', () => {
    const h = new EventHistory(opts)
    const N = 500
    for (let i = 0; i < N; i++) h.insert(KEY, i, [0], `v${i}`)
    // Bounded: with 1s spacing and a 10s window, only events within (newest-10)
    // survive, never below the min floor.
    expect(h.eventCount(KEY)).toBeLessThanOrEqual(20)
    expect(h.eventCount(KEY)).toBeGreaterThanOrEqual(opts.minHistorySize)
    // The active reader (at the latest vt) still sees the latest value.
    const latest = h.getMostRecent(KEY, N - 1, [0])
    expect(latest?.value).toBe(`v${N - 1}`)
  })

  it('always retains at least minHistorySize even when every event is older than the window', () => {
    const h = new EventHistory(opts)
    // Sets spaced 100s apart: every prior event is far past the 10s cutoff, yet
    // the min floor (4) is held — desktop keeps @min_history_size regardless.
    for (let i = 0; i < 50; i++) h.insert(KEY, i * 100, [0], `v${i}`)
    expect(h.eventCount(KEY)).toBe(opts.minHistorySize)
    // …and the newest is still the head.
    expect(h.getMostRecent(KEY, 49 * 100, [0])?.value).toBe('v49')
  })

  it('a reader WITHIN the retained window reads the correct (not just latest) value', () => {
    const h = new EventHistory({ trimHistory: true, minHistorySize: 2, historyDepthSeconds: 5 })
    for (let i = 0; i < 100; i++) h.insert(KEY, i, [0], `v${i}`)
    // Newest is v99 at t=99; window keeps t≥94. A reader at t=96 must read v96,
    // a value that is NOT the latest — proving in-window reads stay exact.
    expect(h.getMostRecent(KEY, 96, [0])?.value).toBe('v96')
  })

  it('the maxPerKey ceiling caps a same-instant burst the age cutoff cannot trim', () => {
    // 1000 sets all at t=0 (one virtual instant) — none is "older than the
    // window", so only the hard ceiling bounds them.
    const h = new EventHistory({ trimHistory: true, minHistorySize: 4, historyDepthSeconds: 10, maxPerKey: 64 })
    for (let i = 0; i < 1000; i++) h.insert(KEY, 0, [0, i], `v${i}`)
    expect(h.eventCount(KEY)).toBe(64)
  })

  it('a config set ONCE is readable at any far-future vt (the common set-once/read-forever case)', () => {
    // `set :root, 60` once at t=0, then `get :root` an hour later. A single entry
    // is below the min floor, so trim never touches it — the read must still hit.
    const h = new EventHistory(opts)
    h.insert(KEY, 0, [0], 60)
    expect(h.eventCount(KEY)).toBe(1)
    expect(h.getMostRecent(KEY, 3600, [0])?.value).toBe(60)
  })

  it('keeps keys independent — trimming one does not touch another', () => {
    const h = new EventHistory(opts)
    for (let i = 0; i < 100; i++) h.insert('/set/a', i, [0], `a${i}`)
    h.insert('/set/b', 0, [0], 'b0')
    expect(h.eventCount('/set/b')).toBe(1)
    expect(h.getMostRecent('/set/b', 0, [0])?.value).toBe('b0')
  })
})
