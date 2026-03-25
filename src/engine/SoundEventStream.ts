/**
 * Sound event stream — lightweight event bus for visualization and logging.
 *
 * Engines emit SoundEvent objects when notes/samples are triggered.
 * Subscribers (scope, console, highlighting) receive them.
 */

export interface SoundEvent {
  audioTime: number
  audioDuration: number
  scheduledAheadMs: number
  midiNote: number | null
  s: string | null
  /** Source line number (1-based) from the original code. Consumer computes char offsets. */
  srcLine: number | null
  /** Which live_loop / task produced this event (e.g. "drums", "bass"). */
  trackId: string | null
}

type SoundEventHandler = (event: SoundEvent) => void

export class SoundEventStream {
  private handlers = new Set<SoundEventHandler>()

  on(handler: SoundEventHandler): void {
    this.handlers.add(handler)
  }

  off(handler: SoundEventHandler): void {
    this.handlers.delete(handler)
  }

  /** Emit a sound event to all subscribers. */
  emitEvent(event: SoundEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch {
        // Prevent one bad subscriber from breaking others
      }
    }
  }

  dispose(): void {
    this.handlers.clear()
  }
}
