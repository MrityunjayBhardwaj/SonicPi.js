/**
 * Deterministic PRNG using Mersenne Twister (MT19937).
 *
 * Matches Sonic Pi's random system, which uses Ruby's Random class
 * (also MT19937). This means `use_random_seed 42` produces the same
 * sequence in the browser as on desktop Sonic Pi.
 *
 * Each live_loop task gets its own SeededRandom instance.
 */

const N = 624
const M = 397
const MATRIX_A = 0x9908b0df
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff

export class SeededRandom {
  private mt: Int32Array
  private mti: number
  /** Last seed passed to constructor or reset() — used by rand_reset / current_random_seed (#227). */
  private _lastSeed: number = 0
  /** Number of next() / genrandInt32() draws since the last seed/reset — used by rand_back / current_random_seed (#227). */
  private _idx: number = 0

  constructor(seed: number = 0) {
    this.mt = new Int32Array(N)
    this.mti = N + 1
    this._lastSeed = seed >>> 0
    this._idx = 0
    this.initGenrand(seed >>> 0)
  }

  /** Initialize the state array with a seed. */
  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0
    for (this.mti = 1; this.mti < N; this.mti++) {
      // Knuth's TAOCP Vol2, 3rd Ed. p.106 multiplier
      const prev = this.mt[this.mti - 1]
      this.mt[this.mti] =
        (Math.imul(1812433253, prev ^ (prev >>> 30)) + this.mti) >>> 0
    }
  }

  /** Generate the next 32-bit unsigned integer. */
  private genrandInt32(): number {
    let y: number
    const mag01 = [0, MATRIX_A]

    if (this.mti >= N) {
      let kk: number

      for (kk = 0; kk < N - M; kk++) {
        y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)
        this.mt[kk] = this.mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1]
      }
      for (; kk < N - 1; kk++) {
        y = (this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)
        this.mt[kk] = this.mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1]
      }
      y = (this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK)
      this.mt[N - 1] = this.mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1]

      this.mti = 0
    }

    y = this.mt[this.mti++]

    // Tempering
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18

    return y >>> 0
  }

  /** Return a float in [0, 1). Matches Ruby's Random#rand. */
  next(): number {
    // Ruby generates a 53-bit float from two 32-bit values:
    // (a * 2^26 + b) / 2^53  where a = top 27 bits, b = top 26 bits
    const a = this.genrandInt32() >>> 5 // 27 bits
    const b = this.genrandInt32() >>> 6 // 26 bits
    this._idx++
    return (a * 67108864.0 + b) / 9007199254740992.0
  }

  /** Random float in [min, max]. */
  rrand(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Random int in [min, max]. */
  rrand_i(min: number, max: number): number {
    return Math.floor(this.rrand(min, max + 1))
  }

  /** Random element from array. */
  choose<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)]
  }

  /** Random integer in [1, sides]. */
  dice(sides: number): number {
    return Math.floor(this.next() * sides) + 1
  }

  /** Reset seed. */
  reset(seed: number): void {
    this._lastSeed = seed >>> 0
    this._idx = 0
    this.initGenrand(seed >>> 0)
  }

  /**
   * Read the seed-plus-index — matches Desktop SP's `current_random_seed`
   * (`SPRand.get_seed_plus_idx`). Increments by one for each `next()` draw. (#227)
   */
  getSeedPlusIdx(): number {
    return this._lastSeed + this._idx
  }

  /**
   * Re-seed to the last seed and skip forward `count` draws. Used by
   * rand_back / rand_reset / rand_skip (#227). MT19937 isn't trivially
   * reversible, so we re-init and replay forward — cheap enough for the
   * `rand_back(small N)` use case (one Knuth init + N draws).
   */
  setIdx(count: number): void {
    if (count < 0) count = 0
    this.initGenrand(this._lastSeed)
    this._idx = 0
    for (let i = 0; i < count; i++) this.next()
  }

  /** Decrement idx by `amount` (clamped at 0). Matches Desktop SP rand_back. (#227) */
  decIdx(amount: number = 1): void {
    this.setIdx(Math.max(0, this._idx - amount))
  }

  /** Increment idx by `amount` (advance the stream). Matches Desktop SP rand_skip. (#227) */
  incIdx(amount: number = 1): void {
    for (let i = 0; i < amount; i++) this.next()
  }

  /** Clone current state. */
  clone(): SeededRandom {
    const r = new SeededRandom()
    r.mt.set(this.mt)
    r.mti = this.mti
    r._lastSeed = this._lastSeed
    r._idx = this._idx
    return r
  }

  /** Snapshot state for save/restore (used by with_random_seed). */
  getState(): { mt: Uint32Array; mti: number; lastSeed: number; idx: number } {
    return { mt: new Uint32Array(this.mt), mti: this.mti, lastSeed: this._lastSeed, idx: this._idx }
  }

  /** Restore state from snapshot. */
  setState(state: { mt: Uint32Array; mti: number; lastSeed?: number; idx?: number }): void {
    this.mt.set(state.mt)
    this.mti = state.mti
    if (state.lastSeed !== undefined) this._lastSeed = state.lastSeed
    if (state.idx !== undefined) this._idx = state.idx
  }

  /** Return next value without advancing state. */
  peek(): number {
    const clone = this.clone()
    return clone.next()
  }
}
