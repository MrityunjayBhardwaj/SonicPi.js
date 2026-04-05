import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'
import { hzToMidi, midiToFreq, noteToMidi } from '../NoteToFreq'
import { chord_degree, degree, chord_names, scale_names } from '../ChordScale'
import { autoTranspileDetailed } from '../RubyTranspiler'

// ---------------------------------------------------------------------------
// NoteToFreq additions
// ---------------------------------------------------------------------------

describe('hzToMidi', () => {
  it('440 Hz → 69 (A4)', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 5)
  })

  it('261.63 Hz ≈ 60 (C4)', () => {
    expect(hzToMidi(261.63)).toBeCloseTo(60, 0)
  })

  it('roundtrip: midiToFreq → hzToMidi', () => {
    for (const midi of [36, 48, 60, 69, 72, 84, 96]) {
      expect(hzToMidi(midiToFreq(midi))).toBeCloseTo(midi, 5)
    }
  })

  it('880 Hz → 81 (A5)', () => {
    expect(hzToMidi(880)).toBeCloseTo(81, 5)
  })
})

// ---------------------------------------------------------------------------
// ChordScale additions
// ---------------------------------------------------------------------------

describe('chord_degree', () => {
  it('degree :i of C major → C major triad', () => {
    const notes = chord_degree('i', 'c4', 'major').toArray()
    expect(notes).toEqual([60, 64, 67]) // C E G
  })

  it('degree :ii of C major → D minor triad', () => {
    const notes = chord_degree('ii', 'c4', 'major').toArray()
    expect(notes).toEqual([62, 65, 69]) // D F A
  })

  it('degree :v of C major → G major triad', () => {
    const notes = chord_degree('v', 'c4', 'major').toArray()
    expect(notes).toEqual([67, 71, 74]) // G B D (stacked thirds from 5th degree)
  })

  it('accepts integer degrees (1-based)', () => {
    const notes = chord_degree(1, 'c4', 'major').toArray()
    expect(notes).toEqual([60, 64, 67])
  })

  it('4-note chords', () => {
    const notes = chord_degree('i', 'c4', 'major', 4).toArray()
    expect(notes.length).toBe(4)
    expect(notes[0]).toBe(60) // C
    expect(notes[1]).toBe(64) // E
    expect(notes[2]).toBe(67) // G
    expect(notes[3]).toBe(71) // B
  })

  it('returns a Ring', () => {
    const r = chord_degree('i', 'c4', 'major')
    expect(r.at(3)).toBe(60) // wraps
  })
})

describe('degree', () => {
  it('degree :i of C major → 60 (C4)', () => {
    expect(degree('i', 'c4', 'major')).toBe(60)
  })

  it('degree :ii of C major → 62 (D4)', () => {
    expect(degree('ii', 'c4', 'major')).toBe(62)
  })

  it('degree :v of C major → 67 (G4)', () => {
    expect(degree('v', 'c4', 'major')).toBe(67)
  })

  it('accepts integer degrees (1-based)', () => {
    expect(degree(1, 'c4', 'major')).toBe(60)
    expect(degree(3, 'c4', 'major')).toBe(64) // E4
    expect(degree(5, 'c4', 'major')).toBe(67) // G4
  })

  it('wraps across octaves for high degrees', () => {
    // degree 8 in major = octave above root
    expect(degree(8, 'c4', 'major')).toBe(72) // C5
  })
})

describe('chord_names', () => {
  it('returns an array of strings', () => {
    const names = chord_names()
    expect(Array.isArray(names)).toBe(true)
    expect(names.length).toBeGreaterThan(10)
  })

  it('includes common chord types', () => {
    const names = chord_names()
    expect(names).toContain('major')
    expect(names).toContain('minor')
    expect(names).toContain('dom7')
    expect(names).toContain('dim')
  })
})

