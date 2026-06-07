import { describe, it, expect } from 'vitest'
import { EventHistory } from '../EventHistory'

/**
 * GAP M1b — path-aware (glob) reads over EventHistory. These exercise the
 * scan-and-merge across matching keys; the (t, idPath) ordering itself is
 * covered by the GAP A2 EventHistory tests.
 */
describe('EventHistory — glob getMostRecent (set/cue/live_loop union)', () => {
  it('a glob read returns the GREATEST e<=ge across all matching keys', () => {
    const eh = new EventHistory()
    eh.insert('/set/foo', 1, [0], 'set@1')
    eh.insert('/cue/foo', 2, [0], 'cue@2')
    eh.insert('/live_loop/foo', 0.5, [0], 'll@0.5')
    // reader at t=5 sees all three; greatest is cue@2.
    expect(eh.getMostRecent('/{cue,set,live_loop}/foo', 5, [0])?.value).toBe('cue@2')
    // reader at t=1.5 excludes cue@2 (t=2 > 1.5); greatest <= is set@1.
    expect(eh.getMostRecent('/{cue,set,live_loop}/foo', 1.5, [0])?.value).toBe('set@1')
  })

  it('a glob read ignores non-matching keys', () => {
    const eh = new EventHistory()
    eh.insert('/set/foo', 1, [0], 'foo')
    eh.insert('/set/bar', 2, [0], 'bar')
    expect(eh.getMostRecent('/{cue,set,live_loop}/foo', 5, [0])?.value).toBe('foo')
  })

  it('glob-free read keeps exact behaviour (no cross-key bleed)', () => {
    const eh = new EventHistory()
    eh.insert('/set/foo', 1, [0], 'set')
    eh.insert('/cue/foo', 2, [0], 'cue')
    // exact /set/foo must NOT see /cue/foo.
    expect(eh.getMostRecent('/set/foo', 5, [0])?.value).toBe('set')
    expect(eh.getMostRecent('/cue/foo', 5, [0])?.value).toBe('cue')
  })
})

describe('EventHistory — glob getNextDelivered (sync across the union)', () => {
  it('wakes on the SMALLEST deliverable cue across matching keys', () => {
    const eh = new EventHistory()
    // waiter at t=0, idPath [0] (root). Strictly-later cues are deliverable.
    eh.insert('/cue/foo', 3, [0, 0], 'cue@3')
    eh.insert('/live_loop/foo', 1, [0, 0], 'll@1')
    // smallest deliverable (earliest t) across the union is ll@1.
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0])?.value).toBe('ll@1')
  })

  it('a set DOES wake a glob sync (the GAP M cross-namespace behaviour)', () => {
    const eh = new EventHistory()
    eh.insert('/set/foo', 2, [0, 0], 'set@2')
    // Under the old separate-store world this could not happen; the union allows it.
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0])?.value).toBe('set@2')
  })

  it('returns null when nothing matching is deliverable', () => {
    const eh = new EventHistory()
    eh.insert('/cue/bar', 3, [0, 0], 'bar')
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0])).toBeNull()
  })
})

describe('EventHistory — getNextDelivered valMatcher (GAP M2 arg_matcher)', () => {
  it('skips value-rejected cues and returns the next matching deliverable', () => {
    const eh = new EventHistory()
    eh.insert('/cue/foo', 1, [0, 0], { args: [3], bpm: 60 })
    eh.insert('/cue/foo', 2, [0, 0], { args: [9], bpm: 60 })
    const m = (v: unknown) => (v as { args: number[] }).args[0] > 5
    // Without the matcher the smallest deliverable is t=1 (args 3); with it,
    // t=1 is value-rejected so the next deliverable t=2 (args 9) is returned.
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0], undefined, m)?.t).toBe(2)
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0])?.t).toBe(1)
  })

  it('returns null when no deliverable cue passes the matcher', () => {
    const eh = new EventHistory()
    eh.insert('/cue/foo', 1, [0, 0], { args: [3], bpm: 60 })
    const m = (v: unknown) => (v as { args: number[] }).args[0] > 5
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0], undefined, m)).toBeNull()
  })

  it('a throwing matcher is treated as non-matching, never propagates', () => {
    const eh = new EventHistory()
    eh.insert('/cue/foo', 1, [0, 0], { args: [3], bpm: 60 })
    const boom = () => { throw new Error('bad matcher') }
    expect(() => eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0], undefined, boom)).not.toThrow()
    expect(eh.getNextDelivered('/{cue,set,live_loop}/foo', 0, [0], undefined, boom)).toBeNull()
  })
})
