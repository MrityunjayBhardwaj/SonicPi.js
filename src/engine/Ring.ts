/**
 * Circular array — wraps indices so they never go out of bounds.
 * Sonic Pi's `ring()` function returns one of these.
 */
export class Ring<T> {
  private items: T[]
  private _tick = 0;

  /** Numeric index access — ring[0], ring[1], etc. with wrapping. */
  [key: number]: T

  constructor(items: T[]) {
    this.items = [...items]

    // Proxy intercepts numeric bracket access → delegates to .at()
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          const n = Number(prop)
          if (!isNaN(n) && String(n) === prop) {
            return target.at(n)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  get length(): number {
    return this.items.length
  }

  /** Access by index (wraps). */
  at(index: number): T {
    const len = this.items.length
    return this.items[((index % len) + len) % len]
  }

  /** Auto-incrementing access. */
  tick(): T {
    return this.at(this._tick++)
  }

  /** Reset tick counter. */
  resetTick(): void {
    this._tick = 0
  }

  /** Random element (uses Math.random — for seeded, use ctx.choose). */
  choose(): T {
    return this.items[Math.floor(Math.random() * this.items.length)]
  }

  /** Read tick without advancing. */
  look(): T {
    return this.at(this._tick)
  }

  /** Reverse the ring. */
  reverse(): Ring<T> {
    return new Ring([...this.items].reverse())
  }

  /** Shuffle the ring (Fisher-Yates). */
  shuffle(): Ring<T> {
    const arr = [...this.items]
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return new Ring(arr)
  }

  /** Pick n random elements. */
  pick(n: number): Ring<T> {
    const result: T[] = []
    for (let i = 0; i < n; i++) {
      result.push(this.items[Math.floor(Math.random() * this.items.length)])
    }
    return new Ring(result)
  }

  /** First n elements. */
  take(n: number): Ring<T> {
    return new Ring(this.items.slice(0, n))
  }

  /** Drop first n elements. */
  drop(n: number): Ring<T> {
    return new Ring(this.items.slice(n))
  }

  /** Stretch: repeat each element n times. */
  stretch(n: number): Ring<T> {
    const result: T[] = []
    for (const item of this.items) {
      for (let i = 0; i < n; i++) result.push(item)
    }
    return new Ring(result)
  }

  /** Rotate the ring by n positions. Positive = left, negative = right. */
  rotate(n: number = 1): Ring<T> {
    if (this.items.length === 0) return new Ring([])
    const len = this.items.length
    const offset = ((n % len) + len) % len
    return new Ring([...this.items.slice(offset), ...this.items.slice(0, offset)])
  }

  /** Mirror: [1,2,3] → [1,2,3,2,1] */
  mirror(): Ring<T> {
    const mid = this.items.slice(1, -1).reverse()
    return new Ring([...this.items, ...mid])
  }

  /** First element. */
  first(): T { return this.items[0] }

  /** Last element. */
  last(): T { return this.items[this.items.length - 1] }

  /** All elements except the last. */
  butlast(): Ring<T> { return new Ring(this.items.slice(0, -1)) }

  /** Concatenate with another ring or array. */
  concat(other: Ring<T> | T[]): Ring<T> {
    const otherItems = other instanceof Ring ? other.toArray() : other
    return new Ring([...this.items, ...otherItems])
  }

  /** Reflect: like mirror but no middle duplication for even-length. */
  reflect(): Ring<T> { return new Ring([...this.items, ...[...this.items].reverse()]) }

  /** Last n elements. */
  take_last(n: number): Ring<T> { return new Ring(this.items.slice(-n)) }

  /** Remove last n elements. */
  drop_last(n: number): Ring<T> { return new Ring(this.items.slice(0, -n)) }

  /** Sort elements (ascending). */
  sort(): Ring<T> { return new Ring([...this.items].sort((a, b) => (a as number) - (b as number))) }

  /** Multiply all elements by n (numeric rings only). */
  scale(n: number): Ring<number> { return new Ring((this.items as number[]).map(v => v * n)) }

  /** Repeat the ring n times. */
  repeat(n: number): Ring<T> {
    const result: T[] = []
    for (let i = 0; i < n; i++) result.push(...this.items)
    return new Ring(result)
  }

  /** Convert to plain array. */
  toArray(): T[] {
    return [...this.items]
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]()
  }
}

/** Create a Ring from values. */
export function ring<T>(...values: T[]): Ring<T> {
  return new Ring(values)
}

/**
 * Knit: repeat each value N times.
 * knit(:c4, 2, :e4, 1) → Ring([:c4, :c4, :e4])
 */
export function knit<T>(...args: (T | number)[]): Ring<T> {
  const result: T[] = []
  for (let i = 0; i < args.length - 1; i += 2) {
    const value = args[i] as T
    const count = args[i + 1] as number
    for (let j = 0; j < count; j++) result.push(value)
  }
  return new Ring(result)
}

/**
 * Range: generate a sequence of numbers.
 * range(1, 5) → Ring([1, 2, 3, 4])
 * range(1, 10, 2) → Ring([1, 3, 5, 7, 9])
 */
export function range(start: number, end: number, stepOrOpts: number | { step?: number; inclusive?: boolean } = 1): Ring<number> {
  const step = typeof stepOrOpts === 'number' ? stepOrOpts : (stepOrOpts.step ?? 1)
  const result: number[] = []
  const maxSize = 10_000
  if (step > 0) {
    for (let i = start; i < end && result.length < maxSize; i += step) result.push(i)
  } else if (step < 0) {
    for (let i = start; i > end && result.length < maxSize; i += step) result.push(i)
  }
  if (result.length >= maxSize) {
    console.warn('[SonicPi] range() capped at 10000 elements')
  }
  return new Ring(result)
}

/**
 * Non-cycling ring — clamps to last element on overflow instead of wrapping.
 * `ramp(60, 64, 67).at(0) → 60`, `.at(2) → 67`, `.at(5) → 67`.
 */
export class Ramp<T> {
  private items: T[]
  private _tick = 0;

