/**
 * Program — pure data representation of a Sonic Pi loop body.
 *
 * A Program is a flat array of Steps describing what to do.
 * No side effects, no Promises, no scheduler references.
 * Interpreters decide how to run it (audio, query, capture).
 */

export type Step =
  | { tag: 'play'; note: number; opts: Record<string, number>; synth?: string; srcLine?: number;
      /** B4 (#388): the original unparseable note-name string, set only when
       *  `note` is NaN because a string like "not a note" failed to resolve.
       *  Lets the dispatch-time guard name the bad input instead of silently
       *  sounding the middle-C fallback. */
      noteName?: string;
      /** #557/#559/#560: BUILD-TIME node ref (= ProgramBuilder `_lastRef` at the
       *  time this play was built). `control p` / `kill p` carry the same ref
       *  via their own `nodeRef`; the interpreter binds `nodeRefMap[nodeRef]` to
       *  this play's live scsynth node so a same-instant control resolves it.
       *  Build-time (not interpret-time-minted) so it shares ONE ref namespace
       *  with `fx` — no play-vs-fx counter drift (#560). */
      nodeRef?: number }
  | { tag: 'sample'; name: string; opts: Record<string, number>; srcLine?: number;
      /** #559: build-time node ref for `control`/`kill` of a running sample —
       *  same mechanism as `play` above. */
      nodeRef?: number }
  | { tag: 'sleep'; beats: number }
  | { tag: 'useSynth'; name: string }
  | { tag: 'useBpm'; bpm: number }
  | { tag: 'control'; nodeRef: number; params: Record<string, number> }
  | { tag: 'cue'; name: string; args?: unknown[] }
  // bpmSync is `?: true` (not `?: boolean`): ProgramBuilder.sync_bpm pushes
  // the flag only when set, so the field is either absent or `true` — the
  // tighter type makes the discriminator unambiguous.
  | { tag: 'sync'; name: string; bpmSync?: true; argMatcher?: (args: unknown) => boolean }
  | { tag: 'fx'; name: string; opts: Record<string, number>; body: Program; nodeRef?: number }
  | { tag: 'thread'; body: Program }
  // #357 / GAP D: time_warp — run `body` INLINE (same thread: shared ticks + rng,
  // unlike `thread`/`at` which fork) with virtual time shifted by `deltaBeats`
  // (NOT density-scaled), then RESTORE the pre-warp virtual time (discarding the
  // shift AND any sleeps inside the body). Desktop `core.rb:1040-1092`
  // (`__with_preserved_spider_time_and_beat`). Negative deltas shift earlier
  // (bounded by schedAhead). One step is emitted per time in a `time_warp [..]`.
  | { tag: 'timeWarp'; deltaBeats: number; body: Program }
  | { tag: 'print'; message: string }
  | { tag: 'liveAudio'; name: string; opts: Record<string, number>; stop?: boolean }
  | { tag: 'set'; key: string | symbol; value: unknown }
  | { tag: 'stop' }
  | { tag: 'stopLoop'; name: string }
  | { tag: 'setVolume'; vol: number }
  // Tier C PR #3 (#255). Mixer setters fire at scheduled virtual time so
  // sweeps (`set_mixer_control! lpf: 30; sleep 4; reset_mixer!`) sequence
  // against playback instead of collapsing at beat 0 like setVolume did
  // pre-#197. opts is the raw user hash; bridge coerces to /n_set.
  | { tag: 'setMixerControl'; opts: Record<string, number> }
  | { tag: 'resetMixer' }
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