describe('scale_names', () => {
  it('returns an array of strings', () => {
    const names = scale_names()
    expect(Array.isArray(names)).toBe(true)
    expect(names.length).toBeGreaterThan(10)
  })

  it('includes common scale types', () => {
    const names = scale_names()
    expect(names).toContain('major')
    expect(names).toContain('minor')
    expect(names).toContain('blues')
    expect(names).toContain('chromatic')
  })
})

// ---------------------------------------------------------------------------
// ProgramBuilder additions
// ---------------------------------------------------------------------------

describe('ProgramBuilder Wave 1', () => {
  it('wait() is an alias for sleep()', () => {
    const b = new ProgramBuilder()
    b.wait(0.5)
    const steps = b.build()
    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('sleep')
    expect((steps[0] as { beats: number }).beats).toBe(0.5)
  })

  it('hz_to_midi(440) → 69', () => {
    const b = new ProgramBuilder()
    expect(b.hz_to_midi(440)).toBeCloseTo(69, 5)
  })

  it('midi_to_hz(69) → 440', () => {
    const b = new ProgramBuilder()
    expect(b.midi_to_hz(69)).toBeCloseTo(440, 5)
  })

  it('quantise rounds to nearest step', () => {
    const b = new ProgramBuilder()
    expect(b.quantise(10.3, 0.5)).toBe(10.5)
    expect(b.quantise(10.1, 0.5)).toBe(10.0)
    expect(b.quantise(3.14159, 0.01)).toBeCloseTo(3.14, 5)
  })

  it('quantize is an alias for quantise', () => {
    const b = new ProgramBuilder()
    expect(b.quantize(10.3, 0.5)).toBe(b.quantise(10.3, 0.5))
  })

  it('octs generates octave notes', () => {
    const b = new ProgramBuilder()
    const notes = b.octs(60, 3)
    expect(notes.toArray()).toEqual([60, 72, 84])
  })

  it('octs defaults to 1 octave', () => {
    const b = new ProgramBuilder()
    const notes = b.octs(60)
    expect(notes.toArray()).toEqual([60])
  })

  it('chord_degree is accessible on builder', () => {
    const b = new ProgramBuilder()
    const notes = b.chord_degree('i', 'c4', 'major')
    expect(notes.toArray()).toEqual([60, 64, 67])
  })

  it('degree is accessible on builder', () => {
    const b = new ProgramBuilder()
    expect(b.degree('v', 'c4', 'major')).toBe(67)
  })

  it('chord_names is accessible on builder', () => {
    const b = new ProgramBuilder()
    expect(b.chord_names().length).toBeGreaterThan(10)
  })

  it('scale_names is accessible on builder', () => {
    const b = new ProgramBuilder()
    expect(b.scale_names().length).toBeGreaterThan(10)
  })
})

// ---------------------------------------------------------------------------
// Transpiler wiring — verify new functions transpile correctly (regex fallback)
// ---------------------------------------------------------------------------

describe('Transpiler wiring', () => {
  it('wait transpiles to b.sleep() or b.wait()', () => {
    const ruby = `live_loop :test do\n  play 60\n  wait 0.5\nend`
    const result = autoTranspileDetailed(ruby)
    // TreeSitter preserves `wait` as b.wait() — ProgramBuilder aliases it to sleep
    expect(result.code).toMatch(/b\.(sleep|wait)\(0\.5\)/)
  })

  it('standalone hz_to_midi gets b. prefix', () => {
    const ruby = `live_loop :test do\n  hz_to_midi(440)\n  sleep 1\nend`
    const result = autoTranspileDetailed(ruby)
    expect(result.code).toContain('b.hz_to_midi(440)')
  })

  it('standalone chord_degree gets b. prefix', () => {
    const ruby = `live_loop :test do\n  chord_degree(:i, :c4, :major)\n  sleep 1\nend`
    const result = autoTranspileDetailed(ruby)
    expect(result.code).toContain('b.chord_degree(')
  })

  it('standalone quantise gets b. prefix', () => {
    const ruby = `live_loop :test do\n  quantise(10.3, 0.5)\n  sleep 1\nend`
    const result = autoTranspileDetailed(ruby)
    expect(result.code).toContain('b.quantise(')
  })
})
