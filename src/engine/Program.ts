/**
 * Program — pure data representation of a Sonic Pi loop body.
 *
 * A Program is a flat array of Steps describing what to do.
 * No side effects, no Promises, no scheduler references.
 * Interpreters decide how to run it (audio, query, capture).
 */

export type Step =
  | { tag: 'play'; note: number; opts: Record<string, number>; synth?: string; srcLine?: number }
  | { tag: 'sample'; name: string; opts: Record<string, number>; srcLine?: number }
  | { tag: 'sleep'; beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'useBpm'; bpm: number }
  | { tag: 'control'; nodeRef: number; params: Record<string, number> }
  | { tag: 'cue'; name: string; args?: unknown[] }
  | { tag: 'sync'; name: string; bpmSync?: boolean }
  | { tag: 'fx'; name: string; opts: Record<string, number>; body: Program; nodeRef?: number }
  | { tag: 'thread'; body: Program }
  | { tag: 'print'; message: string }
  | { tag: 'liveAudio'; name: string; opts: Record<string, number> }
  | { tag: 'set'; key: string | symbol; value: unknown }
  | { tag: 'stop' }
  | { tag: 'stopLoop'; name: string }
  | { tag: 'setVolume'; vol: number }
  | { tag: 'useOsc'; host: string; port: number }
  | { tag: 'midiOut'; kind: MidiOutKind; args: unknown[] }
  | { tag: 'kill'; nodeRef: number }
  | { tag: 'oscSend'; host: string; port: number; path: string; args: unknown[] }
  | { tag: 'useRealTime' }
  // Recording (#228) — session-lifecycle steps that fire at the scheduled
  // virtual time. Top-level immediate would mis-sequence: bare-wrapped
  // recording_save runs before the 8.times play loop's audio actually
  // plays, so the blob is empty.
  | { tag: 'recordingStart' }
  | { tag: 'recordingStop' }
  | { tag: 'recordingSave'; filename: string }
  | { tag: 'recordingDelete' }

/** MIDI-out variants — one tag with kind discriminator (issue #195). */
export type MidiOutKind =
  | 'noteOn' | 'noteOff' | 'cc' | 'pitchBend'
  | 'channelPressure' | 'polyPressure' | 'progChange'
  | 'clockTick' | 'start' | 'stop' | 'continue' | 'allNotesOff'

export type Program = Step[]

export interface LoopProgram {
  name: string
  bpm: number
  synth: string
  seed: number
  body: Program
}
