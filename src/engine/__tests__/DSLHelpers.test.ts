import { describe, it, expect } from 'vitest'
import { SeededRandom } from '../SeededRandom'
import { Ring, ring } from '../Ring'
import { spread } from '../EuclideanRhythm'
import { noteToMidi, midiToFreq, noteToFreq } from '../NoteToFreq'
import { MidiBridge } from '../MidiBridge'

describe('SeededRandom', () => {
  it('is deterministic with same seed', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)

    const seqA = Array.from({ length: 10 }, () => a.next())
    const seqB = Array.from({ length: 10 }, () => b.next())

    expect(seqA).toEqual(seqB)
  })

  it('produces different sequences for different seeds', () => {
    const a = new SeededRandom(1)
    const b = new SeededRandom(2)

    expect(a.next()).not.toBe(b.next())
  })

  it('rrand stays in range', () => {
    const r = new SeededRandom(0)
    for (let i = 0; i < 100; i++) {
      const v = r.rrand(10, 20)
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThanOrEqual(20)
    }
  })

  it('choose returns elements from array', () => {
    const r = new SeededRandom(0)
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(r.choose(arr))
    }
  })

  it('dice returns integers in [1, sides]', () => {
    const r = new SeededRandom(0)
    for (let i = 0; i < 100; i++) {
      const v = r.dice(6)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(6)
      expect(Number.isInteger(v)).toBe(true)
    }
  })

  it('reset restores determinism', () => {
    const r = new SeededRandom(42)
    const v1 = r.next()
    r.reset(42)
    const v2 = r.next()
    expect(v1).toBe(v2)
  })

  it('matches Sonic Pi (Ruby MT19937) output for seed 0', () => {
    const r = new SeededRandom(0)
    // Ruby: Random.new(0).rand => 0.5488135039273248
    expect(r.next()).toBeCloseTo(0.5488135039273248, 15)
  })

  it('matches Sonic Pi (Ruby MT19937) output for seed 42', () => {
    const r = new SeededRandom(42)
    // Ruby: Random.new(42).rand => 0.37454011884736246
    expect(r.next()).toBeCloseTo(0.37454011884736246, 14)
  })

  it('clone preserves MT19937 state', () => {
    const r = new SeededRandom(123)
    r.next() // advance state
    r.next()
    const c = r.clone()
    const seq1 = Array.from({ length: 5 }, () => r.next())
    const seq2 = Array.from({ length: 5 }, () => c.next())
    expect(seq1).toEqual(seq2)
  })
})

describe('Ring', () => {
  it('wraps positive indices', () => {
    const r = ring(1, 2, 3)
    expect(r.at(0)).toBe(1)
    expect(r.at(3)).toBe(1)
    expect(r.at(5)).toBe(3)
  })

  it('wraps negative indices', () => {
    const r = ring(1, 2, 3)
    expect(r.at(-1)).toBe(3)
    expect(r.at(-4)).toBe(3)
  })

  it('tick auto-increments', () => {
    const r = ring('a', 'b', 'c')
    expect(r.tick()).toBe('a')
    expect(r.tick()).toBe('b')
    expect(r.tick()).toBe('c')
    expect(r.tick()).toBe('a') // wraps
  })

  it('is iterable', () => {
    const r = ring(1, 2, 3)
    expect([...r]).toEqual([1, 2, 3])
  })
})

describe('spread (Euclidean rhythm)', () => {
  it('spread(3, 8) matches known Euclidean pattern', () => {
    const pattern = spread(3, 8).toArray()
    expect(pattern).toEqual([true, false, false, true, false, false, true, false])
  })

  it('spread(5, 8) matches known pattern', () => {
    const pattern = spread(5, 8).toArray()
    expect(pattern).toEqual([true, false, true, true, false, true, true, false])
  })

  it('spread(0, 4) is all false', () => {
    expect(spread(0, 4).toArray()).toEqual([false, false, false, false])
  })

  it('spread(4, 4) is all true', () => {
    expect(spread(4, 4).toArray()).toEqual([true, true, true, true])
  })

  it('spread with rotation shifts the pattern', () => {
    const base = spread(3, 8).toArray()
    const rotated = spread(3, 8, 1).toArray()
    expect(rotated).toEqual([...base.slice(1), base[0]])
  })

  it('returns a Ring', () => {
    const r = spread(3, 8)
    expect(r).toBeInstanceOf(Ring)
    // Ring wraps
    expect(r.at(8)).toBe(r.at(0))
  })
})

