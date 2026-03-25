/**
 * MIDI I/O bridge — Web MIDI API for note output and input-as-cue.
 *
 * Output: midi_note_on, midi_note_off, midi_cc send MIDI messages.
 * Input: incoming MIDI notes fire cues that live_loops can sync to.
 */

export interface MidiDevice {
  id: string
  name: string
  type: 'input' | 'output'
}

export type MidiEventHandler = (event: {
  type: 'note_on' | 'note_off' | 'cc'
  channel: number
  note?: number
  velocity?: number
  cc?: number
  value?: number
}) => void

export class MidiBridge {
  private midiAccess: MIDIAccess | null = null
  private selectedOutput: MIDIOutput | null = null
  private selectedInput: MIDIInput | null = null
  private handlers: MidiEventHandler[] = []
  private inputListener: ((e: MIDIMessageEvent) => void) | null = null

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

  /** Select an output device by ID. */
  selectOutput(deviceId: string): boolean {
    if (!this.midiAccess) return false
    const output = this.midiAccess.outputs.get(deviceId)
    if (!output) return false
    this.selectedOutput = output
    return true
  }

  /** Select an input device by ID. Incoming MIDI fires event handlers. */
  selectInput(deviceId: string): boolean {
    if (!this.midiAccess) return false

    // Disconnect previous input
    if (this.selectedInput && this.inputListener) {
      this.selectedInput.removeEventListener('midimessage', this.inputListener as EventListener)
    }

    const input = this.midiAccess.inputs.get(deviceId)
    if (!input) return false

    this.selectedInput = input
    this.inputListener = (e: MIDIMessageEvent) => this.handleMidiMessage(e)
    input.addEventListener('midimessage', this.inputListener as EventListener)
    return true
  }

  /** Register a handler for incoming MIDI events. */
  onMidiEvent(handler: MidiEventHandler): void {
    this.handlers.push(handler)
  }

  // ----- Output functions (for use in DSL) -----

  /** Send MIDI note on. Channel 1-16, note 0-127, velocity 0-127. */
  noteOn(note: number, velocity: number = 100, channel: number = 1): void {
    if (!this.selectedOutput) return
    const status = 0x90 | ((channel - 1) & 0x0F)
    this.selectedOutput.send([status, note & 0x7F, velocity & 0x7F])
  }

  /** Send MIDI note off. */
  noteOff(note: number, channel: number = 1): void {
    if (!this.selectedOutput) return
    const status = 0x80 | ((channel - 1) & 0x0F)
    this.selectedOutput.send([status, note & 0x7F, 0])
  }

  /** Send MIDI CC (control change). */
  cc(controller: number, value: number, channel: number = 1): void {
    if (!this.selectedOutput) return
    const status = 0xB0 | ((channel - 1) & 0x0F)
    this.selectedOutput.send([status, controller & 0x7F, value & 0x7F])
  }

  /** Send all notes off on a channel. */
  allNotesOff(channel: number = 1): void {
    this.cc(123, 0, channel)
  }

  // ----- Input parsing -----

  private handleMidiMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 2) return

    const status = data[0] & 0xF0
    const channel = (data[0] & 0x0F) + 1

    switch (status) {
      case 0x90: // Note on
        if (data[2] > 0) {
          this.emit({ type: 'note_on', channel, note: data[1], velocity: data[2] })
        } else {
          // Velocity 0 = note off
          this.emit({ type: 'note_off', channel, note: data[1] })
        }
        break
      case 0x80: // Note off
        this.emit({ type: 'note_off', channel, note: data[1] })
        break
      case 0xB0: // CC
        this.emit({ type: 'cc', channel, cc: data[1], value: data[2] })
        break
    }
  }

  private emit(event: Parameters<MidiEventHandler>[0]): void {
    for (const handler of this.handlers) {
      try { handler(event) } catch { /* don't crash on bad handler */ }
    }
  }

  dispose(): void {
    if (this.selectedInput && this.inputListener) {
      this.selectedInput.removeEventListener('midimessage', this.inputListener as EventListener)
    }
    this.selectedOutput = null
    this.selectedInput = null
    this.midiAccess = null
    this.handlers = []
  }
}
