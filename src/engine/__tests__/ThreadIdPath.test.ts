/**
 * GAP A / A1 — the thread-identity tree (idPath) CONTRACT.
 *
 * This is the falsifier for the §2 idPath scheme in `ref/PARITY-GAPS.md`
 * (GAP A) before A2 consumes it. A1 plumbs a hierarchical `idPath: number[]`
 * onto every scheduler task — desktop's `ThreadId` (`thread_id.rb`): the main /
 * run thread is `[0]`; a forked child appends its parent's spawn index
 * (`parentPath ++ [spawnIdx]`, mirroring `runtime.rb:1071-1074`
 * `parent_path << n_threads_spawned`). A1 reads idPath NOWHERE — behaviour is
 * unchanged (the full suite is that guard); this test asserts ONLY that the
 * assignment matches the table the A2 comparator will rely on.
 *
 * §2 table (top level):
 *   main / bare top-level code (`__run_once`)        → [0]   (inline in main)
 *   bare `loop do` (hoisted `__loop_N`)              → [0]   (inline in main)
 *   `with_fx { bare loop }` (hoisted `__fxloop_N`)   → [0]   (inline in main)
 *   `with_fx { sync; play }` (bare → __run_once)     → [0]   (inline in main)
 *   `live_loop :x`                                   → [0, n] (FORK, source order)
 *   `in_thread { … }`                                → [0, n] (FORK, source order)
 *   nested `in_thread` (inside a loop body)          → [parent ++ [k]]
 *
 * Why the inline-vs-fork split matters (the #481 root): desktop runs some
 * top-level constructs INLINE in the main spider thread and FORKS others; the
 * synced-first-onset split in #481 is exactly that difference. Assignment is
 * driven by an explicit transpiler `__inline` marker, not name-sniffing.
 */
import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'

type Task = { id: string; idPath: number[] }
type Sched = {
  tick: (t: number) => void
  getTask: (n: string) => Task | undefined
  getRunningLoopNames: () => string[]
  tasks: Map<string, Task>
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

function sched(engine: SonicPiEngine): Sched {
  return (engine as unknown as { scheduler: Sched }).scheduler
}

/** Map every registered task name → its idPath. */
function idPaths(engine: SonicPiEngine): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const [name, task] of sched(engine).tasks) out.set(name, task.idPath)
  return out
}

/** Find the single task whose name starts with `prefix` (dynamic thread/at names). */
function findByPrefix(engine: SonicPiEngine, prefix: string): number[] | undefined {
  for (const [name, task] of sched(engine).tasks) {
    if (name.startsWith(prefix)) return task.idPath
  }
  return undefined
}

