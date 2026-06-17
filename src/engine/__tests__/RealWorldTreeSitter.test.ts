import { describe, it, expect } from 'vitest'
import { autoTranspileDetailed } from '../TreeSitterTranspiler'

/**
 * Real-world Sonic Pi programs that must transpile via TreeSitter
 * WITHOUT fallback. These exercise complex syntax: /comment/ blocks,
 * set/get, case/when, knit, line, nested live_loops, spread arithmetic,
 * density, control, trailing if, define, sync/cue, nested with_fx, etc.
 */
describe('RealWorldTreeSitter', () => {

  function assertTreeSitterSuccess(code: string, label: string) {
    const result = autoTranspileDetailed(code)
    if (result.hasError) {
      console.log(`\n=== ${label} ERROR ===\n${result.errorMessage}\n`)
      console.log(`=== OUTPUT (first 1500 chars) ===\n${result.code?.slice(0, 1500)}\n`)
    }
    expect(result.hasError, `${label}: expected no fallback but got: ${result.errorMessage}`).toBe(false)
    expect(result.method, `${label}: expected tree-sitter method`).toBe('tree-sitter')
    expect(result.code, `${label}: expected truthy code`).toBeTruthy()
    expect(() => new Function(result.code), `${label}: produced invalid JS`).not.toThrow()
  }

  it('Test 1: Snowflight patterns — /comment/, set/get, case/when, knit, line, density, control, trailing if, variable reassignment', () => {
    const code = `
set_volume! 1.5

/Tape delay  -  need restart to sync - best without drums/
set :myTapeLoopDelay, 0

/ drums /
drums = knit(2,24,1,24, 2,48).look
drums = 2
case drums
when 0
  set :drumsKickAmp, 0  # 4
  set :drumsNoiseAmp, 0 # 1
when 1
  set :drumsKickAmp, 4  # 4
when 2
  set :drumsKickAmp, 3  # 4
  set :drumsNoiseAmp, 0.65 # 1
end

/mixer/
mixer = 2
case mixer
when 1 # 1 solo
  set :pan_a1, 0
  set :a1_amp, 1
  set :a2_amp, 0
when 2 # 2 with tape loop delay
  set :pan_a1, 0.75
  set :pan_a2, -0.75
  set :a1_amp, 1
  set :a2_amp, 0.75
end

set :a1synth, :saw
set :a2synth, :beep
set :a1octav, 0
set :a2octav, 12

use_bpm 88

with_fx :reverb, room: 0.7 do
  live_loop :a1 do
    tick
    use_synth get[:a1synth]
    use_synth_defaults release: 0.3+line(0,0.2, steps: 16).look, cutoff: line(70,110, steps: 128).mirror.look
    p = 6*4*2
    pat = knit(0,p, 1,p, 2,p, 3,p, 4,p, 5,p, 6,p).look
    case pat
    when 1
      n = :c3
      k = 6
      n1 = [0,7,11]
      npat = knit(n1,k, n1,k).look
    end
    play n+npat.look+get[:a1octav], pan: get[:pan_a1], amp: get[:a1_amp]
    sleep 0.25
  end

  live_loop :a2 do
    tick
    use_synth get[:a2synth]
    play :c3, pan: get[:pan_a2], amp: get[:a2_amp]
    sleep 0.25+get[:myTapeLoopDelay]
  end
end

with_fx :reverb, room: 0.6 do
  live_loop :b1 do
    tick
    sample :bd_fat, amp: get[:drumsKickAmp] if (spread(2,6)*3+spread(5,6) + spread(2,6)+spread(3,6)).look
    sleep 0.25
  end

  with_fx :krush, mix: 0.8 do |krush|
    live_loop :b2 do
      tick
      density [1,2,1,1,4,1].choose do
        control krush, mix: [0,0.2,0.4,0.8].choose
        use_synth :cnoise
        use_synth_defaults release: [0.1,0.2,0.3].choose-0.05, cutoff: [60,70,80,90,100].choose+[-10,0,10,20].choose, pan: rdist(1)
        play :c4, amp: get[:drumsNoiseAmp] if spread(22,32).look
        sleep 0.25
      end
    end
  end
end`
    assertTreeSitterSuccess(code, 'Snowflight')
  })

  it('Test 2: Complex Techno — nested with_fx, live_loops, tb303, ring.tick, spread.look, use_synth_defaults', () => {
    const code = `use_bpm 130
with_fx :reverb, room: 0.8 do
  live_loop :kick do
    sample :bd_haus, amp: 3
    sleep 0.5
  end
  live_loop :hats do
    tick
    sample :drum_cymbal_closed, amp: rrand(0.5, 1.0), pan: rdist(0.3) if spread(7, 16).look
    sleep 0.25
  end
  live_loop :bass do
    use_synth :tb303
    use_synth_defaults cutoff: rrand(60, 120), release: 0.2, env_curve: 1
    n = (ring :c2, :c2, :eb2, :c2, :f2, :c2, :g2, :c2).tick
    play n
    sleep 0.25
  end
end`
    assertTreeSitterSuccess(code, 'Complex Techno')
  })

  it('Test 3: Ambient with FX chain — nested with_fx, hollow/prophet synths, chord.choose, one_in, N.times do |i|', () => {
    const code = `use_bpm 60
with_fx :reverb, room: 0.9, mix: 0.7 do
  with_fx :echo, phase: 0.75, decay: 4, mix: 0.6 do
    live_loop :pad do
      use_synth :hollow
      notes = (chord :e3, :minor7)
      play notes.choose, attack: 2, release: 4, amp: 0.6, cutoff: rrand(60, 100)
      sleep 4
    end
    live_loop :melody do
      use_synth :prophet
      use_synth_defaults release: 0.3, cutoff: 90, amp: 0.4
      notes = (scale :e4, :minor_pentatonic)
      8.times do |i|
        play notes.choose if one_in(3)
        sleep 0.5
      end
    end
  end
end`
    assertTreeSitterSuccess(code, 'Ambient FX Chain')
  })

  it('Test 4: Sync/Cue pattern — cue, live_loop with sync option', () => {
    const code = `live_loop :metro do
  cue :tick
  sleep 1
end
live_loop :player, sync: :tick do
  sample :ambi_choir, rate: rrand(0.5, 1.5)
  sleep 2
end`
    assertTreeSitterSuccess(code, 'Sync/Cue')
  })

  it('Test 5: Define + call — define block with parameter, called from live_loop', () => {
    const code = `define :melody do |n|
  play n, release: 0.3
  sleep 0.25
  play n + 7, release: 0.3
  sleep 0.25
end
live_loop :main do
  melody :c4
  melody :e4
  melody :g4
  sleep 1
end`
    assertTreeSitterSuccess(code, 'Define + Call')
  })

  it('case/when with inline comments transpiles correctly', () => {
    const code = `x = 1
case x
when 1 # first case
  puts "one"
when 2 # second case
  puts "two"
end`
    assertTreeSitterSuccess(code, 'case/when with inline comments')
  })

  // #585: a non-literal `use_synth` before a loop must reach the loop (was dropped
  // → stale `:beep`). A SELF-CONTAINED arg (literals + DSL calls only) is hoisted
  // to a single eager top-level draw; a VAR-dependent arg safely stays deferred.
  describe('#585 — non-literal use_synth before a loop', () => {
    it('self-contained choose([...]) is hoisted: drawn once, eager prefix, bareCode reuse', () => {
      const r = autoTranspileDetailed('use_synth choose([:tri, :saw])\nloop do\n  play 60\n  sleep 0.5\nend')
      expect(r.hasError).toBe(false)
      // drawn ONCE into a hoist var at top level (before the loop registers)
      expect(r.code).toMatch(/__sy_0 = choose\(\["tri", "saw"\]\)/)
      // eager prefix carries it into the loop registration (not :beep)
      expect(r.code).toMatch(/use_synth\(__sy_0\)/)
      // bareCode reuses the var — NO second choose() draw
      expect((r.code.match(/choose\(/g) ?? []).length).toBe(1)
    })

    it('#591 var-dependent choose(synths): drawn once in __run_once, loop reads it via __synthThunk', () => {
      const r = autoTranspileDetailed('synths = [:tri, :saw]\nuse_synth choose(synths)\nloop do\n  play 60\n  sleep 0.5\nend')
      expect(r.hasError).toBe(false)
      // NOT hoisted to topJS (the free var `synths` lives in deferred bareCode) —
      // instead drawn at source position INSIDE __run_once into a var
      expect(r.code).toMatch(/__sy_0 = __b\.choose\(synths\)/)
      // builder-local set for bare-play interleave (no global defaultSynth write)
      expect(r.code).toMatch(/__b\.use_synth\(__sy_0\)/)
      // ONE draw only — no second choose() of synths
      expect((r.code.match(/__b\.choose\(synths\)/g) ?? []).length).toBe(1)
      // the loop carries a per-loop thunk reading __sy_0 lazily at first build
      expect(r.code).toMatch(/__synthThunk: \(\) => __sy_0/)
    })

    it('#591 mid-PRNG sequence (40_choose_generator shape): synth drawn at its seeded position, no extra draw', () => {
      // use_random_seed/use_bpm(rrand) hoist to topJS (draw #1 = rrand); the
      // var-dependent use_synth draws at its source position INSIDE __run_once
      // (draw #2), preserving the seeded stream; the bare loop reads it via thunk.
      const r = autoTranspileDetailed(
        'use_random_seed 0\nuse_bpm rrand(90, 130)\nsynths = [:piano, :saw, :tri]\nuse_synth choose(synths)\nc = choose([:c4, :e4])\nloop do\n  play c\n  sleep 0.5\nend')
      expect(r.hasError).toBe(false)
      // synth drawn once in __run_once; the bare loop reads it via __synthThunk
      expect(r.code).toMatch(/__sy_0 = __b\.choose\(synths\)/)
      expect(r.code).toMatch(/__synthThunk: \(\) => __sy_0/)
      // exactly ONE choose(synths) — no eager re-draw that would desync the stream
      expect((r.code.match(/__b\.choose\(synths\)/g) ?? []).length).toBe(1)
      // the seed/bpm stay hoisted (topJS) — unchanged
      expect(r.code).toMatch(/use_random_seed\(0\)/)
      expect(r.code).toMatch(/use_bpm\(rrand\(90, 130\)\)/)
    })

    it('#591 var-dependent use_synth before a live_loop also gets a per-loop __synthThunk', () => {
      // trailing bare `sleep` forces the __run_once wrapper, so the use_synth is
      // deferred (without it, use_synth runs eagerly at top level — no #591 path).
      const r = autoTranspileDetailed('opts = [:tri, :saw]\nuse_synth choose(opts)\nlive_loop :m do\n  play 60\n  sleep 0.5\nend\nsleep 0.1')
      expect(r.hasError).toBe(false)
      expect(r.code).toMatch(/__sy_0 = __b\.choose\(opts\)/)
      expect(r.code).toMatch(/live_loop\("m".*__synthThunk: \(\) => __sy_0/)
    })

    it('literal use_synth :tri still emits the eager string prefix (unchanged)', () => {
      const r = autoTranspileDetailed('use_synth :tri\nloop do\n  play 60\n  sleep 0.5\nend')
      expect(r.hasError).toBe(false)
      expect(r.code).toMatch(/use_synth\("tri"\)/)
      expect(r.code).not.toMatch(/__sy_\d+/)
    })
  })
})
