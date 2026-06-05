/**
 * #379 — `density d do…end` must SQUASH AND REPEAT: desktop `density(d)`
 * (core.rb:3973-3987) compresses the block's bpm by `d` AND runs the block
 * `reps.times` (reps = d<1 ? 1 : d). Our transpiler previously only compressed
 * time and ran the body ONCE, so `density 2 do A; B end` played `A B` where
 * desktop plays `A B A B` (verified Level-2 event-parity desktop 6 / web was 4).
 *
 * Also: `with_density` is NOT a Sonic Pi function (desktop has only `density`
 * and raises on `with_density`). We run it AS `density` and warn via Sp95Lint.
 */
import { describe, it, expect } from 'vitest'
import { autoTranspile } from '../TreeSitterTranspiler'
import { detectSp95Limitations } from '../Sp95Lint'

describe('#379 density squash-AND-repeat', () => {
  it('density 2 emits a reps loop (block runs Math.floor(d) times)', () => {
    const out = autoTranspile('density 2 do\n  play 67\n  sleep 0.5\nend')
    // reps computed at runtime from the factor; body wrapped in a for-loop
    expect(out).toMatch(/const __dreps = __df < 1 \? 1 : Math\.floor\(__df\)/)
    expect(out).toMatch(/for \(let __di = 0; __di < __dreps; __di\+\+\)/)
    // still compresses time (density factor applied)
    expect(out).toMatch(/\.density = __prevDensity \* __df/)
  })

  it('density passes the factor through to __df once (no double-eval)', () => {
    const out = autoTranspile('density 2 do\n  play 60\nend')
    expect(out).toMatch(/const __df = 2/)
  })

  it('with_density routes to density (NOT the compress-only __b.with_density)', () => {
    const out = autoTranspile('with_density 2 do\n  play 67\n  sleep 0.5\nend')
    // routed through transpileDensity → has the reps loop …
    expect(out).toMatch(/for \(let __di = 0; __di < __dreps; __di\+\+\)/)
    // … and does NOT emit a builder with_density call
    expect(out).not.toMatch(/with_density\(/)
  })

  it('nested density blocks do not collide (block-scoped consts)', () => {
    const out = autoTranspile(
      'density 2 do\n  density 3 do\n    play 60\n  end\nend'
    )
    // two independent reps loops emitted
    expect((out.match(/for \(let __di = 0; __di < __dreps; __di\+\+\)/g) ?? []).length).toBe(2)
  })
})

describe('#379 with_density build-time warning (loud-not-silent)', () => {
  it('warns that with_density is not a Sonic Pi function', () => {
    const ws = detectSp95Limitations('with_density 2 do\n  play 60\nend')
    expect(ws).toHaveLength(1)
    expect(ws[0].pattern).toBe('with_density')
    expect(ws[0].message).toMatch(/density/)
  })

  it('does NOT warn on the real density (negative control)', () => {
    expect(detectSp95Limitations('density 2 do\n  play 60\nend')).toHaveLength(0)
  })

  it('does NOT warn when with_density appears only in a comment', () => {
    expect(detectSp95Limitations('# with_density is not real\ndensity 2 do\n  play 60\nend')).toHaveLength(0)
  })
})

describe('#473 density block as the SOLE top-level statement', () => {
  // A density block routes its body to `bareCode` and emits bare play/sleep,
  // relying on the `__run_once` wrapper to rewrite them to `__b.play`/`__b.sleep`.
  // When density is the ONLY top-level statement, nothing else trips the wrap
  // gate → the body emitted bare `play(...)` with no `__b` in scope → runtime
  // `play is not a function`. The fix makes `density`/`with_density` trip the
  // gate, like the sibling `.times`/`.each` constructs.

  it('wraps a density-only program in __run_once (so play has __b in scope)', () => {
    const out = autoTranspile('density 2 do\n  play 67\n  sleep 0.5\nend')
    // the body is rewritten through the builder, not left bare
    expect(out).toMatch(/__run_once/)
    expect(out).toMatch(/__b\.play\(67/)
    expect(out).toMatch(/__b\.sleep\(0\.5\)/)
    // the throwaway placeholder object must NOT be emitted at top level
    expect(out).not.toMatch(/__densityB/)
    // and there is no bare `play(` left dangling outside the builder
    expect(out).not.toMatch(/(^|\n)\s*play\(/)
  })

  it('wraps a with_density-only program too (alias routes through density)', () => {
    const out = autoTranspile('with_density 2 do\n  play 67\n  sleep 0.5\nend')
    expect(out).toMatch(/__run_once/)
    expect(out).toMatch(/__b\.play\(67/)
    expect(out).not.toMatch(/(^|\n)\s*play\(/)
  })

  it('density preceded only by a top-level setting still wraps (use_bpm is hoisted, not bare)', () => {
    const out = autoTranspile('use_bpm 120\ndensity 2 do\n  play 67\n  sleep 0.5\nend')
    expect(out).toMatch(/__run_once/)
    expect(out).toMatch(/__b\.play\(67/)
    expect(out).not.toMatch(/(^|\n)\s*play\(/)
  })

  it('density WITH surrounding bare code is unchanged (no regression — still wraps)', () => {
    const out = autoTranspile('play 60\ndensity 2 do\n  play 67\nend\nsleep 1')
    expect(out).toMatch(/__run_once/)
    expect(out).toMatch(/__b\.play\(60/)
    expect(out).toMatch(/__b\.play\(67/)
  })
})
