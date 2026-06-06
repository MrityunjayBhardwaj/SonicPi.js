/**
 * TimeState — the `set`/`get` facade over the unified {@link EventHistory}.
 *
 * Mirrors Desktop Sonic Pi's Time State layer (`event_history.rb`): a `get`
 * resolves "the last seen version at or before the reader's point" (the
 * inclusive lookup, `event_history.rb:505-511 find_most_recent_event`), and a
 * `set` records a timestamped event rather than blindly overwriting. Per
 * CLAUDE.md's "Architecture Principle" the ordering lives in ONE module
 * (`EventHistory`) that audits 1:1 against `event_history.rb`; this class is the
 * thin namespaced facade for the `set`/`get` half (the scheduler holds another
 * `EventHistory` for `cue`/`sync` — same mechanism, separate namespace).
 *
 * GAP A2 (#400/#350-reversed): the lookup is now the full `(t, idPath)` total
 * order, not just `t` with append-order ties. At equal virtual time the WRITER's
 * thread-id path is the tiebreak: a reader sees a same-`t` write iff the writer's
 * idPath ≤ the reader's idPath (`event_history.rb` `e <= ge`). This is what makes
 * a reversed director/player declaration read desktop's `{52,57}` instead of the
 * old source-order-blind `{55,59}`. idPath defaults to `[0]` (main) so callers
 * that don't yet thread it through keep the prior single-axis behaviour.
 *
 * Why time-indexed (SP95 / SV47 / #350): under a plain `Map` the apply moment WAS
 * the visibility moment, so a cross-loop `set`/`get` at the same virtual time
 * raced on microtask ordering. With the time index each `set` carries its OWN
 * recorded virtual time, so visibility is defined by the recorded TIMESTAMP (and
 * now the writer idPath), not the moment of application.
 */
import { EventHistory, compareIdPath } from './EventHistory'

export class TimeState {
  /** The single ordered store backing this namespace (GAP A2 — was a Map-of-arrays). */
  private readonly history = new EventHistory()

  /**
   * Record `value` for `key` at virtual time `t`, written by thread `writerIdPath`
   * (defaults to `[0]` = main). Mirrors `EventHistory.set`/`__insert_event!`.
   *
   * Idempotency (Decision Q3): the eager build-time write and any re-application
   * of the SAME `(key, value, t, idPath)` that is already the latest event is a
   * no-op — guaranteeing one entry per `(key, build-vt, idPath, value)`. (The
   * deferred interpreter `case 'set'` is already a no-op for this path; this is
   * the defensive guard the prior Map-of-arrays implementation kept.)
   */
  set(key: string | symbol, value: unknown, t: number, writerIdPath: number[] = [0]): void {
    const latest = this.history.peekLatest(key)
    if (
      latest !== undefined &&
      latest.t === t &&
      latest.value === value &&
      compareIdPath(latest.idPath, writerIdPath) === 0
    ) {
      return
    }
    this.history.insert(key, t, writerIdPath, value)
  }

  /**
   * Resolve the value of `key`.
   *
   * - `get(key, t, readerIdPath?)` → the greatest event with `(eventT, writerId)
   *   ≤ (t, readerIdPath)` (INCLUSIVE — a write recorded at the reader's exact
   *   `(t, idPath)` IS visible), or `null` if none is at or before that point.
   * - `get(key)` (no `t`) → facade: the LATEST value (greatest event), or
   *   `undefined` if the key was never set (Map-compatible facade for tests).
   */
  get(key: string | symbol): unknown
  get(key: string | symbol, t: number, readerIdPath?: number[]): unknown
  get(key: string | symbol, t?: number, readerIdPath: number[] = [0]): unknown {
    if (t === undefined) {
      return this.history.latest(key)
    }
    const event = this.history.getMostRecent(key, t, readerIdPath)
    return event ? event.value : null
  }

  /** Number of distinct keys (facade for tests that read `.size`). */
  get size(): number {
    return this.history.size
  }

  /** Clear all entries. Dispose-only (SK14) — never on stop/run. */
  clear(): void {
    this.history.clear()
  }
}
