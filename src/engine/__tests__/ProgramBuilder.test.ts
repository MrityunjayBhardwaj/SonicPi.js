import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'
import { noteToMidi, midiToFreq } from '../NoteToFreq'

describe('ProgramBuilder', () => {
  it('play() adds a play step with correct note, opts, synth', () => {
    const b = new ProgramBuilder()
    b.play(60, { amp: 0.5 })
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('play')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'play' }>
    expect(step.note).toBe(60)
    expect(step.opts.amp).toBe(0.5)
    expect(step.opts.freq).toBeUndefined() // freq not stored — synthdefs convert note (MIDI) internally
    expect(step.synth).toBe('beep') // default synth
  })

  it('play() converts string notes to MIDI', () => {
    const b = new ProgramBuilder()
    b.play('c4')
    const steps = b.build()
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'play' }>
    expect(step.note).toBe(noteToMidi('c4'))
  })

  it('play() accepts per-note synth override via opts', () => {
    const b = new ProgramBuilder()
    b.play(60, { synth: 'prophet' } as unknown as Record<string, number>)
    const steps = b.build()
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'play' }>
    expect(step.synth).toBe('prophet')
    // synth should not appear in opts
    expect(step.opts).not.toHaveProperty('synth')
  })

  it('sleep() adds a sleep step', () => {
    const b = new ProgramBuilder()
    b.sleep(0.5)
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('sleep')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'sleep' }>
    expect(step.beats).toBe(0.5)
  })

  it('sample() adds a sample step', () => {
    const b = new ProgramBuilder()
    b.sample('bd_haus', { amp: 0.8 })
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('sample')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'sample' }>
    expect(step.name).toBe('bd_haus')
    expect(step.opts.amp).toBe(0.8)
  })

  it('use_synth() changes the synth for subsequent plays', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.use_synth('prophet')
    b.play(64)
    const steps = b.build()

    const play1 = steps[0] as Extract<(typeof steps)[0], { tag: 'play' }>
    const play2 = steps[2] as Extract<(typeof steps)[0], { tag: 'play' }>
    expect(play1.synth).toBe('beep')
    expect(play2.synth).toBe('prophet')
  })

  it('use_synth() also adds a useSynth step', () => {
    const b = new ProgramBuilder()
    b.use_synth('tb303')
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('useSynth')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'useSynth' }>
    expect(step.name).toBe('tb303')
  })

  it('use_bpm() adds a useBpm step', () => {
    const b = new ProgramBuilder()
    b.use_bpm(120)
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('useBpm')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'useBpm' }>
    expect(step.bpm).toBe(120)
  })

  it('rrand is deterministic with the same seed', () => {
    const b1 = new ProgramBuilder(42)
    const b2 = new ProgramBuilder(42)

    const vals1 = [b1.rrand(0, 100), b1.rrand(0, 100), b1.rrand(0, 100)]
    const vals2 = [b2.rrand(0, 100), b2.rrand(0, 100), b2.rrand(0, 100)]

    expect(vals1).toEqual(vals2)
  })

  it('choose is deterministic with the same seed', () => {
    const b1 = new ProgramBuilder(42)
    const b2 = new ProgramBuilder(42)

    const items = ['a', 'b', 'c', 'd']
    const vals1 = Array.from({ length: 5 }, () => b1.choose(items))
    const vals2 = Array.from({ length: 5 }, () => b2.choose(items))

    expect(vals1).toEqual(vals2)
    for (const v of vals1) {
      expect(items).toContain(v)
    }
  })

  it('dice is deterministic with the same seed', () => {
    const b1 = new ProgramBuilder(7)
    const b2 = new ProgramBuilder(7)

    const vals1 = Array.from({ length: 5 }, () => b1.dice(6))
    const vals2 = Array.from({ length: 5 }, () => b2.dice(6))

    expect(vals1).toEqual(vals2)
    for (const v of vals1) {
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(6)
    }
  })

  it('different seeds produce different sequences', () => {
    const b1 = new ProgramBuilder(1)
    const b2 = new ProgramBuilder(999)

    const vals1 = Array.from({ length: 10 }, () => b1.rrand(0, 1000))
    const vals2 = Array.from({ length: 10 }, () => b2.rrand(0, 1000))

    expect(vals1).not.toEqual(vals2)
  })

  it('use_random_seed resets the RNG mid-build', () => {
    const b1 = new ProgramBuilder()
    b1.use_random_seed(42)
    const v1 = b1.rrand(0, 100)

    const b2 = new ProgramBuilder()
    b2.use_random_seed(42)
    const v2 = b2.rrand(0, 100)

    expect(v1).toBe(v2)
  })

  it('tick increments per call, look returns current value', () => {
    const b = new ProgramBuilder()

    expect(b.tick()).toBe(0)
    expect(b.tick()).toBe(1)
    expect(b.tick()).toBe(2)
    expect(b.look()).toBe(2) // last ticked value
  })

  it('tick/look support named counters', () => {
    const b = new ProgramBuilder()

    expect(b.tick('a')).toBe(0)
    expect(b.tick('b')).toBe(0)
    expect(b.tick('a')).toBe(1)
    expect(b.look('a')).toBe(1)
    expect(b.look('b')).toBe(0)
  })

  it('look returns 0 before any tick', () => {
    const b = new ProgramBuilder()
    expect(b.look()).toBe(0)
  })

  it('with_fx creates a nested program', () => {
    const b = new ProgramBuilder()
    b.with_fx('reverb', { room: 0.8 }, (inner) => {
      inner.play(60)
      inner.sleep(0.5)
      return inner
    })
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('fx')
    const fxStep = steps[0] as Extract<(typeof steps)[0], { tag: 'fx' }>
    expect(fxStep.name).toBe('reverb')
    expect(fxStep.opts.room).toBe(0.8)
    expect(fxStep.body).toHaveLength(2)
    expect(fxStep.body[0].tag).toBe('play')
    expect(fxStep.body[1].tag).toBe('sleep')
  })

  it('with_fx works without opts', () => {
    const b = new ProgramBuilder()
    b.with_fx('reverb', (inner) => {
      inner.play(60)
      return inner
    })
    const steps = b.build()

    const fxStep = steps[0] as Extract<(typeof steps)[0], { tag: 'fx' }>
    expect(fxStep.name).toBe('reverb')
    expect(fxStep.body).toHaveLength(1)
  })

  it('puts() adds a print step', () => {
    const b = new ProgramBuilder()
    b.puts('hello', 'world')
    const steps = b.build()

    expect(steps).toHaveLength(1)
    expect(steps[0].tag).toBe('print')
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'print' }>
    expect(step.message).toBe('hello world')
  })

  it('puts() stringifies non-string arguments', () => {
    const b = new ProgramBuilder()
    b.puts('note:', 60)
    const steps = b.build()
    const step = steps[0] as Extract<(typeof steps)[0], { tag: 'print' }>
    expect(step.message).toBe('note: 60')
  })

  it('stop() adds a stop step', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.stop()
    b.play(64) // this still gets added to the array, but interpreters halt at stop
    const steps = b.build()

    expect(steps).toHaveLength(3)
    expect(steps[1].tag).toBe('stop')
  })

  it('build() returns a copy of steps', () => {
    const b = new ProgramBuilder()
    b.play(60)
    b.sleep(1)

    const steps1 = b.build()
    const steps2 = b.build()

    expect(steps1).toEqual(steps2)
    expect(steps1).not.toBe(steps2) // different array references
  })

  it('fluent chaining works', () => {
    const steps = new ProgramBuilder()
      .play(60)
      .sleep(0.5)
      .play(64)
      .sleep(0.5)
      .build()

    expect(steps).toHaveLength(4)
    expect(steps.map(s => s.tag)).toEqual(['play', 'sleep', 'play', 'sleep'])
  })

  describe('in_thread', () => {
    it('creates a thread step with sub-program', () => {
      const b = new ProgramBuilder()
      b.play(60).in_thread((b) => {
        b.play(72)
        b.sleep(0.5)
      }).sleep(1)
      const program = b.build()
      expect(program).toHaveLength(3)  // play, thread, sleep
      expect(program[1].tag).toBe('thread')
      expect((program[1] as any).body).toHaveLength(2)  // play, sleep
    })

    it('inherits currentSynth from parent', () => {
      const b = new ProgramBuilder()
      b.use_synth('prophet')
      b.in_thread((inner) => {
        inner.play(60)
      })
      const program = b.build()
      // program[0] = useSynth, program[1] = thread
      const threadStep = program[1] as any
      expect(threadStep.tag).toBe('thread')
      const playStep = threadStep.body[0]
      expect(playStep.synth).toBe('prophet')
    })

    it('inherits density from parent', () => {
      const b = new ProgramBuilder()
      b.density = 2
      b.in_thread((inner) => {
        inner.sleep(1)
      })
      const program = b.build()
      // program[0] = thread (no useSynth step, just density property)
      const threadStep = program[0] as any
      expect(threadStep.tag).toBe('thread')
      const sleepStep = threadStep.body[0]
      expect(sleepStep.beats).toBe(0.5)
    })
  })

  describe('at', () => {
    it('creates thread steps for each time offset', () => {
      const b = new ProgramBuilder()
      b.at([0, 0.5, 1], null, (inner, val) => {
        inner.play(60)
      })
      const steps = b.build()
      expect(steps).toHaveLength(3)
      expect(steps.every(s => s.tag === 'thread')).toBe(true)
    })

    it('first thread (offset 0) has no sleep prefix', () => {
      const b = new ProgramBuilder()
      b.at([0, 0.5, 1], null, (inner, val) => {
        inner.play(60)
      })
      const steps = b.build()
      const body0 = (steps[0] as any).body
      expect(body0).toHaveLength(1) // just play, no sleep
      expect(body0[0].tag).toBe('play')
    })

    it('subsequent threads have sleep prefix matching offset', () => {
      const b = new ProgramBuilder()
      b.at([0, 0.5, 1], null, (inner, val) => {
        inner.play(60)
      })
      const steps = b.build()

      const body1 = (steps[1] as any).body
      expect(body1).toHaveLength(2) // sleep 0.5, play
      expect(body1[0].tag).toBe('sleep')
      expect(body1[0].beats).toBe(0.5)

      const body2 = (steps[2] as any).body
      expect(body2).toHaveLength(2) // sleep 1, play
      expect(body2[0].tag).toBe('sleep')
      expect(body2[0].beats).toBe(1)
    })

    it('passes values from second array to buildFn', () => {
      const received: unknown[] = []
      const b = new ProgramBuilder()
      b.at([0, 1, 2], ['c4', 'e4', 'g4'], (inner, val) => {
        received.push(val)
        inner.play(60)
      })
      expect(received).toEqual(['c4', 'e4', 'g4'])
    })

    it('cycles values when shorter than times', () => {
      const received: unknown[] = []
      const b = new ProgramBuilder()
      b.at([0, 1, 2, 3], ['a', 'b'], (inner, val) => {
        received.push(val)
      })
      expect(received).toEqual(['a', 'b', 'a', 'b'])
    })

    it('passes index when values is null', () => {
      const received: unknown[] = []
      const b = new ProgramBuilder()
      b.at([0, 0.5, 1], null, (inner, val) => {
        received.push(val)
      })
      expect(received).toEqual([0, 1, 2])
    })

    it('inherits currentSynth from parent', () => {
      const b = new ProgramBuilder()
      b.use_synth('prophet')
      b.at([0], null, (inner) => {
        inner.play(60)
      })
      const steps = b.build()
      const threadBody = (steps[1] as any).body // steps[0] = useSynth
      expect(threadBody[0].synth).toBe('prophet')
    })

    it('inherits density from parent', () => {
      const b = new ProgramBuilder()
      b.density = 2
      b.at([0.5], null, (inner) => {
        inner.sleep(1)
      })
      const steps = b.build()
      const threadBody = (steps[0] as any).body
      // sleep prefix: 0.5 / density(2) = 0.25
      expect(threadBody[0].tag).toBe('sleep')
      expect(threadBody[0].beats).toBe(0.25)
      // body sleep: 1 / density(2) = 0.5
      expect(threadBody[1].tag).toBe('sleep')
      expect(threadBody[1].beats).toBe(0.5)
    })
  })

  describe('density', () => {
    it('density 2 halves sleep duration', () => {
      const b = new ProgramBuilder()
      b.density = 2
      b.sleep(1)
      const steps = b.build()

      const step = steps[0] as Extract<(typeof steps)[0], { tag: 'sleep' }>
      expect(step.beats).toBe(0.5)
    })

    it('nested density multiplies', () => {
      const b = new ProgramBuilder()
      b.density = 2
      b.density = b.density * 3
      b.sleep(1)
      const steps = b.build()

      const step = steps[0] as Extract<(typeof steps)[0], { tag: 'sleep' }>
      expect(step.beats).toBeCloseTo(1 / 6)
    })

    it('density resets after block', () => {
      const b = new ProgramBuilder()
      const prevDensity = b.density
      b.density = 2
      b.sleep(1) // beats = 0.5
      b.density = prevDensity
      b.sleep(1) // beats = 1.0
      const steps = b.build()

      const step0 = steps[0] as Extract<(typeof steps)[0], { tag: 'sleep' }>
      const step1 = steps[1] as Extract<(typeof steps)[0], { tag: 'sleep' }>
      expect(step0.beats).toBe(0.5)
      expect(step1.beats).toBe(1)
    })

    it('with_fx inner builder inherits density', () => {
      const b = new ProgramBuilder()
      b.density = 4
      b.with_fx('reverb', (inner) => {
        inner.sleep(1)
        return inner
      })
      const steps = b.build()
      const fxStep = steps[0] as Extract<(typeof steps)[0], { tag: 'fx' }>
      const sleepStep = fxStep.body[0] as Extract<(typeof steps)[0], { tag: 'sleep' }>
      expect(sleepStep.beats).toBe(0.25)
    })
  })

  describe('lastRef (node references for control)', () => {
    it('play() increments lastRef', () => {
      const b = new ProgramBuilder()
      b.play(60)
      expect(b.lastRef).toBe(1)
      b.play(72)
      expect(b.lastRef).toBe(2)
    })

    it('control uses lastRef to target a specific play step', () => {
      const b = new ProgramBuilder()
      b.play(60, { note_slide: 1 } as Record<string, number>)
      const ref = b.lastRef
      b.sleep(1)
      b.control(ref, { note: 65 })
      const steps = b.build()
      expect(steps).toHaveLength(3) // play, sleep, control
      expect(steps[2].tag).toBe('control')
      const ctrl = steps[2] as Extract<(typeof steps)[0], { tag: 'control' }>
      expect(ctrl.nodeRef).toBe(1)
      expect(ctrl.params.note).toBe(65)
    })

    it('kill uses lastRef to free a specific play step at scheduled time (#225)', () => {
      const b = new ProgramBuilder()
      b.play(60, { sustain: 10 } as Record<string, number>)
      const ref = b.lastRef
      b.sleep(0.5)
      b.kill(ref)
      b.sleep(1)
      const steps = b.build()
      expect(steps).toHaveLength(4) // play, sleep, kill, sleep
      expect(steps[2].tag).toBe('kill')
      const killStep = steps[2] as Extract<(typeof steps)[0], { tag: 'kill' }>
      expect(killStep.nodeRef).toBe(1)
    })
  })

  describe('timing introspection (#226)', () => {
    it('current_beat sums sleep arguments since iteration start', () => {
      const b = new ProgramBuilder()
      b.setIterationContext(0, 0, 0.3)
      expect(b.current_beat()).toBe(0)
      b.sleep(2)
      expect(b.current_beat()).toBe(2)
      b.sleep(0.5)
      expect(b.current_beat()).toBe(2.5)
    })

    it('current_beat seeds from engine-persisted value across iterations', () => {
      const b = new ProgramBuilder()
      b.setIterationContext(10, 7, 0.3)  // engine restored 7 beats from prior iteration
      expect(b.current_beat()).toBe(7)
      b.sleep(1)
      expect(b.current_beat()).toBe(8)
      // currentBeatRaw is what engine reads back at end of iteration
      expect(b.currentBeatRaw).toBe(8)
    })

    it('current_beat_duration tracks current bpm', () => {
      const b = new ProgramBuilder()
      expect(b.current_beat_duration()).toBe(1)  // default 60 bpm → 1s/beat
      b.use_bpm(120)
      expect(b.current_beat_duration()).toBe(0.5)
      b.use_bpm(60)
      expect(b.current_beat_duration()).toBe(1)
    })

    it('current_time advances by sleep × beat-duration from iteration-start audio time', () => {
      const b = new ProgramBuilder()
      b.setIterationContext(5, 0, 0.3)
      expect(b.current_time()).toBe(5)        // no sleep yet
      b.sleep(2)
      expect(b.current_time()).toBe(7)        // 5 + 2*1 (60 bpm default)
      b.use_bpm(120)
      b.sleep(2)
      expect(b.current_time()).toBe(8)        // 7 + 2*0.5
    })

    it('current_sched_ahead_time returns engine-set value', () => {
      const b = new ProgramBuilder()
      b.setIterationContext(0, 0, 0.45)
      expect(b.current_sched_ahead_time()).toBe(0.45)
    })

    it('inner builder (with_fx) inherits iteration context from outer', () => {
      const outer = new ProgramBuilder()
      outer.setIterationContext(10, 4, 0.3)
      outer.sleep(1)  // outer beat=5, build seconds=1
      let innerBeat = -1
      let innerTime = -1
      outer.with_fx('reverb', (inner) => {
        innerBeat = inner.current_beat()
        innerTime = inner.current_time()
        return inner
      })
      expect(innerBeat).toBe(5)
      expect(innerTime).toBe(11)  // 10 + 1
    })

    it('slide params pass through play opts', () => {
      const b = new ProgramBuilder()
      b.play(60, { note_slide: 1, amp_slide: 0.5, cutoff_slide: 2 } as Record<string, number>)
      const steps = b.build()
      const playStep = steps[0] as Extract<(typeof steps)[0], { tag: 'play' }>
      expect(playStep.opts.note_slide).toBe(1)
      expect(playStep.opts.amp_slide).toBe(0.5)
      expect(playStep.opts.cutoff_slide).toBe(2)
    })
  })

  describe('live_audio', () => {
    it('live_audio() adds a liveAudio step with name and default opts', () => {
      const b = new ProgramBuilder()
      b.live_audio('mic')
      const steps = b.build()

      expect(steps).toHaveLength(1)
      expect(steps[0].tag).toBe('liveAudio')
      const step = steps[0] as Extract<(typeof steps)[0], { tag: 'liveAudio' }>
      expect(step.name).toBe('mic')
      expect(step.opts).toEqual({})
    })

    it('live_audio() passes opts through', () => {
      const b = new ProgramBuilder()
      b.live_audio('mic', { stereo: 1 })
      const steps = b.build()

      const step = steps[0] as Extract<(typeof steps)[0], { tag: 'liveAudio' }>
      expect(step.opts.stereo).toBe(1)
    })
  })
})
