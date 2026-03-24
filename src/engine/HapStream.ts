/**
 * Lightweight event bus for visualization and highlighting.
 * Compatible with Motif's HapStream interface.
 */

export interface HapEvent {
  hap: unknown
  audioTime: number
  audioDuration: number
  scheduledAheadMs: number
  midiNote: number | null
  s: string | null
  color: string | null
  loc: Array<{ start: number; end: number }> | null
}

type HapHandler = (event: HapEvent) => void

export class HapStream {
  private handlers = new Set<HapHandler>()

  on(handler: HapHandler): void {
    this.handlers.add(handler)
  }

  off(handler: HapHandler): void {
    this.handlers.delete(handler)
  }

  emit(
    hap: unknown,
    time: number,
    cps: number,
    endTime: number,
    audioCtxCurrentTime: number
  ): void {
    const scheduledAheadMs = (time - audioCtxCurrentTime) * 1000
    const audioDuration = endTime - time

    const event: HapEvent = {
      hap,
      audioTime: time,
      audioDuration,
      scheduledAheadMs,
      midiNote: (hap as Record<string, unknown>)?.value
        ? ((hap as Record<string, Record<string, unknown>>).value.note as number | null) ?? null
        : null,
      s: (hap as Record<string, Record<string, unknown>>)?.value?.s as string | null ?? null,
      color: null,
      loc: null,
    }

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
