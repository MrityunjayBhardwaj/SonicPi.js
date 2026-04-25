/**
 * MIDI I/O bridge — Web MIDI API for note output and input-as-cue.
 *
 * Output: midi_note_on, midi_note_off, midi_cc, midi_pitch_bend,
 *         midi_channel_pressure, midi_poly_pressure, midi_prog_change,
 *         midi_clock_tick, transport (start/stop/continue).
 *
 * Input: incoming MIDI fires event handlers; state is readable via
 *        getCCValue / getPitchBend for live knob/mod-wheel control.
 *
 * Multi-output: selectOutput() adds to the active set; all sends
 *               go to every selected output simultaneously.
 */

// ---------------------------------------------------------------------------
// MIDI protocol constants (MIDI 1.0 spec)
// ---------------------------------------------------------------------------

/** Status byte upper nibbles — OR'd with (channel - 1) to get the full status byte. */
const NOTE_ON            = 0x90
const NOTE_OFF           = 0x80
const CONTROL_CHANGE     = 0xB0
const PITCH_BEND         = 0xE0
const CHANNEL_PRESSURE   = 0xD0
const POLY_PRESSURE      = 0xA0
const PROGRAM_CHANGE     = 0xC0

/** System real-time: MIDI timing clock (one pulse per 24th of a quarter note). */
const MIDI_TIMING_CLOCK  = 0xF8

/** Masks a value to the 4-bit channel range (0–15). */
const CHANNEL_NIBBLE_MASK = 0x0F
/** Masks a value to the 7-bit MIDI data range (0–127). */
const MIDI_DATA_MASK     = 0x7F

/** MIDI clock pulses per quarter note (MIDI 1.0 standard). */
const MIDI_CLOCKS_PER_QUARTER_NOTE = 24

/** Maximum 14-bit pitch bend value (0x3FFF). Centre is half this: 8192. */
const PITCH_BEND_14BIT_MAX = 16383

/** CC number for "all notes off" (MIDI 1.0 spec, section 4.4). */
const ALL_NOTES_OFF_CC = 123

/** Seconds per minute — used when computing MIDI clock intervals from BPM. */
const SECONDS_PER_MINUTE = 60

// ---------------------------------------------------------------------------

export interface MidiDevice {
  id: string
  name: string
  type: 'input' | 'output'
}

export type MidiEventType =
  | 'note_on' | 'note_off'
  | 'cc'
  | 'pitch_bend'
  | 'channel_pressure'
  | 'poly_pressure'

export type MidiEventHandler = (event: {
  type: MidiEventType
  channel: number
  note?: number
  velocity?: number
  cc?: number
  value?: number
}) => void

export class MidiBridge {
  private midiAccess: MIDIAccess | null = null
  /** All selected output ports — sends go to every one. */
  private selectedOutputs: MIDIOutput[] = []
  private selectedInputs: MIDIInput[] = []
  private inputListeners = new Map<string, (e: MIDIMessageEvent) => void>()
  private handlers: MidiEventHandler[] = []

  /** Last CC value per "controller:channel". */
  private ccState = new Map<string, number>()
  /**
   * Last pitch bend per channel.
   * Stored as normalised float in [-1, 1].
   * Raw 14-bit value: 0x0000 = -1, 0x2000 = 0, 0x3FFF = +1.
   */
  private pitchBendState = new Map<number, number>()
  private noteOnState = new Map<string, { note: number; velocity: number }>()
  private noteOffState = new Map<string, number>()