describe('NoteToFreq', () => {
  it('c4 → MIDI 60', () => {
    expect(noteToMidi('c4')).toBe(60)
  })

  it('a4 → MIDI 69', () => {
    expect(noteToMidi('a4')).toBe(69)
  })

  it('handles sharps', () => {
    expect(noteToMidi('cs4')).toBe(61)
    expect(noteToMidi('c#4')).toBe(61)
  })

  it('handles flats', () => {
    expect(noteToMidi('eb4')).toBe(63)
  })

  it('handles numeric strings', () => {
    expect(noteToMidi('60')).toBe(60)
  })

  it('handles numbers', () => {
    expect(noteToMidi(72)).toBe(72)
  })

  it('default octave is 4', () => {
    expect(noteToMidi('c')).toBe(60)
  })

  it('a4 → 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 1)
  })

  it('noteToFreq combines both', () => {
    expect(noteToFreq('a4')).toBeCloseTo(440, 1)
  })
})

describe('MidiBridge — CC state', () => {
  it('returns 0 for unseen controller', () => {
    const bridge = new MidiBridge()
    expect(bridge.getCCValue(7)).toBe(0)
  })

  it('returns injected value for controller on default channel', () => {
    const bridge = new MidiBridge()
    bridge.setCCValue(7, 64)
    expect(bridge.getCCValue(7)).toBe(64)
  })

  it('is channel-specific', () => {
    const bridge = new MidiBridge()
    bridge.setCCValue(1, 100, 1)
    bridge.setCCValue(1, 42, 2)
    expect(bridge.getCCValue(1, 1)).toBe(100)
    expect(bridge.getCCValue(1, 2)).toBe(42)
  })

  it('returns 0 on unset channel even if another channel has a value', () => {
    const bridge = new MidiBridge()
    bridge.setCCValue(10, 127, 1)
    expect(bridge.getCCValue(10, 2)).toBe(0)
  })

  it('latest write wins', () => {
    const bridge = new MidiBridge()
    bridge.setCCValue(7, 50)
    bridge.setCCValue(7, 99)
    expect(bridge.getCCValue(7)).toBe(99)
  })
})

describe('MidiBridge — pitch bend state', () => {
  it('returns 0 before any pitch bend received', () => {
    const bridge = new MidiBridge()
    expect(bridge.getPitchBend(1)).toBe(0)
  })

  it('fires pitch_bend event and stores normalised value', () => {
    const bridge = new MidiBridge()
    const events: number[] = []
    bridge.onMidiEvent(e => { if (e.type === 'pitch_bend') events.push(e.value as number) })

    // Simulate 0xE0 message: centre = 0x2000 (LSB=0x00, MSB=0x40)
    const centre = 8192
    const lsb = centre & 0x7F       // 0x00
    const msb = (centre >> 7) & 0x7F // 0x40
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xE0, lsb, msb]) })

    expect(events[0]).toBeCloseTo(0, 5)
    expect(bridge.getPitchBend(1)).toBeCloseTo(0, 5)
  })

  it('full positive bend ≈ +1', () => {
    const bridge = new MidiBridge()
    // 0x3FFF = 16383: max positive
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xE0, 0x7F, 0x7F]) })
    expect(bridge.getPitchBend(1)).toBeCloseTo(1, 2)
  })

  it('full negative bend ≈ -1', () => {
    const bridge = new MidiBridge()
    // 0x0000 = 0: max negative
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xE0, 0x00, 0x00]) })
    expect(bridge.getPitchBend(1)).toBeCloseTo(-1, 2)
  })

  it('is channel-specific', () => {
    const bridge = new MidiBridge()
    // Ch1 full positive, Ch2 full negative
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xE0, 0x7F, 0x7F]) }) // ch1
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xE1, 0x00, 0x00]) }) // ch2
    expect(bridge.getPitchBend(1)).toBeCloseTo(1, 2)
    expect(bridge.getPitchBend(2)).toBeCloseTo(-1, 2)
  })
})

