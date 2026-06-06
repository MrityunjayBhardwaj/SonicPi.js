/**
 * EventHistory — a `(t, idPath)`-ordered event store, a port of desktop Sonic
 * Pi's `event_history.rb` coordination layer (GAP A2 / Spike 2).
 *
 * Desktop resolves every cross-thread coordination event — `cue`, `sync`,
 * `set`, `get` — through ONE `@event_history` of `CueEvent`s ordered by a total
 * order (`cueevent.rb:64-74`): `time → priority → thread_id → delta`, all
 * ascending. For our build-once model the moot fields collapse: all user spider
 * threads share `priority = 0` (`runtime.rb:908`) and `delta` is GAP D
 * (`time_warp`, out of scope), so the effective order is **`(t, idPath)`** — t
 * first, then the hierarchical thread-id path as the equal-`t` tiebreak. This is
 * the shared mechanism behind #481 (synced first-onset off one driver cycle) and
 * #400/#350-reversed (reversed loop order reads WRONG NOTES).
 *
 * `idPath` is desktop's `ThreadId` (`thread_id.rb:41-55`): a lexicographic
 * compare over the int-array path where, on a shared prefix, the LONGER path is
 * GREATER (a forked child `[0,0]` sorts after its ancestor `[0]`).
 *
 * Two query modes mirror desktop exactly:
 *  - `getMostRecent` (`find_most_recent_event`, event_history.rb:505-511) — the
 *    INCLUSIVE `e <= ge` read backing `get :key`: the greatest event at or
 *    before the reader's `(t, idPath)`.
 *  - `getNext` (`find_next_event`, event_history.rb:513-545) — the STRICT
 *    `e > ge` read backing `sync`/`get_next`: the SMALLEST event strictly after
 *    the sync point. `sync` checks this against existing history first (the fix
 *    for the with_fx registration race — a same-`t` higher-idPath cue that fired
 *    before the waiter registered still matches), then blocks for a future one.
 *
 * SCOPE (GAP A, not GAP M): this is the `(t, i)` axis only. Desktop's path
 * namespacing (`/cue` vs `/set` write roots + the `/{cue,set,live_loop}` read
 * glob, core.rb:70-99) is GAP M and deliberately NOT modelled here — callers keep
 * cue and set as separate stores/keys, so `set :foo` does NOT wake `sync :foo`
 * (our current behaviour, preserved). `val_matcher`, `beat`, `bpm`, `delta` and
 * history pruning (`@history_depth`, event_history.rb:163) are likewise deferred.
 */

/** A coordination event: a value recorded at virtual time `t` by thread `idPath`. */
export interface CueEvent {
  /** Virtual time (seconds) the event was recorded at. */
  t: number
  /** The recording thread's hierarchical id path (desktop `ThreadId`). */
  idPath: number[]
  /** The payload — cue args (an array) or a `set` value. */
  value: unknown
}

/**
 * Lexicographic compare of two thread-id paths — a port of `ThreadId#<=>`
 * (`thread_id.rb:41-55`). Element-wise over the shared prefix; if equal there,
 * the LONGER path is GREATER (a forked child sorts after its ancestor).
 * Returns -1 | 0 | 1.
 */
export function compareIdPath(a: number[], b: number[]): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length)
  for (let k = 0; k < n; k++) {
    if (a[k] < b[k]) return -1
    if (a[k] > b[k]) return 1
  }
  if (a.length > b.length) return 1 // self longer at shared prefix ⇒ greater
  if (a.length < b.length) return -1 // other longer ⇒ self lesser
  return 0
}

/**
 * Total order over events — a port of the user-thread-relevant fields of
 * `CueEvent#<=>` (`cueevent.rb:64-74`): `t` first, then `idPath`. `priority`
 * (always 0) and `delta` (GAP D) are omitted. Returns -1 | 0 | 1.
 *
 * The `t` compare is EXACT — desktop compares `time_r` (an exact Rational,
 * `cueevent.rb:28`), so genuinely-simultaneous events (e.g. a synced waiter that
 * INHERITED the cuer's vt, or a top-level fork sharing a bit-exact launch origin)
 * compare equal on `t` and fall through to the idPath tiebreak. The old fireCue
 * `+ 1e-9` epsilon was a web-only float-noise guard that broke the exact
 * "last ≤ t" boundary (a write at vt 0.5 must NOT be visible to a get at
 * 0.5 − 1e-9); the faithful order is exact. (Float-accumulation drift between
 * two independently-summed cursors is a known edge desktop sidesteps via
 * Rational — out of scope here.)
 */
