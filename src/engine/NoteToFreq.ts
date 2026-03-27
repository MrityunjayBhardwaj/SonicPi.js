const SEMITONES_PER_OCTAVE = 12
/** MIDI number of A4 — the tuning reference. */
const A4_MIDI = 69
/** Concert pitch of A4 in Hz. */
const A4_FREQ_HZ = 440
/** MIDI number of middle C (C4) — used as fallback when a note name can't be parsed. */
const MIDDLE_C_MIDI = 60
/** Default octave when none is specified in a note name (e.g. "c" → "c4"). */
const DEFAULT_OCTAVE = 4

const NOTE_NAMES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
}

/**
 * Convert a note name like "c4", "fs3", "eb5" to a MIDI number.
 * Also accepts bare MIDI numbers as strings or numbers.
 */
export function noteToMidi(note: string | number): number {
  if (typeof note === 'number') return note

  const str = note.toLowerCase().trim()

  // Try parsing as plain number
  const num = Number(str)
  if (!isNaN(num)) return num

  const match = str.match(/^([a-g])(s|b|#)?(\d+)?$/)
  if (!match) return MIDDLE_C_MIDI

  const [, letter, accidental, octaveStr] = match
  const base = NOTE_NAMES[letter]
  const octave = octaveStr !== undefined ? parseInt(octaveStr) : DEFAULT_OCTAVE
  // MIDI octave numbering: C4 = 60, so offset = (octave + 1) * 12
  let midi = (octave + 1) * SEMITONES_PER_OCTAVE + base

  if (accidental === 's' || accidental === '#') midi += 1
  if (accidental === 'b') midi -= 1

  return midi
}

/**
 * Convert MIDI number to frequency in Hz.
 * A4 (MIDI 69) = 440 Hz.
 */
export function midiToFreq(midi: number): number {
  return A4_FREQ_HZ * Math.pow(2, (midi - A4_MIDI) / SEMITONES_PER_OCTAVE)
}

/**
 * Convert note name or number directly to frequency.
 */
export function noteToFreq(note: string | number): number {
  return midiToFreq(noteToMidi(note))
}
