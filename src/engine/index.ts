// ---------------------------------------------------------------------------
// Public API — start here
// ---------------------------------------------------------------------------
export { SonicPiEngine } from './SonicPiEngine'
export type { EngineComponents } from './SonicPiEngine'

// Music theory helpers — available inside live_loop via the DSL and externally
export { ring } from './Ring'
export { spread } from './EuclideanRhythm'
export { noteToMidi, midiToFreq, noteToFreq } from './NoteToFreq'
export { chord, scale, chord_invert, note, note_range, chord_names, scale_names } from './ChordScale'

// Event types
export type { SoundEvent } from './SoundEventStream'
export type { QueryEvent } from './interpreters/QueryInterpreter'
export type { FriendlyError } from './FriendlyErrors'
export type { Example, Difficulty } from './examples'
export type { SampleInfo } from './SampleCatalog'

// Error formatting
export { friendlyError, formatFriendlyError } from './FriendlyErrors'

// Examples
export { examples, getExample, getExampleNames, getExamplesByDifficulty } from './examples'

// Sample catalog
export { getAllSamples, getCategories, getSamplesByCategory, searchSamples, getSampleNames } from './SampleCatalog'

// ---------------------------------------------------------------------------
// Extensions — MIDI, recording, collaboration, Ableton Link
// ---------------------------------------------------------------------------
export { MidiBridge } from './MidiBridge'
export type { MidiDevice, MidiEventHandler } from './MidiBridge'
export { Recorder } from './Recorder'
export { SessionLog } from './SessionLog'
export type { SessionEntry, SignedSession } from './SessionLog'
export { CollaborationSession, generateRoomId } from './Collaboration'
export type { Peer, CollabCallbacks } from './Collaboration'
export { LinkBridge } from './LinkBridge'
export type { LinkState, LinkStateHandler } from './LinkBridge'

// ---------------------------------------------------------------------------
// Advanced / internals — for custom interpreters and tooling
// ---------------------------------------------------------------------------

// Scheduler
export { VirtualTimeScheduler } from './VirtualTimeScheduler'
export type { TaskState, SchedulerEvent, SleepEntry, SchedulerOptions } from './VirtualTimeScheduler'

// Program (free monad) — needed to build custom interpreters
export type { Step, Program, LoopProgram } from './Program'
export { ProgramBuilder } from './ProgramBuilder'
export { runProgram } from './interpreters/AudioInterpreter'
export { queryProgram, queryLoopProgram, captureAll } from './interpreters/QueryInterpreter'

// Audio bridge — direct SuperSonic access
export { SuperSonicBridge } from './SuperSonicBridge'

// Event stream — for visualization integrations
export { SoundEventStream } from './SoundEventStream'

// Stratum detection
export { detectStratum, Stratum } from './Stratum'

// Transpilation — for custom language front-ends
export { transpile, createExecutor } from './Transpiler'
export { transpileRubyToJS, detectLanguage, autoTranspile } from './RubyTranspiler'
export { parseAndTranspile } from './Parser'
export type { ParseError } from './Parser'

// Sandbox — Proxy-based global blocking for user code execution
export { createSandboxedExecutor, validateCode, BLOCKED_GLOBALS } from './Sandbox'

// Seeded random — for deterministic generative patterns
export { SeededRandom } from './SeededRandom'
