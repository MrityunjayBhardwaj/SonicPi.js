/**
 * #353 — a `live_loop` nested inside an `in_thread` must inherit the
 * surrounding thread's `use_osc` target, so `osc` inside the loop body fires at
 * the in_thread's host/port, not the default localhost:4560.
 *
 *   in_thread do
 *     use_osc "remote.host", 9000
 *     live_loop :nested do
 *       osc "/path", 1
 *       sleep 1
 *     end
 *   end
 *
 * Same SP72/#421 "inherited field the registration list missed" class that was
 * fixed for `current_synth` / `transpose` / `synth_defaults`. The in_thread
 * sub-builder already inherited `_oscHost`/`_oscPort` (#345), but the nested
 * live_loop's fresh per-iteration ProgramBuilder defaulted to localhost:4560.
 *
 * Fix: thread `use_osc` target through TaskState (oscHost/oscPort), derived from
 * the parent builder when nested, and re-seed each iteration's builder — exactly
 * mirroring transpose. Verified at the OSC-send boundary via engine.setOscHandler
 * (osc is pure transport — no Level-3 audio path).
 */
import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

type Task = { oscHost: string; oscPort: number }
type Sched = { tick: (t: number) => void; getTask: (n: string) => Task | undefined }

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

type OscSend = { host: string; port: number; path: string; args: unknown[] }

async function runAndCaptureOsc(code: string): Promise<{ sends: OscSend[]; engine: SonicPiEngine }> {
  const engine = new SonicPiEngine()
  await engine.init()
  const sends: OscSend[] = []
  engine.setOscHandler((host, port, path, ...args) => { sends.push({ host, port, path, args }) })
  await engine.evaluate(code)
  engine.play()
  const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
  // Several ticks so the in_thread body runs, the nested loop registers, and its
  // first iteration interprets the `osc` step (osc fires before its first sleep).
  for (let i = 0; i < 6; i++) { scheduler.tick(20); await flush() }
  return { sends, engine }
}

describe('#353 osc target inherited by nested live_loop', () => {
  it('nested live_loop inside in_thread inherits the in_thread use_osc target', async () => {
    const { sends, engine } = await runAndCaptureOsc(`
      in_thread do
        use_osc "remote.host", 9000
        live_loop :nested do
          osc "/path", 1
          sleep 1
        end
      end
    `)
    const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
    const task = scheduler.getTask('nested')
    expect(task, ':nested should have registered').toBeDefined()
    // Inheritance plumbing: the task carries the in_thread's use_osc target.
    expect(task!.oscHost).toBe('remote.host')
    expect(task!.oscPort).toBe(9000)
    // End-to-end: the `osc` step actually fired at that target, not localhost:4560.
    const send = sends.find((s) => s.path === '/path')
    expect(send, 'osc "/path" should have fired').toBeDefined()
    expect(send!.host).toBe('remote.host')
    expect(send!.port).toBe(9000)
    engine.dispose()
  })

  it('top-level use_osc is inherited by a top-level live_loop (same class)', async () => {
    const { sends, engine } = await runAndCaptureOsc(`
      use_osc "top.host", 4000
      live_loop :solo do
        osc "/solo", 7
        sleep 1
      end
    `)
    const send = sends.find((s) => s.path === '/solo')
    expect(send, 'osc "/solo" should have fired').toBeDefined()
    expect(send!.host).toBe('top.host')
    expect(send!.port).toBe(4000)
    engine.dispose()
  })

  it('regression: a live_loop with no use_osc targets the default localhost:4560', async () => {
    const { sends, engine } = await runAndCaptureOsc(`
      live_loop :plain do
        osc "/plain", 1
        sleep 1
      end
    `)
    const send = sends.find((s) => s.path === '/plain')
    expect(send, 'osc "/plain" should have fired').toBeDefined()
    expect(send!.host).toBe('localhost')
    expect(send!.port).toBe(4560)
    engine.dispose()
  })
})
