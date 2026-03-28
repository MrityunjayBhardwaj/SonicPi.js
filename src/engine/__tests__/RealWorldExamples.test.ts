/**
 * Real-world DSL compatibility matrix.
 *
 * Tests 50+ Sonic Pi programs through the transpiler pipeline:
 * 1. autoTranspile() — Ruby DSL → JS
 * 2. new Function() — validates the JS is syntactically valid
 * 3. Reports a compatibility matrix at the end.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { autoTranspile } from '../RubyTranspiler'
import { initTreeSitter, isTreeSitterReady, treeSitterTranspile } from '../TreeSitterTranspiler'

interface TestCase {
  name: string
  code: string
  shouldTranspile: boolean
}

// -----------------------------------------------------------------------
// Test corpus
//
// Sources:
//   - Built-in examples: this project's src/engine/examples.ts
//   - Tutorial patterns: adapted from the official Sonic Pi Tutorial
//     https://sonic-pi.net/tutorial
//     by Sam Aaron, licensed under CC BY-SA 4.0
//   - Community patterns: common idioms from the Sonic Pi community
//     https://in-thread.sonic-pi.net/
//   - Adversarial patterns: written for this test suite (not from external sources)
// -----------------------------------------------------------------------

const testCases: TestCase[] = [
  // === Built-in examples (from this project's src/engine/examples.ts) ===
  {
    name: 'Hello Beep',
    shouldTranspile: true,
    code: `play 60
sleep 1
play 64
sleep 1
play 67`,
  },
  {
    name: 'Basic Beat',
    shouldTranspile: true,
    code: `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`,
  },
  {
    name: 'Ambient Pad',
    shouldTranspile: true,
    code: `use_synth :prophet
live_loop :pad do
  play chord(:e3, :minor), release: 4, amp: 0.6
  sleep 4
end`,
  },
  {
    name: 'Arpeggio with tick',
    shouldTranspile: true,
    code: `use_synth :tb303
live_loop :arp do
  play (ring 60, 64, 67, 72).tick, release: 0.2, cutoff: 80
  sleep 0.25
end`,
  },
  {
    name: 'Euclidean Rhythm',
    shouldTranspile: true,
    code: `live_loop :euclidean do
  pattern = spread(5, 8)
  8.times do |i|
    sample :bd_tek if pattern[i]
    sleep 0.25
  end
end`,
  },
  {
    name: 'Random Melody',
    shouldTranspile: true,
    code: `use_random_seed 42
live_loop :melody do
  use_synth :pluck
  play scale(:c4, :minor_pentatonic).choose, release: 0.3
  sleep 0.25
end`,
  },
  {
    name: 'Sync/Cue',
    shouldTranspile: true,
    code: `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  cue :tick
  sample :sn_dub
  sleep 0.5
end

live_loop :bass do
  sync :tick
  use_synth :tb303
  play :e2, release: 0.3, cutoff: 70
  sleep 0.5
end`,
  },
  {
    name: 'Multi-Layer',
    shouldTranspile: true,
    code: `use_bpm 120

live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :hat_snap
  sleep 0.25
  sample :hat_snap
  sleep 0.25
end

live_loop :bass do
  use_synth :tb303
  notes = ring(:e2, :e2, :g2, :a2)
  play notes.tick, release: 0.3, cutoff: 60
  sleep 1
end

live_loop :lead do
  use_synth :pluck
  play scale(:e4, :minor_pentatonic).choose, release: 0.2
  sleep 0.25
end`,
  },
  {
    name: 'FX Chain',
    shouldTranspile: true,
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
    shouldTranspile: true,
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

  // === Tutorial patterns (adapted from https://sonic-pi.net/tutorial by Sam Aaron, CC BY-SA 4.0) ===
  {
    name: 'Tutorial: single play',
    shouldTranspile: true,
    code: `play 60`,
  },
  {
    name: 'Tutorial: play with opts',
    shouldTranspile: true,
    code: `play 60, amp: 0.5, release: 2`,
  },
  {
    name: 'Tutorial: sample playback',
    shouldTranspile: true,
    code: `sample :ambi_lunar_land`,
  },
  {
    name: 'Tutorial: sample with rate',
    shouldTranspile: true,
    code: `sample :loop_amen, rate: 0.5`,
  },
  {
    name: 'Tutorial: use_synth',
    shouldTranspile: true,
    code: `use_synth :prophet
play 50
sleep 1
play 55`,
  },
  {
    name: 'Tutorial: melody sequence',
    shouldTranspile: true,
    code: `play 60
sleep 0.5
play 62
sleep 0.5
play 64
sleep 0.5
play 65
sleep 0.5
play 67`,
  },
  {
    name: 'Tutorial: basic loop',
    shouldTranspile: true,
    code: `live_loop :my_loop do
  play 60
  sleep 1
end`,
  },
  {
    name: 'Tutorial: loop with ring',
    shouldTranspile: true,
    code: `live_loop :notes do
  play (ring 60, 64, 67).tick
  sleep 0.5
end`,
  },
  {
    name: 'Tutorial: conditional play',
    shouldTranspile: true,
    code: `live_loop :rand do
  if one_in(3)
    sample :drum_heavy_kick
  end
  sleep 0.5
end`,
  },
  {
    name: 'Tutorial: scale walk',
    shouldTranspile: true,
    code: `live_loop :walk do
  use_synth :pluck
  play scale(:c4, :major).choose
  sleep 0.25
end`,
  },
  {
    name: 'Tutorial: FX reverb',
    shouldTranspile: true,
    code: `live_loop :space do
  with_fx :reverb, room: 0.9 do
    play 60
    sleep 0.5
  end
end`,
  },
  {
    name: 'Tutorial: FX echo',
    shouldTranspile: true,
    code: `live_loop :echo do
  with_fx :echo, phase: 0.25, decay: 4 do
    play scale(:e3, :minor_pentatonic).choose
    sleep 0.5
  end
end`,
  },
  {
    name: 'Tutorial: BPM change',
    shouldTranspile: true,
    code: `use_bpm 90
live_loop :fast do
  play 60
  sleep 0.25
end`,
  },
  {
    name: 'Tutorial: define function',
    shouldTranspile: true,
    code: `define :bass_hit do
  sample :bd_haus, amp: 2
end

live_loop :groove do
  bass_hit
  sleep 0.5
end`,
  },
  {
    name: 'Tutorial: N.times',
    shouldTranspile: true,
    code: `live_loop :times do
  4.times do
    play 60
    sleep 0.25
  end
  sleep 1
end`,
  },
  {
    name: 'Tutorial: N.times with index',
    shouldTranspile: true,
    code: `live_loop :climb do
  8.times do |i|
    play 60 + i
    sleep 0.125
  end
end`,
  },
  {
    name: 'Tutorial: each iteration',
    shouldTranspile: true,
    code: `live_loop :melody do
  [60, 64, 67, 72].each do |n|
    play n
    sleep 0.25
  end
end`,
  },
  {
    name: 'Tutorial: knit',
    shouldTranspile: true,
    code: `live_loop :knit do
  notes = knit(:c4, 3, :e4, 1)
  play notes.tick
  sleep 0.25
end`,
  },
  {
    name: 'Tutorial: spread pattern',
    shouldTranspile: true,
    code: `live_loop :afro do
  pattern = spread(3, 8)
  8.times do |i|
    sample :drum_cymbal_closed if pattern[i]
    sleep 0.125
  end
end`,
  },
  {
    name: 'Tutorial: density',
    shouldTranspile: false, // Known issue: parser fails on density-in-live_loop, regex fallback produces invalid JS
    code: `live_loop :dense do
  density 2 do
    play 60
    sleep 1
  end
  sleep 1
end`,
  },

  // === Community patterns (common idioms from https://in-thread.sonic-pi.net/) ===
  {
    name: 'Community: variable assignment in loop',
    shouldTranspile: true,
    code: `live_loop :vars do
  n = choose([60, 62, 64, 65, 67])
  play n, release: 0.3
  sleep 0.25
end`,
  },
  {
    name: 'Community: inline if after play',
    shouldTranspile: true,
    code: `live_loop :cond do
  sample :bd_haus if one_in(2)
  sleep 0.25
end`,
  },
  {
    name: 'Community: rrand in play',
    shouldTranspile: true,
    code: `live_loop :random_notes do
  play rrand(50, 80)
  sleep 0.25
end`,
  },
  {
    name: 'Community: chord_invert',
    shouldTranspile: true,
    code: `live_loop :inversions do
  play chord_invert(chord(:c4, :major), 1)
  sleep 1
end`,
  },
  {
    name: 'Community: note_range',
    shouldTranspile: true,
    code: `live_loop :range do
  play note_range(:c3, :c5).choose
  sleep 0.5
end`,
  },
  {
    name: 'Community: multiple synths',
    shouldTranspile: true,
    code: `live_loop :multi do
  use_synth :saw
  play 50, release: 0.1
  sleep 0.5
  use_synth :prophet
  play 60, release: 0.2
  sleep 0.5
end`,
  },
  {
    name: 'Community: puts debug output',
    shouldTranspile: true,
    code: `live_loop :debug do
  n = rrand_i(50, 80)
  puts n
  play n
  sleep 0.5
end`,
  },
  {
    name: 'Community: control with slide',
    shouldTranspile: true,
    code: `live_loop :slide do
  s = play 60, release: 4, note_slide: 1
  sleep 1
  control s, note: 65
  sleep 3
end`,
  },
  {
    name: 'Community: unless conditional',
    shouldTranspile: true,
    code: `live_loop :unless_test do
  sample :bd_haus unless one_in(4)
  sleep 0.5
end`,
  },
  {
    name: 'Community: begin/rescue',
    shouldTranspile: true,
    code: `live_loop :safe do
  begin
    play 60
    sleep 0.5
  rescue
    sleep 1
  end
end`,
  },

  // === Real-world community pieces (fetched from original sources with attribution) ===
  // These stress-test advanced features: define with patterns, uncomment blocks,
  // factor?(), play_pattern_timed, bools(), osc_send, delay: on live_loops,
  // reps: on FX, .to_sym, array slicing, deeply nested FX

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/algomancer/blockgame.rb
  {
    name: 'Blockgame — by DJ_Dave',
    shouldTranspile: false, // Uses define :pattern with return, ##| comments, pattern.ring.tick
    code: `use_bpm 130

live_loop :met1 do
  sleep 1
end

cmaster1 = 130
cmaster2 = 130

define :pattern do |pattern|
  return pattern.ring.tick == "x"
end

live_loop :kick, sync: :met1 do
  a = 1.5
  sample :bd_tek, amp: a, cutoff: cmaster1 if pattern "x--x--x---x--x--"
  sleep 0.25
end

with_fx :echo, mix: 0.2 do
  with_fx :reverb, mix: 0.2, room: 0.5 do
    live_loop :clap, sync: :met1 do
      a = 0.75
      sleep 1
      sample :drum_snare_hard, rate: 2.5, cutoff: cmaster1, amp: a
      sample :drum_snare_hard, rate: 2.2, start: 0.02, cutoff: cmaster1, pan: 0.2, amp: a
      sample :drum_snare_hard, rate: 2, start: 0.04, cutoff: cmaster1, pan: -0.2, amp: a
      sleep 1
    end
  end
end

with_fx :reverb, mix: 0.7 do
  live_loop :arp, sync: :met1 do
    with_fx :echo, phase: 1, mix: (line 0.1, 1, steps: 128).mirror.tick do
      a = 0.6
      use_synth :beep
      tick
      notes = (scale :g4, :major_pentatonic).shuffle
      play notes.look, amp: a, release: 0.25, cutoff: 130, pan: (line -0.7, 0.7, steps: 64).mirror.tick, attack: 0.01
      sleep 0.75
    end
  end
end

with_fx :panslicer, mix: 0.4 do
  with_fx :reverb, mix: 0.75 do
    live_loop :synthbass, sync: :met1 do
      use_synth :tech_saws
      play :g3, sustain: 6, cutoff: 60, amp: 0.75
      sleep 6
      play :d3, sustain: 2, cutoff: 60, amp: 0.75
      sleep 2
      play :e3, sustain: 8, cutoff: 60, amp: 0.75
      sleep 8
    end
  end
end`,
  },

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/algomancer/sonic_dreams.rb
  {
    name: 'Sonic Dreams (excerpt) — by Sam Aaron',
    shouldTranspile: false, // Uses define with default params, uncomment do, control, .rotate!.first
    code: `use_debug false

define :ocean do |num, amp_mul=1|
  num.times do
    s = synth [:bnoise, :cnoise, :gnoise].choose, amp: rrand(0.5, 1.5) * amp_mul, attack: rrand(0, 1), sustain: rrand(0, 2), release: rrand(0, 5) + 0.5, cutoff_slide: rrand(0, 5), cutoff: rrand(60, 100), pan: rrand(-1, 1), pan_slide: 1
    control s, pan: rrand(-1, 1), cutoff: rrand(60, 110)
    sleep rrand(0.5, 4)
  end
end

define :echoes do |num, tonics, co=100, res=0.9, amp=1|
  num.times do
    play chord(tonics.choose, :minor).choose, res: res, cutoff: rrand(co - 20, co + 20), amp: 0.5 * amp, attack: 0, release: rrand(0.5, 1.5), pan: rrand(-0.7, 0.7)
    sleep [0.25, 0.5, 0.5, 0.5, 1, 1].choose
  end
end

define :bd do
  cue :in_relentless_cycles
  16.times do
    sample :bd_haus, amp: 4, cutoff: 100
    sleep 0.5
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
          ocean 1, 0.25
        end
        sleep 10
      end
    end
  end
end`,
  },

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/algomancer/cloud_beat.rb
  {
    name: 'Cloud Beat (excerpt) — by SonicPit',
    shouldTranspile: false, // Uses define with default params, bools(), chord :es4, delay: on live_loop, .pick()
    code: `use_bpm 100

live_loop :hiss_loop do
  sample :vinyl_hiss, amp: 2
  sleep sample_duration :vinyl_hiss
end

define :hihat do
  use_synth :pnoise
  with_fx :hpf, cutoff: 120 do
    play release: 0.01, amp: 13
  end
end

live_loop :hihat_loop do
  divisors = ring 2, 4, 2, 2, 2, 2, 2, 6
  divisors.tick.times do
    hihat
    sleep 1.0 / divisors.look
  end
end

live_loop :snare_loop do
  sleep ring(2.5, 3)[tick]
  with_fx :lpf, cutoff: 100 do
    sample :sn_dub, sustain: 0, release: 0.05, amp: 3
  end
  sleep ring(1.5, 1)[look]
end

define :bassdrum do |note1, duration, note2 = note1|
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
  if bools(0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0)[tick]
    bassdrum 36, 0.5, 40
    bassdrum 38, 1, 10
  else
    bassdrum 36, 1.5
  end
  bassdrum 36, 1.0, ring(10, 10, 10, 40)[look]
end

chord_high = chord :c4, :maj9, num_octaves: 2

live_loop :chord_selector, delay: -0.5 do
  chord_high = (knit(chord(:c4, :maj9, num_octaves: 2), 2, chord(:es4, :maj9, num_octaves: 2), 2)).tick
  sleep 8
end`,
  },

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/wizard/tilburg_2.rb
  {
    name: 'Tilburg 2 — by Sam Aaron',
    shouldTranspile: false, // Fails: use_debug false, load_samples multi-arg, .take(4) unsupported
    code: `use_debug false
load_samples :guit_em9, :bd_haus

live_loop :low do
  tick
  synth :zawa, wave: 1, phase: 0.25, release: 5, note: (knit :e1, 12, :c1, 4).look, cutoff: (line 60, 120, steps: 6).look
  sleep 4
end

with_fx :reverb, room: 1 do
  live_loop :lands, auto_cue: false do
    use_synth :dsaw
    use_random_seed 310003
    ns = (scale :e2, :minor_pentatonic, num_octaves: 4).take(4)
    16.times do
      play ns.choose, detune: 12, release: 0.1, amp: 2, cutoff: rrand(70, 120)
      sleep 0.125
    end
  end
end

live_loop :fietsen do
  sleep 0.25
  sample :guit_em9, rate: -1
  sleep 7.75
end

live_loop :tijd do
  sample :bd_haus, amp: 2.5, cutoff: 100
  sleep 0.5
end

live_loop :ind do
  sample :loop_industrial, beat_stretch: 1
  sleep 1
end`,
  },

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/wizard/shufflit.rb
  {
    name: 'Shufflit — by Sam Aaron',
    shouldTranspile: false, // Uses factor?(), reps: on FX, tick_reset_all, range with step:
    code: `use_debug false
use_random_seed 667
load_sample :ambi_lunar_land
sleep 1

live_loop :travelling do
  use_synth :beep
  notes = scale(:e3, :minor_pentatonic, num_octaves: 1)
  use_random_seed 679
  tick_reset_all
  with_fx :echo, phase: 0.125, mix: 0.4, reps: 16 do
    sleep 0.25
    play notes.choose, attack: 0, release: 0.1, pan: (range -1, 1, step: 0.125).tick, amp: rrand(2, 2.5)
  end
end

live_loop :comet, auto_cue: false do
  if one_in 4
    sample :ambi_lunar_land
    puts :comet_landing
  end
  sleep 8
end

live_loop :shuff, auto_cue: false do
  with_fx :hpf, cutoff: 10, reps: 8 do
    tick
    sleep 0.25
    sample :bd_tek, amp: factor?(look, 8) ? 6 : 4
    sleep 0.25
    use_synth :tb303
    use_synth_defaults cutoff_attack: 1, cutoff_release: 0, env_curve: 2
    play (knit :e2, 24, :c2, 8).look, release: 1.5, cutoff: (range 70, 90).look, amp: 2 if factor?(look, 2)
    sample :sn_dub, rate: -1, sustain: 0, release: (knit 0.05, 3, 0.5, 1).look
  end
end`,
  },

  // Source: https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/dev/etc/examples/wizard/blimp_zones.rb
  {
    name: 'Blimp Zones — by Sam Aaron',
    shouldTranspile: false, // Uses factor?(), cue with key: value, rrand with res:, :m7 chord type
    code: `use_debug false
use_random_seed 667
load_sample :ambi_lunar_land
sleep 1

live_loop :foo do
  with_fx :reverb, kill_delay: 0.2, room: 0.3 do
    4.times do
      use_random_seed 4000
      8.times do
        sleep 0.25
        play chord(:e3, :m7).choose, release: 0.1, pan: rrand(-1, 1), amp: 1
      end
    end
  end
end

live_loop :bar, auto_cue: false do
  if rand < 0.25
    sample :ambi_lunar_land
    puts :comet_landing
  end
  sleep 8
end

live_loop :baz, auto_cue: false do
  tick
  sleep 0.25
  cue :beat, count: look
  sample :bd_haus, amp: factor?(look, 8) ? 3 : 2
  sleep 0.25
  use_synth :fm
  play :e2, release: 1, amp: 1 if factor?(look, 4)
  synth :noise, release: 0.051, amp: 0.5
end`,
  },

  // Source: https://raw.githubusercontent.com/dorchard/fibonacci_crisis/master/unsquare-pi.rb
  {
    name: 'Unsquare Pi — by Dominic Orchard',
    shouldTranspile: false, // Uses define with complex body, in_thread, case/when with symbols, array slicing [1..-1], with_synth
    code: `define :sequence do |xs,tp|
  xs.each do |ys|
    in_thread do
      if (ys[0] == :zawa || ys[0] == :tb303 || ys[0] == :pulse) then
        synth = ys[0]
        zs = ys[1..-1]
      else
        synth = :tri
        zs = ys
      end
      with_synth synth do
        zs.each do |y|
          case y
          when :r
          when :cs
            sample :drum_cymbal_soft
          when :bh
            sample :drum_bass_hard
          when :sh
            sample :drum_snare_hard
          when :ss
            sample :drum_snare_soft
          else
            play y, release: (1.5 * (tp / zs.length))
          end
          sleep (tp / zs.length)
        end
      end
    end
  end
  sleep tp
end

define :main do
  [0,0,5,0,7,0].each do |x|
    use_transpose x
    bass  = [:a2,:r ,:g2,:r ,:a2,:r ,:r]
    with_fx :reverb, level: 1.0, mix: 0.6 do
      drums = [:bs,:cc,:bs,:cc,:bs,:cc,:cc]
      snare = [:r ,:r ,:r ,:r ,:r ,:ss,:ss]
      piano = [:b4,:r,:r,:b4,:r,:r,:g4,:a4,:g4,:e4,
               :r,:r,:d4,:e4,:r,:r,:d4,:e4,:r,:r]
      sequence [bass,bass,snare,snare,piano,piano,drums,drums], 2.0
    end
  end
end

in_thread(name: :dx) do
  loop{main}
end`,
  },

  // Source: https://raw.githubusercontent.com/dorchard/fibonacci_crisis/master/gothia.rb
  {
    name: 'Gothia (excerpt) — by Dominic Orchard',
    shouldTranspile: false, // Uses play_pattern_timed, sync/cue threading, (note x) - 12 arithmetic, in_thread(name:)
    code: `define :tp do
  tp = 0.5
end

x = 0

define :transp do
  x = ((x + 1) % 4) * 2
  use_transpose x
end

mode = 0

define :arpeg do
  transp
  sync :tick
  [:Fs4, :Gs4, :As4, :Gs4].each do |x|
    with_synth :tb303 do
      with_fx :reverb, level: 0.1, amp: 0.3, release: 0.2 do
        if mode == 0
          2.times do
            play_pattern_timed [:B3,:Ds4,x,:Ds4], [tp*(4/7.0)]
          end
        elsif mode == 1
          2.times do
            play_pattern_timed [:B3,:Ds4,x,:Ds4], [0]
            sleep tp*2
          end
        end
      end
    end
  end
end

define :ticker do
  cue :tick
  sleep tp/2.0
end

define :drums2 do
  sync :tick
  sleep tp/3.0
  sample :drum_tom_lo_soft, level: 0.5
  sleep tp*(2/3.0)
end

in_thread(name: :a) do
  loop{arpeg}
end

in_thread(name: :tickert) do
  loop{ticker}
end

in_thread(name: :drumst2) do
  loop{drums2}
end`,
  },

  // Source: https://gist.githubusercontent.com/rbnpi/d8deebff4669436bd3b00df30b9aefcf/raw
  {
    name: 'Automated Parameter Control (excerpt) — by Robin Newman',
    shouldTranspile: false, // Uses osc_send, .to_sym, set/get, at with arrays, control with dynamic opts, string concatenation
    code: `use_random_seed 886543
set :kill,false
set :finishTime,120

define :fadeSteps do |start, finish, len, type|
  case type
  when :fade
    b = (line start, finish, steps: len, inclusive: true).stretch(2).drop(1).butlast.ramp
  when :wave
    b = (line start, finish, steps: len, inclusive: true).stretch(2).drop(1).butlast.mirror
  end
  return b
end

define :fxname do |pointer|
  case pointer
  when :lv1
    return ":level (rhythm) :amp"
  when :lv2
    return ":reverb :mix"
  when :lv3
    return ":echo :mix"
  end
end

define :fadeControl do |start,finish,duration,type,pointer,opt|
  return if start==finish
  l=fadeSteps start,finish,11,type
  if type==:wave
    dt=duration/40.0
  else
    dt=duration/20.0
  end
  in_thread do
    tick_reset
    l.length.times do
      control get(pointer),opt=> l.tick,(opt.to_s+"_slide").to_sym => dt
      sleep dt
    end
  end
end

osc_send "localhost",4557,"/stop-all-jobs","rbnguid"

with_fx :reverb,room: 0.8,mix: 0 do |lv2|
  set :lv2,lv2
  with_fx :echo,phase: 0.5,mix: 0 do |lv3|
    set :lv3,lv3
    with_fx :level,amp: 0 do |lv1|
      set :lv1,lv1
      live_loop :beatlevel,delay: 20 do
        sample :loop_breakbeat, beat_stretch: 4
        sleep 4
      end
    end
  end
end`,
  },

  // Source: https://sonic-pi.mehackit.org/exercises/en/11-templates/05-hip-hop-beat.html
  {
    name: 'Hip Hop Beat — by Mehackit',
    shouldTranspile: false, // Fails: use_synth_defaults with multiple opts produces invalid JS
    code: `use_bpm 90

live_loop :biitti do
  sample :bd_808, rate: 1, amp: 4
  sleep 1
  sample :elec_hi_snare, amp: 1
  sleep 1
  sample :bd_808, rate: 1, amp: 4
  sleep 1
  sample :elec_hi_snare, amp: 1
  sleep 1
end

live_loop :luuppi do
  sample :loop_breakbeat, beat_stretch: 4
  sleep 4
end

live_loop :kitaramelodia do
  sample :guit_e_fifths, rate: 0.5, amp: 1.5
  sample :guit_e_fifths, rate: 1, amp: 0.8
  sleep 1.5
  sample :guit_e_fifths, rate: 1.5, amp: 0.8
  sleep 1.5
  sample :guit_e_fifths, rate: 1.4, amp: 0.8
  sleep 3
  sample :guit_e_slide, rate: 1, amp: 0.8
  sleep 2
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
  4.times do
    sample :drum_cymbal_pedal, start: 0.05, finish: 0.6, rate: 3, amp: 0.5 + rrand(-0.1, 0.1)
    sleep 0.25
  end
  16.times do
    sample :drum_cymbal_pedal, start: 0.1, finish: 0.3, rate: 3, amp: 0.5 + rrand(-0.1, 0.1)
    sleep 0.0625
  end
end`,
  },

  // === Adversarial patterns (written for this test suite, not from external sources) ===
  {
    name: 'Adversarial: empty live_loop',
    shouldTranspile: true,
    code: `live_loop :empty do
  sleep 1
end`,
  },
  {
    name: 'Adversarial: deeply nested FX',
    shouldTranspile: true,
    code: `live_loop :deep do
  with_fx :reverb do
    with_fx :echo do
      with_fx :distortion do
        play 60
        sleep 1
      end
    end
  end
end`,
  },
  {
    name: 'Adversarial: comment-only code',
    shouldTranspile: true,
    code: `# This is just a comment
# Nothing else
live_loop :comments do
  # play something
  play 60
  sleep 1
end`,
  },
  {
    name: 'Adversarial: inline comment',
    shouldTranspile: true,
    code: `live_loop :inline do
  play 60 # this is middle C
  sleep 1 # one beat
end`,
  },
  {
    name: 'Adversarial: string interpolation',
    shouldTranspile: true,
    code: `live_loop :interp do
  n = 60
  puts "playing #{n}"
  play n
  sleep 1
end`,
  },
  {
    name: 'Adversarial: case/when',
    shouldTranspile: true,
    code: `live_loop :case_test do
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
end`,
  },
  {
    name: 'Adversarial: very long single line',
    shouldTranspile: true,
    code: `live_loop :longline do
  play scale(:c4, :minor_pentatonic).choose, release: 0.3, amp: 0.8, cutoff: rrand(60, 120), res: 0.2, attack: 0.01
  sleep 0.25
end`,
  },
  {
    name: 'Adversarial: no live_loop (bare code only)',
    shouldTranspile: true,
    code: `play 60
sleep 0.5
play 64
sleep 0.5
play 67
sleep 0.5`,
  },
  {
    name: 'Adversarial: if/elsif/else chain',
    shouldTranspile: true,
    code: `live_loop :branch do
  x = rrand_i(1, 10)
  if x < 3
    play 60
  elsif x < 6
    play 64
  else
    play 67
  end
  sleep 0.5
end`,
  },
  {
    name: 'Adversarial: loop do (infinite)',
    shouldTranspile: true,
    code: `live_loop :inf do
  loop do
    play 60
    sleep 0.5
  end
end`,
  },
  {
    name: 'Adversarial: live_loop with sync option',
    shouldTranspile: true,
    code: `live_loop :leader do
  cue :go
  play 60
  sleep 1
end

live_loop :follower, sync: :leader do
  play 72
  sleep 1
end`,
  },
  {
    name: 'Adversarial: shuffle and pick',
    shouldTranspile: true,
    code: `live_loop :shuffle do
  notes = (ring 60, 62, 64, 65, 67)
  play notes.shuffle.tick
  sleep 0.25
end`,
  },
]

// -----------------------------------------------------------------------
// Test runner
// -----------------------------------------------------------------------

describe('Real-world Sonic Pi compatibility matrix', () => {
  const results: { name: string; transpiled: boolean; validJs: boolean; error?: string }[] = []

  for (const tc of testCases) {
    it(`${tc.name}`, () => {
      let transpiled = false
      let validJs = false
      let error: string | undefined

      try {
        const result = autoTranspile(tc.code)
        transpiled = true

        // Validate the transpiled code is valid JS
        try {
          new Function(result)
          validJs = true
        } catch (e) {
          error = `Invalid JS: ${(e as Error).message}`
        }
      } catch (e) {
        error = `Transpile failed: ${(e as Error).message}`
      }

      results.push({ name: tc.name, transpiled, validJs, error })

      if (tc.shouldTranspile) {
        expect(transpiled).toBe(true)
        expect(validJs).toBe(true)
      }
    })
  }

  it('compatibility summary: at least 80% transpile successfully', () => {
    const total = results.length
    const passing = results.filter(r => r.transpiled && r.validJs).length
    const pct = (passing / total) * 100

    // Log summary
    console.log(`\n=== Compatibility Matrix ===`)
    console.log(`${passing}/${total} programs transpile successfully (${pct.toFixed(0)}%)`)
    const failures = results.filter(r => !r.transpiled || !r.validJs)
    if (failures.length > 0) {
      console.log(`\nFailures:`)
      for (const f of failures) {
        console.log(`  - ${f.name}: ${f.error}`)
      }
    }

    expect(pct).toBeGreaterThanOrEqual(80)
  })
})

// -----------------------------------------------------------------------
// Tree-sitter compatibility matrix
// -----------------------------------------------------------------------

describe('Tree-sitter compatibility matrix', () => {
  const base = new URL('../../..', import.meta.url).pathname
  const tsWasm = base + 'node_modules/web-tree-sitter/tree-sitter.wasm'
  const rubyWasm = base + 'node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm'

  beforeAll(async () => {
    await initTreeSitter({ treeSitterWasmUrl: tsWasm, rubyWasmUrl: rubyWasm })
  })

  const results: { name: string; ok: boolean; error?: string }[] = []

  for (const tc of testCases) {
    it(`[tree-sitter] ${tc.name}`, () => {
      if (!isTreeSitterReady()) {
        results.push({ name: tc.name, ok: false, error: 'tree-sitter not ready' })
        return
      }

      const result = treeSitterTranspile(tc.code)
      results.push({
        name: tc.name,
        ok: result.ok,
        error: result.ok ? undefined : result.errors[0],
      })

      // All programs that the regex transpiler handles should also work with tree-sitter
      if (tc.shouldTranspile) {
        expect(result.ok).toBe(true)
      }
    })
  }

  it('tree-sitter compatibility summary: at least 90% transpile successfully', () => {
    const total = results.length
    const passing = results.filter(r => r.ok).length
    const pct = (passing / total) * 100

    console.log(`\n=== Tree-sitter Compatibility Matrix ===`)
    console.log(`${passing}/${total} programs transpile successfully (${pct.toFixed(0)}%)`)
    const failures = results.filter(r => !r.ok)
    if (failures.length > 0) {
      console.log(`\nTree-sitter failures:`)
      for (const f of failures) {
        console.log(`  - ${f.name}: ${f.error}`)
      }
    }

    expect(pct).toBeGreaterThanOrEqual(90)
  })
})