  /** Running MIDI clock interval (started by startClock / stopped by stopClock). */
  private clockInterval: ReturnType<typeof setInterval> | null = null

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /** Request MIDI access from the browser. */
  async init(): Promise<boolean> {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not available in this browser')
      return false
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false })
      return true
    } catch (err) {
      console.warn('[MIDI] Access denied:', err)
      return false
    }
  }

  /** List available MIDI devices. */
  getDevices(): MidiDevice[] {
    if (!this.midiAccess) return []
    const devices: MidiDevice[] = []
    this.midiAccess.inputs.forEach((input) => {
      devices.push({ id: input.id, name: input.name ?? input.id, type: 'input' })
    })
    this.midiAccess.outputs.forEach((output) => {
      devices.push({ id: output.id, name: output.name ?? output.id, type: 'output' })
    })
    return devices
  }

  // ---------------------------------------------------------------------------
  // Device selection (multi-output, multi-input)
  // ---------------------------------------------------------------------------

  /**
   * Add an output device to the active set.
   * All subsequent send calls go to every selected output.
   */
  selectOutput(deviceId: string): boolean {
    if (!this.midiAccess) return false
    const output = this.midiAccess.outputs.get(deviceId)
    if (!output) return false
    if (!this.selectedOutputs.some(o => o.id === deviceId)) {
      this.selectedOutputs.push(output)
    }
    return true
  }

  /** Remove an output device from the active set. */
  deselectOutput(deviceId: string): void {
    this.selectedOutputs = this.selectedOutputs.filter(o => o.id !== deviceId)
  }

  /** Clear all selected outputs. */
  clearOutputs(): void {
    this.selectedOutputs = []
  }

  /**
   * Add an input device. Incoming MIDI fires registered event handlers.
   * Multiple inputs are supported simultaneously.
   */
  selectInput(deviceId: string): boolean {
    if (!this.midiAccess) return false
    if (this.inputListeners.has(deviceId)) return true // already listening

    const input = this.midiAccess.inputs.get(deviceId)
    if (!input) return false

    const listener = (e: MIDIMessageEvent) => this.handleMidiMessage(e)
    input.addEventListener('midimessage', listener as EventListener)
    this.inputListeners.set(deviceId, listener)
    this.selectedInputs.push(input)
    return true
  }

  /** Stop listening on an input device. */
  deselectInput(deviceId: string): void {
    const listener = this.inputListeners.get(deviceId)
    if (!listener) return
    const input = this.selectedInputs.find(i => i.id === deviceId)
    if (input) input.removeEventListener('midimessage', listener as EventListener)
    this.inputListeners.delete(deviceId)
    this.selectedInputs = this.selectedInputs.filter(i => i.id !== deviceId)
  }

  /** Register a handler for all incoming MIDI events. */
  onMidiEvent(handler: MidiEventHandler): void {
    this.handlers.push(handler)
  }

  // ---------------------------------------------------------------------------
  // Output — notes
  // ---------------------------------------------------------------------------

  /** Send MIDI note on. Channel 1-16, note 0-127, velocity 0-127. */
  noteOn(note: number, velocity: number = 100, channel: number = 1): void {
    const status = NOTE_ON | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, note & MIDI_DATA_MASK, velocity & MIDI_DATA_MASK])
  }

  /** Send MIDI note off. */
  noteOff(note: number, channel: number = 1): void {
    const status = NOTE_OFF | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, note & MIDI_DATA_MASK, 0])
  }

  /**
   * Tracks pending auto-note-offs scheduled by `midi(...)` shorthand and the
   * deferred `midiOut`-with-sustain step. engine.stop() calls
   * cancelPendingNoteOffs() to fire each pending note's off NOW (so external
   * devices don't hang) and prevent the timer's deferred fire from sending a
   * stale note-off into a fresh run (#200).
   */
  private pendingNoteOffs = new Set<{
    timer: ReturnType<typeof setTimeout>
    note: number
    channel: number
  }>()

  /**
   * Schedule a note-off after `delaySeconds`. Returns the entry so the caller
   * can ignore it; the bridge tracks the timer and clears it on stop().
   */
  scheduleNoteOff(note: number, channel: number, delaySeconds: number): void {
    const entry = { timer: 0 as unknown as ReturnType<typeof setTimeout>, note, channel }
    entry.timer = setTimeout(() => {
      this.pendingNoteOffs.delete(entry)
      this.noteOff(note, channel)
    }, delaySeconds * 1000)
    this.pendingNoteOffs.add(entry)
  }

  /**
   * Cancel every pending auto note-off and immediately fire its note-off so
   * external MIDI devices don't hang. Called from engine.stop() (#200).
   */
  cancelPendingNoteOffs(): void {
    for (const entry of this.pendingNoteOffs) {
      clearTimeout(entry.timer)
      this.noteOff(entry.note, entry.channel)
    }
    this.pendingNoteOffs.clear()
  }

  // ---------------------------------------------------------------------------
  // Output — continuous controllers
  // ---------------------------------------------------------------------------

  /** Send MIDI CC (control change). controller 0-127, value 0-127. */
  cc(controller: number, value: number, channel: number = 1): void {
    const status = CONTROL_CHANGE | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, controller & MIDI_DATA_MASK, value & MIDI_DATA_MASK])
  }

  /** Send all notes off on a channel (CC 123). */
  allNotesOff(channel: number = 1): void {
    this.cc(ALL_NOTES_OFF_CC, 0, channel)
  }

  /**
   * Send MIDI pitch bend. val is normalised [-1, 1] (0 = centre).
   * Maps to 14-bit value: 0x2000 = centre, 0x0000 = -1, 0x3FFF = +1.
   */
  pitchBend(val: number, channel: number = 1): void {
    const clamped = Math.max(-1, Math.min(1, val))
    // Map [-1, 1] → [0, PITCH_BEND_14BIT_MAX]; centre = 8192 (0x2000)
    const raw = Math.round((clamped + 1) * 0.5 * PITCH_BEND_14BIT_MAX)
    const lsb = raw & MIDI_DATA_MASK         // lower 7 bits
    const msb = (raw >> 7) & MIDI_DATA_MASK  // upper 7 bits
    const status = PITCH_BEND | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, lsb, msb])
  }

  /**
   * Send MIDI channel pressure (aftertouch). val 0-127.
   * Affects all notes on the channel.
   */
  channelPressure(val: number, channel: number = 1): void {
    const status = CHANNEL_PRESSURE | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, val & MIDI_DATA_MASK])
  }

  /**
   * Send MIDI polyphonic key pressure. val 0-127.
   * Targets a specific note on the channel.
   */
  polyPressure(note: number, val: number, channel: number = 1): void {
    const status = POLY_PRESSURE | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, note & MIDI_DATA_MASK, val & MIDI_DATA_MASK])
  }

  /**
   * Send MIDI program change. program 0-127.
   * Switches the sound/patch on the receiving device.
   */
  programChange(program: number, channel: number = 1): void {
    const status = PROGRAM_CHANGE | ((channel - 1) & CHANNEL_NIBBLE_MASK)
    this.send([status, program & MIDI_DATA_MASK])
  }

  // ---------------------------------------------------------------------------
  // Output — MIDI clock & transport
  // ---------------------------------------------------------------------------

  /** Send a single MIDI timing clock pulse (0xF8). 24 per quarter note. */
  clockTick(): void {
    this.send([MIDI_TIMING_CLOCK])
  }

  /**
   * Start a continuous MIDI clock at the given BPM.
   * Sends 24 pulses per quarter note using setInterval.
   * Call stopClock() to halt. Safe to call multiple times — restarts the clock.
   */
  startClock(bpm: number): void {
    this.stopClock()
    const intervalMs = (SECONDS_PER_MINUTE / bpm / MIDI_CLOCKS_PER_QUARTER_NOTE) * 1000
    this.clockInterval = setInterval(() => this.clockTick(), intervalMs)
  }

  /** Stop the running MIDI clock. */
  stopClock(): void {
    if (this.clockInterval !== null) {
      clearInterval(this.clockInterval)
      this.clockInterval = null
    }
  }

  /** Send MIDI Start (0xFA) — tells external devices to begin playback. */
  midiStart(): void {
    this.send([0xFA])
  }

  /** Send MIDI Stop (0xFC) — tells external devices to stop. */
  midiStop(): void {
    this.send([0xFC])
  }

  /** Send MIDI Continue (0xFB) — resume from current position. */
  midiContinue(): void {
    this.send([0xFB])
  }

  // ---------------------------------------------------------------------------
  // Input state readers
  // ---------------------------------------------------------------------------

  /**
   * Return the most recently received CC value (0–127) for a controller.
   * Matches Sonic Pi's get_cc(controller, channel: 1).
   * Returns 0 if no CC has been received.
   */
  getCCValue(controller: number, channel: number = 1): number {
    return this.ccState.get(`${controller}:${channel}`) ?? 0
  }

  /** Inject a CC value — used in tests and for programmatic control. */
  setCCValue(controller: number, value: number, channel: number = 1): void {
    this.ccState.set(`${controller}:${channel}`, value)
  }

  getLastNoteOn(channel: number = 1): { note: number; velocity: number } | null {
    return this.noteOnState.get(`${channel}`) ?? null
  }

  getLastNoteOff(channel: number = 1): number | null {
    return this.noteOffState.get(`${channel}`) ?? null
  }

  /**
   * Return the most recently received pitch bend normalised to [-1, 1].
   * Returns 0 (centre) if no pitch bend message has been received.
   */
  getPitchBend(channel: number = 1): number {
    return this.pitchBendState.get(channel) ?? 0
  }

  // ---------------------------------------------------------------------------
  // Internal — input parsing
  // ---------------------------------------------------------------------------

  private handleMidiMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 1) return

    const status = data[0] & 0xF0
    const channel = (data[0] & 0x0F) + 1

    switch (status) {
      case 0x90: // Note on
        if (data.length >= 3 && data[2] > 0) {
          this.emit({ type: 'note_on', channel, note: data[1], velocity: data[2] })
          this.noteOnState.set(`${channel}`, { note: data[1], velocity: data[2] })
        } else {
          this.emit({ type: 'note_off', channel, note: data[1] })
          this.noteOffState.set(`${channel}`, data[1])
        }
        break

      case 0x80: // Note off
        this.emit({ type: 'note_off', channel, note: data[1] })
        this.noteOffState.set(`${channel}`, data[1])
        break

      case 0xB0: { // CC
        if (data.length < 3) break
        const ccNum = data[1]
        const ccVal = data[2]
        this.ccState.set(`${ccNum}:${channel}`, ccVal)
        this.emit({ type: 'cc', channel, cc: ccNum, value: ccVal })
        break
      }

      case 0xE0: { // Pitch bend
        if (data.length < 3) break
        const raw = (data[2] << 7) | data[1] // 14-bit: MSB<<7 | LSB
        // Normalise: 0x2000 (8192) = centre; range [0, 16383] → [-1, 1]
        const normalised = (raw - 8192) / 8192
        this.pitchBendState.set(channel, normalised)
        this.emit({ type: 'pitch_bend', channel, value: normalised })
        break
      }

      case 0xD0: { // Channel pressure (aftertouch)
        if (data.length < 2) break
        this.emit({ type: 'channel_pressure', channel, value: data[1] })
        break
      }

      case 0xA0: { // Polyphonic key pressure
        if (data.length < 3) break
        this.emit({ type: 'poly_pressure', channel, note: data[1], value: data[2] })
        break
      }
    }
  }

  private send(data: number[]): void {
    for (const output of this.selectedOutputs) {
      try { output.send(data) } catch { /* port may have disconnected */ }
    }
  }

  private emit(event: Parameters<MidiEventHandler>[0]): void {
    for (const handler of this.handlers) {
      try { handler(event) } catch { /* don't crash on bad handler */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.stopClock()
    for (const [id, listener] of this.inputListeners) {
      const input = this.selectedInputs.find(i => i.id === id)
      if (input) input.removeEventListener('midimessage', listener as EventListener)
    }
    this.inputListeners.clear()
    this.selectedInputs = []
    this.selectedOutputs = []
    this.midiAccess = null
    this.handlers = []
  }
}
