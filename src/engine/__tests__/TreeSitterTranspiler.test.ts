/**
 * TreeSitterTranspiler tests — validates the catamorphism over the Ruby grammar.
 *
 * Uses WASM files from node_modules (not public/) for test-time loading.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { initTreeSitter, treeSitterTranspile, isTreeSitterReady } from '../TreeSitterTranspiler'
import { ProgramBuilder } from '../ProgramBuilder'
import { ring } from '../Ring'
import { spread } from '../EuclideanRhythm'
import { chord, scale, chord_invert, note, note_range } from '../ChordScale'
import { noteToMidi, midiToFreq, noteToFreq } from '../NoteToFreq'
// Resolve WASM paths for Node.js test environment
const base = new URL('../../..', import.meta.url).pathname
const tsWasm = base + 'node_modules/web-tree-sitter/tree-sitter.wasm'
const rubyWasm = base + 'node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm'

/** Strip whitespace variations for test comparison. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('TreeSitterTranspiler', () => {
  beforeAll(async () => {
    const ok = await initTreeSitter({
      treeSitterWasmUrl: tsWasm,
      rubyWasmUrl: rubyWasm,
    })
    expect(ok).toBe(true)
    expect(isTreeSitterReady()).toBe(true)
  })

  describe('Task 1: Setup & Prototype', () => {
    it('parses and transpiles a basic live_loop', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const result = treeSitterTranspile(ruby)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('live_loop("drums"')
      expect(result.code).toContain('b.sample("bd_haus"')
      expect(result.code).toContain('b.sleep(0.5)')
    })

    it('output is valid JS (can be parsed by new Function)', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`
      const result = treeSitterTranspile(ruby)
      expect(result.ok).toBe(true)
      expect(() => new Function(result.code)).not.toThrow()
    })
  })

  describe('Literals', () => {
    it('transpiles symbols to strings', () => {
      const result = treeSitterTranspile(`live_loop :test do
  sample :bd_haus
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('"bd_haus"')
    })

    it('transpiles nil to null', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = nil
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('null')
    })
  })

  describe('DSL functions', () => {
    it('play with note and opts', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play 60, release: 0.3, amp: 0.8
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.play(60')
      expect(result.code).toContain('release: 0.3')
      expect(result.code).toContain('amp: 0.8')
    })

    it('use_synth outside loop has no b. prefix', () => {
      const result = treeSitterTranspile(`use_synth :prophet
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_synth("prophet")')
      // Inside the loop, play gets b. prefix
      expect(result.code).toContain('b.play(60')
    })

    it('use_bpm', () => {
      const result = treeSitterTranspile(`use_bpm 120
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_bpm(120)')
    })

    it('sync and cue', () => {
      const result = treeSitterTranspile(`live_loop :a do
  cue :tick
  sleep 1
end
live_loop :b do
  sync :tick
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.cue("tick")')
      expect(result.code).toContain('b.sync("tick")')
    })

    it('ring and tick', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play (ring 60, 64, 67).tick
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.ring(60, 64, 67)')
      expect(result.code).toContain('.at(b.tick())')
    })

    it('scale and choose', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play scale(:c4, :minor_pentatonic).choose
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.scale("c4", "minor_pentatonic")')
      expect(result.code).toContain('.choose()')
    })

    it('rrand', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play rrand(50, 80)
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.rrand(50, 80)')
    })

    it('spread pattern', () => {
      const result = treeSitterTranspile(`live_loop :t do
  pattern = spread(5, 8)
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.spread(5, 8)')
    })
  })

  describe('Control flow', () => {
    it('if statement', () => {
      const result = treeSitterTranspile(`live_loop :t do
  if one_in(3)
    sample :drum_heavy_kick
  end
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('b.one_in(3)')
    })

    it('trailing if modifier', () => {
      const result = treeSitterTranspile(`live_loop :t do
  sample :bd_haus if one_in(2)
  sleep 0.25
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('b.sample("bd_haus"')
    })

    it('unless modifier', () => {
      const result = treeSitterTranspile(`live_loop :t do
  sample :bd_haus unless one_in(4)
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('!(')
    })

    it('case/when', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = rrand_i(1, 3)
  case x
  when 1
    play 60
  when 2
    play 64
  when 3
    play 67
  end
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('if (')
      expect(result.code).toContain('else if')
    })
  })

  describe('Blocks', () => {
    it('with_fx', () => {
      const result = treeSitterTranspile(`live_loop :t do
  with_fx :reverb, room: 0.8 do
    play 60
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.with_fx("reverb"')
      expect(result.code).toContain('room: 0.8')
    })

    it('N.times do', () => {
      const result = treeSitterTranspile(`live_loop :t do
  4.times do
    play 60
    sleep 0.25
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('for (let')
      expect(result.code).toContain('< 4')
      expect(result.code).toContain('b.__checkBudget__()')
    })

    it('.each do |n|', () => {
      const result = treeSitterTranspile(`live_loop :t do
  [60, 64, 67].each do |n|
    play n
    sleep 0.25
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('for (const n of')
      expect(result.code).toContain('b.__checkBudget__()')
    })

    it('in_thread', () => {
      const result = treeSitterTranspile(`live_loop :t do
  in_thread do
    play 60
    sleep 1
  end
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.in_thread(')
    })

    it('define with block params', () => {
      const result = treeSitterTranspile(`define :bass_hit do
  sample :bd_haus, amp: 2
end

live_loop :groove do
  bass_hit
  sleep 0.5
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('function bass_hit(b)')
      // Call to defined function should inject b
      expect(result.code).toContain('bass_hit(b)')
    })
  })

  describe('Expressions', () => {
    it('variable assignment', () => {
      const result = treeSitterTranspile(`live_loop :t do
  n = 60
  play n
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('n = 60')
    })

    it('binary operators', () => {
      const result = treeSitterTranspile(`live_loop :t do
  play 60 + 12
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('60 + 12')
    })

    it('string interpolation', () => {
      const result = treeSitterTranspile(`live_loop :t do
  n = 60
  puts "playing #{n}"
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('`playing ${n}`')
    })

    it('array access', () => {
      const result = treeSitterTranspile(`live_loop :t do
  x = [60, 64, 67]
  play x[0]
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('x[0]')
    })
  })

  describe('Comments', () => {
    it('full-line comment', () => {
      const result = treeSitterTranspile(`# This is a comment
live_loop :t do
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('//')
    })
  })

  describe('Advanced constructs', () => {
    it('define with default parameters', () => {
      const result = treeSitterTranspile(`define :ocean do |num, amp_mul=1|
  num.times do
    play 60, amp: amp_mul
    sleep 1
  end
end

live_loop :t do
  ocean 3
  sleep 4
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('function ocean(b, num, amp_mul = 1)')
    })

    it('begin/rescue', () => {
      const result = treeSitterTranspile(`live_loop :t do
  begin
    play 60
    sleep 0.5
  rescue
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('try {')
      expect(result.code).toContain('catch')
    })

    it('live_loop with sync option', () => {
      const result = treeSitterTranspile(`live_loop :kick, sync: :met1 do
  sample :bd_haus
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('live_loop("kick"')
      expect(result.code).toContain('b.sync("met1")')
    })

    it('nested with_fx', () => {
      const result = treeSitterTranspile(`live_loop :t do
  with_fx :reverb do
    with_fx :echo do
      play 60
      sleep 1
    end
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.with_fx("reverb"')
      expect(result.code).toContain('b.with_fx("echo"')
    })

    it('use_synth_defaults', () => {
      const result = treeSitterTranspile(`live_loop :t do
  use_synth_defaults mod_phase: 0.125, pulse_width: 0.8
  play 60
  sleep 1
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('use_synth_defaults(')
      expect(result.code).toContain('mod_phase: 0.125')
    })

    it('control with node ref', () => {
      const result = treeSitterTranspile(`live_loop :t do
  s = play 60, release: 4, note_slide: 1
  sleep 1
  control s, note: 65
  sleep 3
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('b.play(')
      expect(result.code).toContain('b.control(')
    })

    it('with_fx at top level (outside live_loop)', () => {
      const result = treeSitterTranspile(`with_fx :reverb, mix: 0.7 do
  live_loop :t do
    play 60
    sleep 1
  end
end`)
      expect(result.ok).toBe(true)
      expect(result.code).toContain('with_fx("reverb"')
    })
  })

  describe('Built-in examples compatibility', () => {
    const examples = [
      {
        name: 'Hello Beep',
        code: `play 60
sleep 1
play 64
sleep 1
play 67`,
      },
      {
        name: 'Basic Beat',
        code: `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`,
      },
      {
        name: 'Ambient Pad',
        code: `use_synth :prophet
live_loop :pad do
  play chord(:e3, :minor), release: 4, amp: 0.6
  sleep 4
end`,
      },
      {
        name: 'Arpeggio with tick',
        code: `use_synth :tb303
live_loop :arp do
  play (ring 60, 64, 67, 72).tick, release: 0.2, cutoff: 80
  sleep 0.25
end`,
      },
      {
        name: 'Random Melody',
        code: `use_random_seed 42
live_loop :melody do
  use_synth :pluck
  play scale(:c4, :minor_pentatonic).choose, release: 0.3
  sleep 0.25
end`,
      },
      {
        name: 'FX Chain',
        code: `live_loop :fx_demo do
  with_fx :reverb, room: 0.8 do
    with_fx :distortion, distort: 0.5 do
      play 50, release: 0.5
      sleep 0.5
      play 55, release: 0.5
      sleep 0.5
    end
  end
end`,
      },
      {
        name: 'Minimal Techno',
        code: `use_bpm 130

live_loop :kick do
  sample :bd_haus, amp: 1.5
  sleep 1
end

live_loop :hats do
  pattern = spread(7, 16)
  16.times do |i|
    sample :hat_snap, amp: 0.4 if pattern[i]
    sleep 0.25
  end
end

live_loop :acid do
  use_synth :tb303
  notes = ring(:e2, :e2, :e3, :e2, :g2, :e2, :a2, :e2)
  play notes.tick, release: 0.2, cutoff: rrand(40, 120), res: 0.3
  sleep 0.25
end`,
      },
    ]

    for (const ex of examples) {
      it(`transpiles "${ex.name}" to valid JS`, () => {
        const result = treeSitterTranspile(ex.code)
        expect(result.ok).toBe(true)
        expect(result.errors).toEqual([])
        expect(() => new Function(result.code)).not.toThrow()
      })
    }
  })

  describe('Community programs (stress test)', () => {
    const communityPrograms = [
      {
        name: 'Blockgame (excerpt)',
        code: `use_bpm 130
live_loop :met1 do
  sleep 1
end
cmaster1 = 130
define :pattern do |pattern|
  return pattern.ring.at(b.tick()) == "x"
end
live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern("x--x--x---x--x--")
  sleep 0.25
end
with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sleep 1
    end
  end
end`,
      },
      {
        name: 'Sonic Dreams (excerpt)',
        code: `use_debug false
define :ocean do |num, amp_mul=1|
  num.times do
    s = synth [:bnoise, :cnoise, :gnoise].choose, amp: rrand(0.5, 1.5) * amp_mul, attack: rrand(0, 1), sustain: rrand(0, 2), release: rrand(0, 5) + 0.5, cutoff: rrand(60, 100), pan: rrand(-1, 1)
    control s, pan: rrand(-1, 1), cutoff: rrand(60, 110)
    sleep rrand(0.5, 4)
  end
end
uncomment do
  use_random_seed 1000
  with_bpm 45 do
    with_fx :reverb do
      with_fx :echo, delay: 0.5, decay: 4 do
        in_thread do
          use_random_seed 2
          ocean 5
          ocean 1, 0.5
        end
        sleep 10
      end
    end
  end
end`,
      },
      {
        name: 'Cloud Beat (excerpt)',
        code: `use_bpm 100
live_loop :hiss_loop do
  sample :vinyl_hiss, amp: 2
  sleep sample_duration(:vinyl_hiss)
end
define :hihat do
  use_synth :pnoise
  with_fx :hpf, cutoff: 120 do
    play release: 0.01, amp: 13
  end
end
live_loop :hihat_loop do
  divisors = ring(2, 4, 2, 2, 2, 2, 2, 6)
  divisors.tick.times do
    hihat
    sleep 1.0 / divisors.look
  end
end
define :bassdrum do |note1, duration, note2=note1|
  use_synth :sine
  with_fx :hpf, cutoff: 100 do
    play note1 + 24, amp: 40, release: 0.01
  end
  with_fx :distortion, distort: 0.1, mix: 0.3 do
    with_fx :lpf, cutoff: 26 do
      with_fx :hpf, cutoff: 55 do
        bass = play note1, amp: 85, release: duration, note_slide: duration
        control bass, note: note2
      end
    end
  end
  sleep duration
end
live_loop :bassdrum_schleife do
  bassdrum 36, 1.5
  bassdrum 36, 1.5
  bassdrum 36, 1.0
end`,
      },
      {
        name: 'Shufflit (excerpt)',
        code: `use_debug false
use_random_seed 667
live_loop :travelling do
  use_synth :beep
  notes = scale(:e3, :minor_pentatonic, num_octaves: 1)
  use_random_seed 679
  tick_reset_all
  with_fx :echo, phase: 0.125, mix: 0.4, reps: 16 do
    sleep 0.25
    play notes.choose, attack: 0, release: 0.1, amp: rrand(2, 2.5)
  end
end`,
      },
      {
        name: 'Hip Hop Beat',
        code: `use_bpm 90
live_loop :biitti do
  sample :bd_808, rate: 1, amp: 4
  sleep 1
  sample :elec_hi_snare, amp: 1
  sleep 1
end
live_loop :ujellus do
  with_fx :echo, phase: 1.5, mix: 0.5 do
    use_synth :mod_beep
    use_synth_defaults mod_phase: 0.125, pulse_width: 0.8, mod_wave: 2, attack: 1
    play :G5
    sleep 8
  end
end
live_loop :hihat do
  16.times do
    sample :drum_cymbal_pedal, start: 0.05, finish: 0.4, rate: 3, amp: 0.5 + rrand(-0.1, 0.1)
    sleep 0.125
  end
end`,
      },
      {
        name: 'Tilburg 2 (excerpt)',
        code: `use_debug false
live_loop :low do
  tick
  synth :zawa, wave: 1, phase: 0.25, release: 5, note: (knit(:e1, 12, :c1, 4)).look, cutoff: (line(60, 120, steps: 6)).look
  sleep 4
end
with_fx :reverb, room: 1 do
  live_loop :lands do
    use_synth :dsaw
    use_random_seed 310003
    ns = scale(:e2, :minor_pentatonic, num_octaves: 4).take(4)
    16.times do
      play ns.choose, detune: 12, release: 0.1, amp: 2, cutoff: rrand(70, 120)
      sleep 0.125
    end
  end
end
live_loop :tijd do
  sample :bd_haus, amp: 2.5, cutoff: 100
  sleep 0.5
end`,
      },
    ]

    for (const prog of communityPrograms) {
      it(`transpiles "${prog.name}" to valid JS`, () => {
        const result = treeSitterTranspile(prog.code)
        if (!result.ok) {
          console.error(`[${prog.name}] Errors:`, result.errors)
          console.error(`[${prog.name}] Output:\n${result.code}`)
        }
        expect(result.ok).toBe(true)
        expect(() => new Function(result.code)).not.toThrow()
      })
    }
  })

  describe('Semantic execution (tier 2 — runs against ProgramBuilder)', () => {
    /**
     * Execute transpiled code against a real ProgramBuilder and return
     * the program steps. This catches runtime crashes from calling
     * non-existent methods, wrong argument shapes, etc.
     */
    function executeTranspiled(ruby: string): { steps: any[]; error?: string } {
      const result = treeSitterTranspile(ruby)
      if (!result.ok) return { steps: [], error: result.errors[0] }

      try {
        // Set up a minimal execution scope matching SonicPiEngine.evaluate()
        // eslint-disable-next-line prefer-const -- assigned inside new Function callback
        let capturedBuilderFn: ((b: ProgramBuilder) => void) | null = null as ((b: ProgramBuilder) => void) | null
        const live_loop = (_name: string, fn: (b: ProgramBuilder) => void) => {
          capturedBuilderFn = fn
        }
        const use_bpm = (_bpm: number) => {}
        const use_synth = (_name: string) => {}
        const use_random_seed = (_seed: number) => {}
        const puts = (..._args: unknown[]) => {}
        const stop = () => {}
        const stop_loop = (_name: string) => {}
        const set = (_k: string, _v: unknown) => {}
        const get = new Proxy({}, { get: () => null })
        const in_thread = (fn: (b: ProgramBuilder) => void) => fn(new ProgramBuilder())
        const at = (_t: number[], _v: unknown, _fn: any) => {}
        const density = (_n: number, _fn: any) => {}
        const with_fx = (_name: string, ...args: any[]) => {
          const fn = args[args.length - 1]
          if (typeof fn === 'function') fn(new ProgramBuilder())
        }
        const sample_duration = () => 1
        const sample_names = () => []
        const sample_groups = () => []
        const sample_loaded = () => false

        // Execute the transpiled code in the scope
        const fn = new Function(
          'live_loop', 'use_bpm', 'use_synth', 'use_random_seed',
          'puts', 'stop', 'stop_loop', 'set', 'get',
          'in_thread', 'at', 'density', 'with_fx',
          'ring', 'spread', 'chord', 'scale', 'chord_invert', 'note', 'note_range',
          'noteToMidi', 'midiToFreq', 'noteToFreq',
          'sample_duration', 'sample_names', 'sample_groups', 'sample_loaded',
          result.code,
        )
        fn(
          live_loop, use_bpm, use_synth, use_random_seed,
          puts, stop, stop_loop, set, get,
          in_thread, at, density, with_fx,
          ring, spread, chord, scale, chord_invert, note, note_range,
          noteToMidi, midiToFreq, noteToFreq,
          sample_duration, sample_names, sample_groups, sample_loaded,
        )

        if (!capturedBuilderFn) return { steps: [], error: 'No live_loop captured' }

        const builder = new ProgramBuilder(42)
        capturedBuilderFn(builder)
        return { steps: builder.build() }
      } catch (e: any) {
        return { steps: [], error: e.message }
      }
    }

    it('play 60 produces a play step with correct MIDI note', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps.length).toBe(2)
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60)
      expect(steps[1].tag).toBe('sleep')
    })

    it('sample :bd_haus produces a sample step', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  sample :bd_haus
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('sample')
      expect(steps[0].name).toBe('bd_haus')
    })

    it('play with opts passes through correctly', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60, release: 0.3, amp: 0.8
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].opts.release).toBe(0.3)
      expect(steps[0].opts.amp).toBe(0.8)
    })

    it('use_synth changes the synth', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_synth :prophet
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('useSynth')
      expect(steps[0].name).toBe('prophet')
      expect(steps[1].tag).toBe('play')
    })

    it('ring and tick produce correct values', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play (ring 60, 64, 67).tick
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60) // first tick → index 0
    })

    it('variable reassignment works (bare assignment, not const)', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  x = 60
  x = x + 12
  play x
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(72)
    })

    it('with_fx produces an fx step with body', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  with_fx :reverb, room: 0.8 do
    play 60
    sleep 1
  end
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('fx')
      expect(steps[0].name).toBe('reverb')
      expect(steps[0].opts.room).toBe(0.8)
      expect(steps[0].body.length).toBeGreaterThan(0)
    })

    it('N.times loop produces repeated steps', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  3.times do
    play 60
    sleep 0.25
  end
end`)
      expect(error).toBeUndefined()
      // 3 iterations × (play + sleep) = 6 steps
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      expect(playSteps.length).toBe(3)
    })

    it('cue and sync produce correct steps', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  cue :beat
  sync :bass
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('cue')
      expect(steps[0].name).toBe('beat')
      expect(steps[1].tag).toBe('sync')
      expect(steps[1].name).toBe('bass')
    })

    it('define creates callable function with b injection', () => {
      const { steps, error } = executeTranspiled(`define :hit do
  sample :bd_haus
end

live_loop :t do
  hit
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('sample')
      expect(steps[0].name).toBe('bd_haus')
    })

    it('use_transpose shifts play notes', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_transpose 12
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      const playStep = steps.find((s: any) => s.tag === 'play')
      expect(playStep).toBeDefined()
      expect(playStep!.note).toBe(72)
    })

    it('use_synth_defaults merges into play opts', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  use_synth_defaults release: 0.5, cutoff: 80
  play 60
  sleep 1
end`)
      expect(error).toBeUndefined()
      expect(steps[0].tag).toBe('play')
      expect(steps[0].opts.release).toBe(0.5)
      expect(steps[0].opts.cutoff).toBe(80)
    })

    it('tick_reset_all clears tick counters', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  tick
  tick
  tick_reset_all
  play (ring 60, 64, 67).tick
  sleep 1
end`)
      expect(error).toBeUndefined()
      // After reset, tick starts from 0 again → note 60
      expect(steps[0].tag).toBe('play')
      expect(steps[0].note).toBe(60)
    })

    it('factor? checks divisibility', () => {
      // factor_q(4, 2) → 4%2===0 → true
      const { steps, error } = executeTranspiled(`live_loop :t do
  play 60 if factor?(4, 2)
  sleep 1
end`)
      expect(error).toBeUndefined()
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      expect(playSteps.length).toBe(1)
    })

    it('bools creates boolean ring', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  pattern = bools(1, 0, 1, 0)
  sample :bd_haus if pattern[0]
  sleep 1
end`)
      expect(error).toBeUndefined()
      // bools(1,0,1,0)[0] = true → sample plays
      expect(steps[0].tag).toBe('sample')
    })

    it('play_pattern_timed plays notes with timing', () => {
      const { steps, error } = executeTranspiled(`live_loop :t do
  play_pattern_timed [60, 64, 67], [0.5]
  sleep 1
end`)
      expect(error).toBeUndefined()
      // 3 notes with 2 sleeps between them
      const playSteps = steps.filter((s: any) => s.tag === 'play')
      const sleepSteps = steps.filter((s: any) => s.tag === 'sleep')
      expect(playSteps.length).toBe(3)
      expect(sleepSteps.length).toBeGreaterThanOrEqual(2)
    })
  })
})
