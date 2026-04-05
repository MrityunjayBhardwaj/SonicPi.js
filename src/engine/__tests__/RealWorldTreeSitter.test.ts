import { describe, it, expect } from 'vitest'
import { autoTranspileDetailed } from '../RubyTranspiler'

/**
 * Real-world Sonic Pi programs that must transpile via TreeSitter
 * WITHOUT fallback. These exercise complex syntax: /comment/ blocks,
 * set/get, case/when, knit, line, nested live_loops, spread arithmetic,
 * density, control, trailing if, define, sync/cue, nested with_fx, etc.
 */
describe('RealWorldTreeSitter', () => {

  function assertTreeSitterSuccess(code: string, label: string) {
    const result = autoTranspileDetailed(code)
    if (result.usedFallback) {
      console.log(`\n=== ${label} FALLBACK ===\n${result.fallbackReason}\n`)
      console.log(`=== OUTPUT (first 1500 chars) ===\n${result.code?.slice(0, 1500)}\n`)
    }
    expect(result.usedFallback, `${label}: expected no fallback but got: ${result.fallbackReason}`).toBe(false)
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
})
