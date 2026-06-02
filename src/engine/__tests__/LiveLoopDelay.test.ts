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