describe('MidiBridge — input event parsing', () => {
  function makeBridge() {
    const bridge = new MidiBridge()
    const events: Parameters<import('../MidiBridge').MidiEventHandler>[0][] = []
    bridge.onMidiEvent(e => events.push(e))
    return { bridge, events }
  }

  it('parses note_on', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0x90, 60, 100]) })
    expect(events[0]).toMatchObject({ type: 'note_on', channel: 1, note: 60, velocity: 100 })
  })

  it('treats note_on velocity 0 as note_off', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0x90, 60, 0]) })
    expect(events[0].type).toBe('note_off')
  })

  it('parses note_off', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0x80, 48, 64]) })
    expect(events[0]).toMatchObject({ type: 'note_off', channel: 1, note: 48 })
  })

  it('parses CC and updates state', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xB0, 74, 100]) })
    expect(events[0]).toMatchObject({ type: 'cc', channel: 1, cc: 74, value: 100 })
    expect(bridge.getCCValue(74, 1)).toBe(100)
  })

  it('parses channel pressure', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xD0, 80]) })
    expect(events[0]).toMatchObject({ type: 'channel_pressure', channel: 1, value: 80 })
  })

  it('parses poly pressure', () => {
    const { bridge, events } = makeBridge()
    ;(bridge as any).handleMidiMessage({ data: new Uint8Array([0xA0, 60, 64]) })
    expect(events[0]).toMatchObject({ type: 'poly_pressure', channel: 1, note: 60, value: 64 })
  })
})

describe('MidiBridge — output send routing', () => {
  /** Mock MIDIOutput that records sent bytes. */
  function mockOutput() {
    const sent: number[][] = []
    return {
      id: 'mock',
      send: (data: number[]) => sent.push([...data]),
      sent,
    } as unknown as MIDIOutput & { sent: number[][] }
  }

  function bridgeWithOutput() {
    const bridge = new MidiBridge()
    const out = mockOutput()
    ;(bridge as any).selectedOutputs = [out]
    return { bridge, out }
  }

  it('midi_note_on sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.noteOn(60, 100, 1)
    expect(out.sent[0]).toEqual([0x90, 60, 100])
  })

  it('midi_note_off sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.noteOff(60, 1)
    expect(out.sent[0]).toEqual([0x80, 60, 0])
  })

  it('midi_cc sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.cc(74, 64, 1)
    expect(out.sent[0]).toEqual([0xB0, 74, 64])
  })

  it('midi_pitch_bend centre sends 0x2000', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.pitchBend(0, 1)
    const [status, lsb, msb] = out.sent[0]
    expect(status).toBe(0xE0)
    const raw = (msb << 7) | lsb
    expect(raw).toBe(8192) // 0x2000 = centre
  })

  it('midi_pitch_bend +1 sends 0x3FFF', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.pitchBend(1, 1)
    const [, lsb, msb] = out.sent[0]
    const raw = (msb << 7) | lsb
    expect(raw).toBe(16383)
  })

  it('midi_channel_pressure sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.channelPressure(80, 1)
    expect(out.sent[0]).toEqual([0xD0, 80])
  })

  it('midi_poly_pressure sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.polyPressure(60, 64, 1)
    expect(out.sent[0]).toEqual([0xA0, 60, 64])
  })

  it('midi_prog_change sends correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.programChange(42, 1)
    expect(out.sent[0]).toEqual([0xC0, 42])
  })

  it('midi_clock_tick sends 0xF8', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.clockTick()
    expect(out.sent[0]).toEqual([0xF8])
  })

  it('transport messages send correct bytes', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.midiStart()
    bridge.midiStop()
    bridge.midiContinue()
    expect(out.sent[0]).toEqual([0xFA])
    expect(out.sent[1]).toEqual([0xFC])
    expect(out.sent[2]).toEqual([0xFB])
  })

  it('sends to multiple outputs simultaneously', () => {
    const bridge = new MidiBridge()
    const out1 = mockOutput()
    const out2 = mockOutput()
    ;(bridge as any).selectedOutputs = [out1, out2]
    bridge.noteOn(60, 100, 1)
    expect(out1.sent[0]).toEqual([0x90, 60, 100])
    expect(out2.sent[0]).toEqual([0x90, 60, 100])
  })

  it('channel offset is applied correctly for ch16', () => {
    const { bridge, out } = bridgeWithOutput()
    bridge.noteOn(60, 100, 16)
    expect(out.sent[0][0]).toBe(0x9F) // 0x90 | 15
  })
})
