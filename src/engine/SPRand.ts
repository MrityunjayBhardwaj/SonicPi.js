/**
 * SPRand — table-indexed random generator matching desktop Sonic Pi (EPIC #531).
 *
 * Desktop's `SonicPi::Core::SPRand` (app/server/ruby/core.rb) does NOT run a live
 * PRNG. It indexes a frozen 441,000-value table (the rand-stream wav, see
 * {@link ./RandStream}) by a per-thread `(seed, idx)` position. This class is a
 * 1:1 port of that arithmetic so `rand`/`rand_i`/`choose`/… produce the SAME
 * values as desktop for the same seed — the parity our prior MT19937
 * `SeededRandom` could never reach (it generated fresh floats, indexing nothing).
 *
 * Desktop arithmetic (grounded, GROUND_TRUTH_DESKTOP_SP_PRNG):
 *   rand_peek(max, idx, seed): pos = (seed + idx + 1) mod 441000; table[pos] * max
 *   rand!(max):                r = idx; idx = r + 1; rand_peek(max, r)
 *     → after set_seed!(s) (seed=s, idx=0), successive rand! read pos s+1, s+2, …
 *   rand_i!(max) = trunc(rand!(max))   (Ruby Float#to_i truncates toward zero)
 *
 * Two Ruby→JS traps this port must respect (both are silent-divergence sources):
 *   1. In Ruby `0` is TRUTHY, so SPRand's `idx = get_idx unless idx` keeps an
 *      explicit `idx == 0`. The JS guard must therefore test `=== undefined`,
 *      NOT `!idx` (which would wrongly re-fetch when idx is 0).
 *   2. Ruby `%` takes the sign of the divisor, so a NEGATIVE index (after
 *      rand_back past 0) wraps to a positive table slot. JS `%` keeps the sign of
 *      the dividend, so we floor-mod.
 *
 * The public surface mirrors {@link ./SeededRandom} so Phase 1b can swap it into
 * ProgramBuilder with no call-site changes. Per-op consumption details
 * (rrand/shuffle/dice/one_in vs desktop) are tightened in Phase 2 (#531); this
 * phase lands the exact value SOURCE and the seed/idx mechanics.
 */
import { RAND_STREAM_LENGTH } from './RandStream'

/** Ruby-style modulo: result takes the sign of the divisor (always [0, m)). */
function floorMod(n: number, m: number): number {
  return ((n % m) + m) % m
}

export class SPRand {
  private readonly table: Float64Array
  /** Desktop `:sonic_pi_spider_random_gen_seed` — an offset into the table. */
  private seed: number
  /** Desktop `:sonic_pi_spider_random_gen_idx` — draws since the last set_seed. */
  private idx: number

  constructor(table: Float64Array, seed = 0) {
    this.table = table
    this.seed = seed
    this.idx = 0
  }

  /**
   * `rand_peek(max, idx, seed)` — the core lookup. Returns the value at the
   * position the NEXT draw would read, WITHOUT consuming. `idx`/`seed` default to
   * the stored state (Ruby `unless` ⇒ `=== undefined`, so an explicit 0 is kept).
   */
  private randPeek(max = 1, idx?: number, seed?: number): number {
    const i = idx === undefined ? this.idx : idx
    const s = seed === undefined ? this.seed : seed
    // Floor the position: a thread-derived seed (Phase 3) is a float, and desktop's
    // Ruby `random_numbers[float]` truncates. Integer seeds (use_random_seed) are a
    // no-op here. Indexing a Float64Array with a non-integer would yield undefined.
    const pos = Math.floor(floorMod(s + i + 1, RAND_STREAM_LENGTH))
    return this.table[pos] * max
  }

  /**
   * `rand!(max)` — consume one value: read at the current idx, advance idx by one.
   * (Desktop `inc_idx!` returns the OLD idx then stores idx+1, and rand_peek uses
   * the old idx → positions seed+1, seed+2, … after a reset.)
   */
  private randBang(max = 1): number {
    const r = this.idx
    this.idx = r + 1
    return this.randPeek(max, r)
  }

  // --- public surface (mirrors SeededRandom) -------------------------------

  /** Random float in [0, 1) — desktop `rand` with no/`1` max. One draw. */
  next(): number {
    return this.randBang(1)
  }

  /** Random float in [min, max) — `min + rand!(max - min)`. */
  rrand(min: number, max: number): number {
    return min + this.randBang(max - min)
  }

  /** Random int in [min, max] inclusive. */
  rrand_i(min: number, max: number): number {
    return Math.floor(this.rrand(min, max + 1))
  }

  /** Random element from an array (`arr[rand_i!(len)]`). */
  choose<T>(arr: T[]): T {
    return arr[Math.floor(this.randBang(arr.length))]
  }

  /** Random integer in [1, sides]. */
  dice(sides: number): number {
    return Math.floor(this.randBang(sides)) + 1
  }

  /** `use_random_seed s` / `set_seed!(s)` — set seed, reset idx to 0. */
  reset(seed: number): void {
    this.seed = seed
    this.idx = 0
  }

  /**
   * `current_random_seed` = `get_seed_plus_idx` = seed + idx (the position the
   * next draw resolves from, modulo the +1 lookahead).
   */
  getSeedPlusIdx(): number {
    return this.seed + this.idx
  }

  /** `rand_reset` / `set_idx!(count)` — jump the stream position (keep seed). */
  setIdx(count: number): void {
    this.idx = count
  }

  /** `rand_back` / `dec_idx!(amount)` — move the stream position back. */
  decIdx(amount = 1): void {
    this.idx = this.idx - amount
  }

  /** `rand_skip` / `inc_idx!(amount)` — advance the stream position. */
  incIdx(amount = 1): void {
    this.idx = this.idx + amount
  }

  /** Next value without consuming — backs `rand_look`. */
  peek(): number {
    return this.randPeek(1)
  }

  /** Snapshot `(seed, idx)` for save/restore (`with_random_seed`). */
  getState(): { seed: number; idx: number } {
    return { seed: this.seed, idx: this.idx }
  }

  /** Restore a `(seed, idx)` snapshot. */
  setState(state: { seed: number; idx: number }): void {
    this.seed = state.seed
    this.idx = state.idx
  }

  /** Clone state (shares the immutable table). */
  clone(): SPRand {
    const r = new SPRand(this.table, this.seed)
    r.idx = this.idx
    return r
  }
}
