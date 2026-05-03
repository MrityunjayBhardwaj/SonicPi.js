/**
 * Tests for Tier C PR #3 — mixer + introspection (#255).
 *
 * Two layers:
 *   1. ProgramBuilder methods — set_mixer_control / reset_mixer are deferred
 *      steps so a `set_mixer_control! lpf: 30; sleep 4; reset_mixer!` sweep
 *      sequences against playback (mirrors set_volume #197 lifecycle).
 *   2. Pure helpers — bt / rt / vt are pure BPM math (NOT current_beat
 *      wrappers — see audit corrections in #255). They read the calling
 *      builder's bpm so per-task scoping inside live_loops works.
 *
 * scsynth_info / status are verified through the engine harness; bridge
 * shape is exercised in SuperSonicBridge tests.
 */
import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'

describe('ProgramBuilder mixer setters (#255)', () => {
  it('set_mixer_control pushes a setMixerControl step with the opts hash', () => {
    const b = new ProgramBuilder()
    b.set_mixer_control({ lpf: 30, hpf: 200 })
    expect(b.build()).toEqual([
      { tag: 'setMixerControl', opts: { lpf: 30, hpf: 200 } },
    ])
  })

  it('reset_mixer pushes a resetMixer step', () => {
    const b = new ProgramBuilder()
    b.reset_mixer()
    expect(b.build()).toEqual([{ tag: 'resetMixer' }])
  })

  it('mixer steps interleave with sleep so a sweep sequences against playback', () => {
    // The whole point of deferring: top-level immediate would collapse
    // both calls to beat 0.
    const b = new ProgramBuilder()
    b.set_mixer_control({ lpf: 30 })
    b.play(60, {})
    b.sleep(4)
    b.reset_mixer()
    const program = b.build()
    expect(program.map(s => s.tag)).toEqual([
      'setMixerControl', 'play', 'sleep', 'resetMixer',
    ])
  })

  it('set_mixer_control rejects non-object opts', () => {
    const b = new ProgramBuilder()
    expect(() => b.set_mixer_control(42 as unknown as Record<string, number>))
      .toThrow(/expects an opts hash/)
  })

  it('reset_mixer rejects extra arguments (cross-engine arity ethic)', () => {
    const b = new ProgramBuilder()
    expect(() => b.reset_mixer('extra' as unknown))
      .toThrow(/reset_mixer! expects no arguments/)
  })
})

describe('ProgramBuilder bt / rt / vt (#255)', () => {
  it('bt(t) returns t * 60 / bpm — beats to seconds at default bpm 60', () => {
    const b = new ProgramBuilder()
    expect(b.bt(1)).toBe(1)   // bpm 60: 1 beat = 1 second
    expect(b.bt(2)).toBe(2)
  })

  it('bt scales with use_bpm (per-task bpm scoping)', () => {
    const b = new ProgramBuilder()
    b.use_bpm(120)
    // bpm 120: sleep_mul = 60/120 = 0.5; bt(1) = 1 * 0.5 = 0.5
    expect(b.bt(1)).toBeCloseTo(0.5)
    b.use_bpm(30)
    // bpm 30: sleep_mul = 2.0; bt(1) = 2.0
    expect(b.bt(1)).toBeCloseTo(2.0)
  })

  it('rt(t) returns t * bpm / 60 — seconds to beats (bypasses bpm scaling)', () => {
    const b = new ProgramBuilder()
    b.use_bpm(120)
    // bpm 120: rt(1) = 1 / 0.5 = 2.0 — to sleep 1 real second, sleep rt(1) beats
    expect(b.rt(1)).toBeCloseTo(2.0)
    b.use_bpm(60)
    expect(b.rt(1)).toBeCloseTo(1.0)
  })

  it('bt and rt are inverses', () => {
    const b = new ProgramBuilder()
    b.use_bpm(140)
    expect(b.bt(b.rt(1))).toBeCloseTo(1)
    expect(b.rt(b.bt(2.5))).toBeCloseTo(2.5)
  })

  it('vt is an alias of current_time (not scheduler.virtualTime — audit correction)', () => {
    const b = new ProgramBuilder()
    expect(b.vt()).toBe(b.current_time())
  })

  it('bt/rt/vt do not push steps (pure builder reads, not deferred)', () => {
    const b = new ProgramBuilder()
    b.use_bpm(120)
    void b.bt(1)
    void b.rt(1)
    void b.vt()
    // Only the use_bpm step from above; bt/rt/vt are pure
    const program = b.build()
    expect(program.every(s => s.tag !== 'setMixerControl' && s.tag !== 'resetMixer')).toBe(true)
    expect(program.find(s => s.tag === 'useBpm')).toBeDefined()
  })
})