describe('GAP A / A1 — thread-id path (idPath) assignment', () => {
  it('top-level live_loops fork from main in source order: [0,0], [0,1], [0,2]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :alpha do; sleep 1; end
      live_loop :beta  do; sleep 1; end
      live_loop :gamma do; sleep 1; end
    `)
    expect(sched(engine).getTask('alpha')!.idPath).toEqual([0, 0])
    expect(sched(engine).getTask('beta')!.idPath).toEqual([0, 1])
    expect(sched(engine).getTask('gamma')!.idPath).toEqual([0, 2])
    engine.dispose()
  })

  it('bare top-level code (`__run_once`) is the main thread → [0]; a following live_loop forks [0,0]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      play 60
      sleep 1
      live_loop :foo do; sleep 1; end
    `)
    expect(sched(engine).getTask('__run_once')!.idPath).toEqual([0])
    // __run_once is inline (no spawn index consumed) → foo is the FIRST fork.
    expect(sched(engine).getTask('foo')!.idPath).toEqual([0, 0])
    engine.dispose()
  })

  it('a hoisted bare `loop do` runs inline in main → [0]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      loop do
        play 60
        sleep 1
      end
    `)
    expect(sched(engine).getTask('__loop_0')!.idPath).toEqual([0])
    engine.dispose()
  })

  it('a `with_fx`-wrapped bare loop (`__fxloop_N`) is inline → [0]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      with_fx :reverb do
        loop do
          play 60
          sleep 1
        end
      end
    `)
    expect(sched(engine).getTask('__fxloop_0')!.idPath).toEqual([0])
    engine.dispose()
  })

  it('a top-level `in_thread` forks from main → [0, n]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :driver do; sleep 1; end
      in_thread do; play 60; end
    `)
    expect(sched(engine).getTask('driver')!.idPath).toEqual([0, 0])
    // Top-level in_thread hoists to a dynamic `__thread_<ts>` task — second fork.
    expect(findByPrefix(engine, '__thread_')).toEqual([0, 1])
    engine.dispose()
  })

  it('#481 shape: driver [0,0]; forked in_thread waiter [0,1]; inline with_fx waiter (in __run_once) [0]', async () => {
    // The three #481 cells in miniature — the idPath split that drives the
    // onset split (forked sibling waits a cycle; inline/main catches vt0).
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :driver do
        cue :tick
        sleep 0.5
      end
      in_thread do
        sync :tick
        play 60
      end
      with_fx :reverb do
        sync :tick
        play 67
      end
    `)
    // driver is the first (and only) fork; the with_fx wraps bare code (no inner
    // live_loop) so it lands in __run_once = main = [0]; the in_thread forks.
    expect(sched(engine).getTask('driver')!.idPath).toEqual([0, 0])
    expect(sched(engine).getTask('__run_once')!.idPath).toEqual([0])
    expect(findByPrefix(engine, '__thread_')).toEqual([0, 1])
    engine.dispose()
  })

  it('#400 reorder: source order determines the fork index (director-first)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :director do; sleep 1; end
      live_loop :player   do; sleep 1; end
    `)
    expect(sched(engine).getTask('director')!.idPath).toEqual([0, 0])
    expect(sched(engine).getTask('player')!.idPath).toEqual([0, 1])
    engine.dispose()
  })

  it('#400 reorder: player-first FLIPS the indices (the A2 falsifier for {52,57})', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :player   do; sleep 1; end
      live_loop :director do; sleep 1; end
    `)
    // Reversed declaration ⇒ player now holds [0,0], director [0,1]. Under A2's
    // (t, idPath) TimeState read this is what makes the reversed program read
    // {52,57} instead of {55,59} — desktop parity (#400 / #350-reversed).
    expect(sched(engine).getTask('player')!.idPath).toEqual([0, 0])
    expect(sched(engine).getTask('director')!.idPath).toEqual([0, 1])
    engine.dispose()
  })

  it('a nested `in_thread` forks from its spawning loop → [parent ++ [k]]', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    await engine.evaluate(`
      live_loop :outer do
        in_thread do
          play 72
        end
        sleep 1
      end
    `)
    expect(sched(engine).getTask('outer')!.idPath).toEqual([0, 0])

    // The nested in_thread forks via AudioInterpreter `case 'thread'` during the
    // outer loop's first body run — materialise it by ticking.
    engine.play()
    for (let i = 0; i < 3; i++) { sched(engine).tick(20); await flush() }

    // Nested thread task is named `outer__thread_<ts>`; it forks from outer [0,0]
    // → [0, 0, 0] (outer's first child).
    expect(findByPrefix(engine, 'outer__thread_')).toEqual([0, 0, 0])
    engine.dispose()
  })

  it('idPath is deterministic across a fresh Run (counter resets in evaluate)', async () => {
    const engine = new SonicPiEngine()
    await engine.init()
    const code = `
      live_loop :a do; sleep 1; end
      live_loop :b do; sleep 1; end
    `
    await engine.evaluate(code)
    const first = idPaths(engine)
    // Fresh Run (Stop then Run) rebuilds the scheduler and resets _topSpawnCount.
    engine.stop()
    await engine.evaluate(code)
    const second = idPaths(engine)
    expect(second.get('a')).toEqual(first.get('a'))
    expect(second.get('b')).toEqual(first.get('b'))
    expect(second.get('a')).toEqual([0, 0])
    expect(second.get('b')).toEqual([0, 1])
    engine.dispose()
  })
})