export function compareEvent(
  a: { t: number; idPath: number[] },
  b: { t: number; idPath: number[] },
): -1 | 0 | 1 {
  if (a.t < b.t) return -1
  if (a.t > b.t) return 1
  return compareIdPath(a.idPath, b.idPath)
}

export class EventHistory {
  /**
   * Per-key event list, kept in DESCENDING `(t, idPath)` order (greatest first),
   * mirroring desktop's `unshift` + `bubble_up_sort!` (event_history.rb:385-433).
   * Descending order makes `getMostRecent`'s "first `e <= ge`" an O(k) scan from
   * the front and matches the `find_next` index arithmetic 1:1.
   */
  private readonly store = new Map<string | symbol, CueEvent[]>()

  /**
   * Record an event for `key`, keeping the per-key list in descending
   * `(t, idPath)` order. Mirrors `__insert_event!` (event_history.rb:385-418):
   * the common case (monotonically advancing virtual time) prepends; a rare
   * out-of-order arrival is inserted at its sorted position.
   *
   * NB: no `@history_depth` pruning yet (deferred, GAP L / #402) — v1 is bounded
   * by run length and cleared on dispose, exactly like the TimeState it replaces.
   */
  insert(key: string | symbol, t: number, idPath: number[], value: unknown): void {
    const ce: CueEvent = { t, idPath, value }
    let events = this.store.get(key)
    if (!events) {
      this.store.set(key, [ce])
      return
    }
    // Descending order: find the first existing event that is <= the new one and
    // splice in front of it. The hot path (new event is the greatest) splices at
    // index 0 (an unshift).
    let i = 0
    while (i < events.length && compareEvent(events[i], ce) > 0) i++
    events.splice(i, 0, ce)
  }

  /**
   * The INCLUSIVE read backing `get :key` — `find_most_recent_event`
   * (event_history.rb:505-511): the greatest event with `e <= (t, idPath)`.
   * Because the list is descending, that is the FIRST event `<= ge`. Returns
   * `null` when nothing is at or before the reader's point.
   */
  getMostRecent(key: string | symbol, t: number, idPath: number[]): CueEvent | null {
    const events = this.store.get(key)
    if (!events || events.length === 0) return null
    const ge = { t, idPath }
    for (let i = 0; i < events.length; i++) {
      if (compareEvent(events[i], ge) <= 0) return events[i]
    }
    return null
  }

  /**
   * The STRICT read backing `sync` / `get_next` — `find_next_event`
   * (event_history.rb:513-545): the SMALLEST event strictly AFTER `(t, idPath)`
   * (the "next event after my sync point"). Returns `null` when no event is
   * strictly greater (the syncer must then block for a future one).
   *
   * Ported verbatim from the Ruby index arithmetic:
   *   idx = first index where events[idx] <= ge   (descending list)
   *   if idx > 0:        events[idx-1]  (smallest event still > ge)
   *   else (idx 0 or -1): events.last if events.last > ge
   * The `idx === -1` branch (NO event <= ge, i.e. ALL events are after ge) is the
   * with_fx registration-race fix: a same-`t` higher-idPath cue already in
   * history is delivered (`last > ge`), so a late syncer still catches it.
   */
  getNext(key: string | symbol, t: number, idPath: number[]): CueEvent | null {
    const events = this.store.get(key)
    if (!events || events.length === 0) return null
    const ge = { t, idPath }
    const idx = events.findIndex((e) => compareEvent(e, ge) <= 0)
    if (idx > 0) return events[idx - 1]
    const last = events[events.length - 1]
    if (last && compareEvent(last, ge) > 0) return last
    return null
  }

  /** Latest value for `key` (greatest event), or `undefined` if never set. */
  latest(key: string | symbol): unknown {
    const events = this.store.get(key)
    return events && events.length > 0 ? events[0].value : undefined
  }

  /**
   * The greatest event for `key` (or `undefined`). Exposed for the TimeState
   * facade's idempotency guard (skip a re-applied identical write); the pure
   * store itself never dedups (desktop `event_history.rb` just unshifts).
   */
  peekLatest(key: string | symbol): CueEvent | undefined {
    const events = this.store.get(key)
    return events && events.length > 0 ? events[0] : undefined
  }

  /** Number of distinct keys (facade parity with the prior TimeState). */
  get size(): number {
    return this.store.size
  }

  /** Clear all events. Dispose-only (SK14) — never on stop/run. */
  clear(): void {
    this.store.clear()
  }
}
