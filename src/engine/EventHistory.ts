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

import { pathMatch, toWritePath, toReadPath } from './PathMatcher'

/** Glob tokens that force a read to scan-and-merge across keys (GAP M1b). */
const GLOB_TOKENS = /[*?{[]/

/**
 * Apply a value matcher safely — a port of `safe_matcher_call`
 * (event_history.rb:19-26): a matcher that throws is treated as NON-matching
 * (`false`), never propagating the error out of the lookup. GAP M2.
 */
function safeMatch(matcher: (value: unknown) => boolean, value: unknown): boolean {
  try {
    return matcher(value) === true
  } catch {
    return false
  }
}

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

/** True iff `a` is a STRICT prefix (proper ancestor) of `b`: `[0]` of `[0,0]`. */
export function isStrictPrefix(a: number[], b: number[]): boolean {
  if (a.length >= b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

/**
 * The cue WAKE-PHASE rule — whether a fired cue is delivered to a waiting `sync`
 * — derived from OBSERVED desktop behaviour (#481 + #400, real-engine capture
 * 2026-06-06), NOT from naive idPath-lexicographic ordering.
 *
 * Deliver iff the cue is strictly LATER in virtual time, OR — at EQUAL vt — the
 * waiter is a strict ANCESTOR of the cuer (the waiter's thread SPAWNED the
 * cuer's thread, then reached its sync, so it happens-AFTER the spawn and sees
 * the cue). Concurrent SIBLING threads at equal vt MISS each other and wait a
 * cycle (desktop's "a freshly-started synced loop waits a cycle", #350/#351).
 *
 * Why not plain `compareEvent > 0` (lexicographic, which would deliver to a
 * lesser sibling): observation disproved it — desktop reversed director/player
 * plays {52,57}, not the {52,55} lexicographic predicts. The five #481/#400 cells
 * all fit this strict-prefix (happens-before) rule. (The exact desktop
 * `event_history.rb` mechanism that yields this — priority/delta fields,
 * matcher construction — is not fully reverse-engineered; the rule is grounded
 * in the OUTPUT, the project's iron rule.) The set/get visibility side keeps
 * `compareEvent` — it agrees with this for comparable pairs and the sibling
 * read-prior is itself correct (#400 verified).
 */
export function cueDelivers(
  cueT: number,
  cueIdPath: number[],
  waiterT: number,
  waiterIdPath: number[],
): boolean {
  if (cueT > waiterT) return true
  if (cueT < waiterT) return false
  return isStrictPrefix(waiterIdPath, cueIdPath)
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
   * Optional per-key cap on retained events (keep the `maxPerKey` GREATEST). A
   * safety bound, NOT desktop's full `@history_depth` pruning (GAP L / #402,
   * deferred) — it exists so the cue side (one auto-cue per loop iteration) does
   * not grow unbounded the way the old single-entry `cueMap` never did. Old cues
   * are irrelevant to `sync`/`getNext` (a syncer matches the NEXT cue after its
   * point), so trimming the oldest is safe. `undefined` ⇒ unbounded (the
   * set/get TimeState facade keeps its prior append-history behaviour).
   */
  private readonly maxPerKey?: number

  constructor(opts?: { maxPerKey?: number }) {
    this.maxPerKey = opts?.maxPerKey
  }

  /**
   * Record an event for `key`, keeping the per-key list in descending
   * `(t, idPath)` order. Mirrors `__insert_event!` (event_history.rb:385-418):
   * the common case (monotonically advancing virtual time) prepends; a rare
   * out-of-order arrival is inserted at its sorted position. If `maxPerKey` is
   * set, the oldest events past the cap are dropped (the tail of the descending
   * list).
   */
  insert(key: string | symbol, t: number, idPath: number[], value: unknown): void {
    const ce: CueEvent = { t, idPath, value }
    const events = this.store.get(key)
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
    if (this.maxPerKey !== undefined && events.length > this.maxPerKey) {
      events.length = this.maxPerKey // drop the oldest (tail of the descending list)
    }
  }

  /**
   * The INCLUSIVE read backing `get :key` — `find_most_recent_event`
   * (event_history.rb:505-511): the greatest event with `e <= (t, idPath)`.
   * Because the list is descending, that is the FIRST event `<= ge`. Returns
   * `null` when nothing is at or before the reader's point.
   */
  getMostRecent(key: string | symbol, t: number, idPath: number[]): CueEvent | null {
    const ge = { t, idPath }
    // GAP M1b: a glob read scans every key whose stored path the pattern matches
    // and returns the GREATEST `e <= ge` across all of them — desktop's `__get`
    // min/max merge over matching tree nodes (event_history.rb:299-380), here
    // over a flat key set. A glob-free key keeps the O(1) exact Map lookup.
    if (typeof key === 'string' && GLOB_TOKENS.test(key)) {
      let best: CueEvent | null = null
      for (const [storedKey, events] of this.store) {
        if (typeof storedKey !== 'string' || !pathMatch(key, storedKey)) continue
        const cand = this.firstAtOrBefore(events, ge)
        if (cand && (!best || compareEvent(cand, best) > 0)) best = cand
      }
      return best
    }
    const events = this.store.get(key)
    if (!events || events.length === 0) return null
    return this.firstAtOrBefore(events, ge)
  }

  /** First (greatest) event `<= ge` in a descending list, or null. */
  private firstAtOrBefore(events: CueEvent[], ge: { t: number; idPath: number[] }): CueEvent | null {
    for (let i = 0; i < events.length; i++) {
      if (compareEvent(events[i], ge) <= 0) return events[i]
    }
    return null
  }

  /**
   * The wake-phase read backing `sync` — the SMALLEST cue (earliest `t`, then
   * idPath) that would be DELIVERED to a waiter at `(t, idPath)` under the
   * {@link cueDelivers} rule (strictly-later, or equal-vt-strict-ancestor). This
   * is the "next cue after my sync point" with desktop's observed happens-before
   * wake-phase. Returns `null` when no cue is deliverable (the syncer blocks for a
   * future one). The list is descending, so scanning from the tail (ascending t)
   * and returning the first deliverable yields the smallest deliverable cue —
   * which at equal vt is the ancestor cue (with_fx race fix), and otherwise the
   * earliest strictly-later cue.
   *
   * `after` (#489) excludes any cue at or before a previously-consumed cue's
   * `(t, idPath)` — desktop's re-sync matcher (`core.rb:4551-4571`,
   * `:sonic_pi_local_last_sync`): the next delivered cue must be STRICTLY greater
   * (`compareEvent > 0`) than the last one this waiter consumed, so an inline/main
   * waiter that caught an equal-vt ancestor cue doesn't re-catch it forever. Only
   * set on a RE-sync; a first sync passes `undefined` so the wake-phase is the
   * pure `(t,idPath)` `cueDelivers` rule (#400 unaffected).
   */
  getNextDelivered(key: string | symbol, t: number, idPath: number[], after?: { t: number; idPath: number[] }, valMatcher?: (value: unknown) => boolean): CueEvent | null {
    // GAP M1b: a glob sync (`sync :foo` → `/{cue,set,live_loop}/foo`) wakes on the
    // SMALLEST deliverable cue across EVERY matching key — desktop's `get_next`
    // min merge (event_history.rb:303-360). A glob-free key keeps the fast scan.
    // GAP M2: `valMatcher` (desktop's `arg_matcher`) further constrains a
    // candidate by its value — the scan must keep looking past a value-rejected
    // cue to the next deliverable one (event_history.rb:529-534).
    if (typeof key === 'string' && GLOB_TOKENS.test(key)) {
      let best: CueEvent | null = null
      for (const [storedKey, events] of this.store) {
        if (typeof storedKey !== 'string' || !pathMatch(key, storedKey)) continue
        const cand = this.firstDeliverable(events, t, idPath, after, valMatcher)
        if (cand && (!best || compareEvent(cand, best) < 0)) best = cand
      }
      return best
    }
    const events = this.store.get(key)
    if (!events || events.length === 0) return null
    return this.firstDeliverable(events, t, idPath, after, valMatcher)
  }

  /**
   * Smallest deliverable cue in a descending list — scan from the tail
   * (ascending t) and return the first that clears `after`, {@link cueDelivers},
   * and (GAP M2) the optional `valMatcher` value predicate. A matcher that throws
   * is treated as non-matching (desktop `safe_matcher_call`, event_history.rb:19-26).
   */
  private firstDeliverable(
    events: CueEvent[],
    t: number,
    idPath: number[],
    after?: { t: number; idPath: number[] },
    valMatcher?: (value: unknown) => boolean,
  ): CueEvent | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (after && compareEvent(e, after) <= 0) continue
      if (valMatcher && !safeMatch(valMatcher, e.value)) continue
      if (cueDelivers(e.t, e.idPath, t, idPath)) return e
    }
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

/**
 * TimeStateView — GAP M1c. Exposes the prior `TimeState` `{set, get}` interface
 * but backed by a SHARED EventHistory with path namespacing, so `set`/`get` use
 * the ONE coordination store that `cue`/`sync` use (desktop's single
 * `@event_history`). The consequence — desktop-faithful — is that a `get :foo`
 * now sees a `cue :foo` / `live_loop :foo` (the `/{cue,set,live_loop}/foo` read
 * union), which the separate-store world could not do.
 *
 * Writes go to the `/set/` root (`toWritePath(key, 'set')`); reads use the union
 * glob (`toReadPath`). The leading-`/` heuristic (PathMatcher) routes an explicit
 * absolute key (`set "/a/b"`) to a verbatim path. Returns value-or-`null`,
 * matching the prior TimeState vt-aware contract (SonicPiEngine `?? null`).
 */
export class TimeStateView {
  constructor(private readonly eh: EventHistory) {}

  set(key: string | symbol, value: unknown, t: number, writerIdPath: number[] = [0]): void {
    this.eh.insert(toWritePath(String(key), 'set'), t, writerIdPath, value)
  }

  get(key: string | symbol, t?: number, readerIdPath: number[] = [0]): unknown {
    const readPath = toReadPath(String(key))
    // No-vt facade (the engine's `get(key)` fallback): the absolute latest across
    // the union — a reader at +∞ with a maximal idPath sees every stored event.
    const at = t === undefined ? Number.POSITIVE_INFINITY : t
    const rid = t === undefined ? [Number.MAX_SAFE_INTEGER] : readerIdPath
    const e = this.eh.getMostRecent(readPath, at, rid)
    return e ? e.value : null
  }

  /** Distinct-key count facade (parity with the prior TimeState). */
  get size(): number {
    return this.eh.size
  }

  /** Dispose-only clear (SK14) — delegates to the shared store. */
  clear(): void {
    this.eh.clear()
  }
}
