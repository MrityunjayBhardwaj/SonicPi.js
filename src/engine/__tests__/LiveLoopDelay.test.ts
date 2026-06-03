/**
 * #447 — `live_loop`/`in_thread` `delay:` option: initial delay in beats before
 * the first iteration (desktop core.rb:2299 → runtime.rb:1196 `sleep delay if
 * delay`). The option was parsed but dropped at two layers: the transpiler
 * emitted an opts hash that excluded `delay`, and the engine read only `sync`.
 */
import { describe, it, expect } from 'vitest'
import { autoTranspile } from '../TreeSitterTranspiler'
import { ProgramBuilder } from '../ProgramBuilder'

describe('#447 transpiler emits the delay: option', () => {
  it('live_loop :x, delay: 6 → opts hash with delay', () => {
    const out = autoTranspile('live_loop :synths, delay: 6 do\n  play 60\n  sleep 1\nend')
    expect(out).toMatch(/live_loop\("synths",\s*\{[^}]*delay:\s*6[^}]*\}/)
  })

  it('live_loop with BOTH sync: and delay: emits both', () => {
    const out = autoTranspile('live_loop :a, sync: :b, delay: 2 do\n  play 60\n  sleep 1\nend')
    expect(out).toMatch(/sync:\s*"b"/)
    expect(out).toMatch(/delay:\s*2/)
  })

  it('in_thread delay: 4 → opts hash with delay (was dropped entirely)', () => {
    const out = autoTranspile('in_thread delay: 4 do\n  play 50\nend')
    expect(out).toMatch(/in_thread\(\{[^}]*delay:\s*4[^}]*\}/)
  })

  it('in_thread delay: 4, name: :foo emits both name and delay', () => {
    const out = autoTranspile('in_thread delay: 4, name: :foo do\n  play 50\nend')
    expect(out).toMatch(/name:\s*"foo"/)
    expect(out).toMatch(/delay:\s*4/)
  })

  it('plain live_loop without opts is unchanged (no opts hash)', () => {
    const out = autoTranspile('live_loop :x do\n  play 60\n  sleep 1\nend')
    expect(out).toMatch(/live_loop\("x",\s*async/)
    expect(out).not.toMatch(/delay/)
  })
})

describe('#447 ProgramBuilder.in_thread applies the delay before the body', () => {
  it('prepends a sleep(delay) step to the forked thread body', () => {
    const b = new ProgramBuilder()
    b.in_thread({ delay: 2 }, (t) => {
      t.play(60)
    })
    const steps = b.build()
    expect(steps[0].tag).toBe('thread')
    const body = (steps[0] as Extract<(typeof steps)[0], { tag: 'thread' }>).body
    expect(body[0].tag).toBe('sleep')
    const sleep = body[0] as Extract<(typeof body)[0], { tag: 'sleep' }>
    expect(sleep.beats).toBe(2)
    expect(body[1].tag).toBe('play')
  })

  it('no delay → no leading sleep (body starts with play)', () => {
    const b = new ProgramBuilder()
    b.in_thread((t) => {
      t.play(60)
    })
    const steps = b.build()
    const body = (steps[0] as Extract<(typeof steps)[0], { tag: 'thread' }>).body
    expect(body[0].tag).toBe('play')
  })
})

describe('#451 follow-up — pre-loop timing reaches the hoisted in_thread bare loop', () => {
  // A bare `loop` inside an in_thread is hoisted to a sibling scheduler-owned
  // live_loop. Before this fix it always started at vt 0, ignoring (A) `delay:`,
  // (B) a one-time `sleep` in the setup, and (C) the top-level #448 start-gate —
  // all three were observed dropped. The loop must fork at the advanced vtime.

  it('A: in_thread delay: 4 { loop } → delay on the hoisted loop opts', () => {
    const out = autoTranspile('in_thread delay: 4 do\n  loop do\n    sync :tick\n    play 60\n  end\nend')
    // delay is static → straight onto the hoisted live_loop registration opts
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*\{[^}]*delay:\s*4[^}]*\}/)
    // pre-fix the delay vanished entirely
    expect(out).toMatch(/delay:\s*4/)
  })

  it('B: in_thread { sleep 4; loop } → setup fires a start-gate cue the loop waits on', () => {
    const out = autoTranspile('in_thread do\n  sleep 4\n  loop do\n    sync :tick\n    play 60\n  end\nend')
    // setup thread runs the one-time sleep, THEN fires the synthetic gate cue
    expect(out).toMatch(/__b\.sleep\(4\)[\s\S]*__b\.cue\("__itg_0"\)/)
    // hoisted loop gates its first iteration on that cue
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*\{[^}]*__startGate:\s*"__itg_0"[^}]*\}/)
  })

  it('C: top-level sleep before in_thread{loop} → loop gates on the #448 source-position cue', () => {
    const out = autoTranspile('sleep 4\nin_thread do\n  loop do\n    sync :tick\n    play 60\n  end\nend')
    // __run_once fires __sg_0 at the in_thread's source position (vt 4)
    expect(out).toMatch(/__run_once[\s\S]*__b\.cue\("__sg_0"\)/)
    // the hoisted loop now waits for it (was un-gated → started at vt 0)
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*\{[^}]*__startGate:\s*"__sg_0"[^}]*\}/)
  })

  it('D: delay + sleep-setup combined → delay upstream on setup thread, loop gates the cue', () => {
    const out = autoTranspile('in_thread delay: 2 do\n  sleep 4\n  loop do\n    play 60\n  end\nend')
    // delay applied on the SETUP thread (upstream of the cue), not duplicated on the loop
    expect(out).toMatch(/in_thread\(\{[^}]*delay:\s*2[^}]*\}[\s\S]*__b\.sleep\(4\)[\s\S]*__b\.cue\("__itg_0"\)/)
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*\{\s*__startGate:\s*"__itg_0"\s*\}/)
    // the loop opts carry ONLY the gate — delay is not double-applied
    expect(out).not.toMatch(/live_loop\("__inthread_loop_0",\s*\{[^}]*delay/)
  })

  it('regression: settings-only setup still folds (no gate, vt 0) — #451 syncer shape', () => {
    const out = autoTranspile('in_thread do\n  use_synth :saw\n  loop do\n    sync :tick\n    play 60\n  end\nend')
    // use_synth folds into the loop body; no start-gate, no delay → loop starts at vt 0
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*async/)
    expect(out).not.toMatch(/__startGate/)
    expect(out).not.toMatch(/__itg_/)
    expect(out).toMatch(/__b\.use_synth\("saw"\)/)
  })

  it('regression: one-time non-vtime action (play) stays concurrent — loop un-gated', () => {
    const out = autoTranspile('in_thread do\n  play 50\n  loop do\n    sync :tick\n    play 60\n  end\nend')
    // a play does not advance vtime → no gate; setup thread plays once, loop forks at vt 0
    expect(out).toMatch(/__b\.play\(50/)
    expect(out).toMatch(/live_loop\("__inthread_loop_0",\s*async/)
    expect(out).not.toMatch(/__itg_/)
  })

  it('regression: nested in_thread (inside live_loop) keeps the un-gated path', () => {
    const out = autoTranspile('live_loop :outer do\n  in_thread do\n    sleep 1\n    loop do\n      play 60\n    end\n  end\n  sleep 4\nend')
    // nested → __b.live_loop with no gate opts (cue machinery is top-level, SP118)
    expect(out).toMatch(/__b\.live_loop\("__inthread_loop_0",\s*async/)
    expect(out).not.toMatch(/__itg_/)
  })
})
