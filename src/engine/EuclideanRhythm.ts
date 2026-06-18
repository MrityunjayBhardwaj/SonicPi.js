import { Ring } from './Ring'

/**
 * Bjorklund algorithm for Euclidean rhythms.
 * spread(3, 8) → [true, false, false, true, false, false, true, false]
 */
export function spread(hits: number, total: number, rotation: number = 0): Ring<boolean> {
  if (hits >= total) return new Ring(Array(total).fill(true))
  if (hits <= 0) return new Ring(Array(total).fill(false))

  let pattern = bjorklund(hits, total)

  // Apply rotation
  if (rotation !== 0) {
    const r = ((rotation % total) + total) % total
    pattern = [...pattern.slice(r), ...pattern.slice(0, r)]
  }

  return new Ring(pattern)
}

/**
 * Exact port of desktop Sonic Pi's Euclidean distribution (core.rb:1700-1714,
 * `redistribute` + `spread`). NOT a generic Bjorklund: desktop's `redistribute`
 * uses `vNew.unshift(a1 + a2)` (PREPEND), which produces a different placement
 * than the textbook "head/tail merge" Bjorklund for the dense `spread(s-1, s)`
 * family — desktop puts the lone rest at index 1 (`X.XXX…`) where a textbook
 * Bjorklund puts it last (`XXX…X.`). That single-position difference desynced the
 * PRNG stream in dense random blocks: a `play … if spread(rrand_i, n).look` guard
 * fired on desktop but not on web (or vice versa), so the conditional `rand` draw
 * count diverged and every later draw shifted (#597 / SP167). Matching desktop's
 * algorithm exactly guarantees per-index parity across ALL (hits, total).
 */
function redistribute(v1: boolean[][], v2: boolean[][]): [boolean[][], boolean[][]] {
  const vNew: boolean[][] = []
  // shift consumes from the front; operate on copies so callers' arrays stand.
  const a = v1.slice()
  const b = v2.slice()
  while (a.length > 0 && b.length > 0) {
    const a1 = a.shift()!
    const a2 = b.shift()!
    vNew.unshift([...a1, ...a2])
  }
  return a.length > 0 ? [vNew, a] : [vNew, b]
}

function bjorklund(hits: number, total: number): boolean[] {
  let v1: boolean[][] = Array.from({ length: hits }, () => [true])
  let v2: boolean[][] = Array.from({ length: total - hits }, () => [false])
  ;[v1, v2] = redistribute(v1, v2)
  while (v2.length > 1) {
    ;[v1, v2] = redistribute(v1, v2)
  }
  return [...v1, ...v2].flat()
}
