import { describe, it, expect } from 'vitest'
import { isAsyncByConstruction } from '../capture'

/**
 * Guards the capture `--wrap-recording` classification (#501).
 *
 * `isAsyncByConstruction(code)` decides whether user code returns immediately
 * (top-level live_loop / loop → run bare, preserve with_fx FX routing) or
 * BLOCKS the main thread (→ wrap in in_thread so the recording window stays
 * bounded to --duration). The original heuristic also matched `in_thread`,
 * which false-positive-classified bare-sequential pieces with a NESTED
 * in_thread (bach.rb) as async → unbounded render (sweep timeout #429) +
 * window-misaligned, ungradeable capture (#406). These cases lock the contract.
 */
describe('isAsyncByConstruction (capture --wrap-recording classifier)', () => {
  it('treats top-level live_loop as async (skip wrap)', () => {
    expect(isAsyncByConstruction('live_loop :a do\n  play 60\n  sleep 1\nend')).toBe(true)
  })

  it('treats a top-level bare `loop do` as async (skip wrap — SP111)', () => {
    expect(isAsyncByConstruction('loop do\n  play 60\n  sleep 1\nend')).toBe(true)
  })

  it('treats a `loop` indented inside with_fx as async — crushed.rb stays FX-routed', () => {
    // The loop is indented; the regex must allow leading whitespace or crushed
    // would be wrapped and lose its FX bus (SV30, #426).
    const crushed = 'with_fx :bitcrusher do\n  loop do\n    play 50\n    sleep 0.5\n  end\nend'
    expect(isAsyncByConstruction(crushed)).toBe(true)
  })

  it('#501: a NESTED in_thread inside bare-sequential code is NOT async (must wrap)', () => {
    // bach.rb shape: top level is `2.times { ... }` (blocks) with in_thread
    // nested inside. The program does NOT return immediately, so it must be
    // wrapped to bound the recording window.
    const bachShape =
      'use_bpm 60\n' +
      '2.times do\n' +
      '  in_thread do\n' +
      '    play 40\n' +
      '    sleep 8\n' +
      '  end\n' +
      '  play_pattern_timed [:c4, :e4], [0.5, 0.5]\n' +
      'end'
    expect(isAsyncByConstruction(bachShape)).toBe(false)
  })

  it('a top-level in_thread alone is NOT treated as async (#501 — wrapping it is harmless and bounds the window)', () => {
    expect(isAsyncByConstruction('in_thread do\n  play 60\n  sleep 1\nend')).toBe(false)
  })

  it('a top-level with_fx over blocking N.times (no loop) is NOT async — orchard_improv.rb stays wrapped', () => {
    const orchardShape = 'with_fx :reverb do\n  100.times do\n    play 60\n    sleep 0.28\n  end\nend'
    expect(isAsyncByConstruction(orchardShape)).toBe(false)
  })

  it('plain bare-sequential code is NOT async (must wrap)', () => {
    expect(isAsyncByConstruction('play 60\nsleep 1\nplay 64')).toBe(false)
  })

  it('does not match identifiers that merely contain the keywords', () => {
    // `looper`, `my_loop` etc. must not trip the \b-anchored match.
    expect(isAsyncByConstruction('looper = 5\nplay looper')).toBe(false)
    expect(isAsyncByConstruction('my_live_loop = 1')).toBe(false)
  })
})
