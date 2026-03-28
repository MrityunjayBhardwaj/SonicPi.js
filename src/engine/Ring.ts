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

  /** Mirror: [1,2,3] → [1,2,3,2,1] */
  mirror(): Ring<T> {
    const mid = this.items.slice(1, -1).reverse()
    return new Ring([...this.items, ...mid])
  }

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
export function range(start: number, end: number, step: number = 1): Ring<number> {
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
 * Line: generate a line of N values between start and end.
 * line(60, 72, 5) → Ring([60, 63, 66, 69, 72])
 */
export function line(start: number, finish: number, steps: number = 4): Ring<number> {
  const result: number[] = []
  for (let i = 0; i < steps; i++) {
    result.push(start + (finish - start) * (i / (steps - 1)))
  }
  return new Ring(result)
}