  [key: number]: T

  constructor(items: T[]) {
    this.items = [...items]
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          const n = Number(prop)
          if (!isNaN(n) && String(n) === prop) return target.at(n)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }

  get length(): number { return this.items.length }

  at(index: number): T {
    if (this.items.length === 0) return undefined as T
    if (index <= 0) return this.items[0]
    if (index >= this.items.length) return this.items[this.items.length - 1]
    return this.items[index]
  }

  tick(): T { return this.at(this._tick++) }
  look(): T { return this.at(this._tick) }
  resetTick(): void { this._tick = 0 }
  toArray(): T[] { return [...this.items] }
  [Symbol.iterator](): Iterator<T> { return this.items[Symbol.iterator]() }
}

/** Create a non-cycling Ramp from values. */
export function ramp<T>(...values: T[]): Ramp<T> {
  return new Ramp(values)
}

/** Standalone stretch: `stretch([1,2,3], 2) → Ring([1,1,2,2,3,3])`. */
export function stretch<T>(arr: T[] | Ring<T>, n: number): Ring<T> {
  const items = arr instanceof Ring ? arr.toArray() : [...arr]
  const result: T[] = []
  for (const item of items) {
    for (let i = 0; i < n; i++) result.push(item)
  }
  return new Ring(result)
}

/**
 * `doubles(start, n)` → ring of successive doubling: `doubles(60, 4)` → `Ring([60, 120, 240, 480])`.
 * Negative count delegates to `halves(start, -n)`.
 * Mirrors upstream `core.rb:1950-1960`.
 */
export function doubles(start: number, num_doubles: number = 1): Ring<number> {
  if (typeof start !== 'number') {
    throw new Error(`Start value for doubles needs to be a number, got: ${String(start)}`)
  }
  if (num_doubles < 0) return halves(start, -num_doubles)
  const out: number[] = []
  let v = start
  for (let i = 0; i < num_doubles; i++) {
    out.push(v)
    v *= 2
  }
  return new Ring(out)
}

/**
 * `halves(start, n)` → ring of successive halving: `halves(60, 4)` → `Ring([60, 30, 15, 7.5])`.
 * Negative count delegates to `doubles(start, -n)`.
 * Mirrors upstream `core.rb:1919-1929`.
 */
export function halves(start: number, num_halves: number = 1): Ring<number> {
  if (typeof start !== 'number') {
    throw new Error(`Start value for halves needs to be a number, got: ${String(start)}`)
  }
  if (num_halves < 0) return doubles(start, -num_halves)
  const out: number[] = []
  let v = start
  for (let i = 0; i < num_halves; i++) {
    out.push(v)
    v /= 2
  }
  return new Ring(out)
}

/**
 * Line: generate a line of N values between start and end.
 * line(60, 72, 5) → Ring([60, 63, 66, 69, 72])
 */
export function line(start: number, finish: number, stepsOrOpts: number | { steps?: number; inclusive?: boolean } = 4): Ring<number> {
  const steps = typeof stepsOrOpts === 'number' ? stepsOrOpts : (stepsOrOpts.steps ?? 4)
  const result: number[] = []
  for (let i = 0; i < steps; i++) {
    result.push(steps === 1 ? start : start + (finish - start) * (i / (steps - 1)))
  }
  return new Ring(result)
}
