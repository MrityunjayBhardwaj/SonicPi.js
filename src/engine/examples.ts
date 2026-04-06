/**
 * Example gallery — classic Sonic Pi patterns in both Ruby DSL and JS DSL.
 *
 * Each example has: name, description, Ruby code (for the transpiler),
 * and JS code (native DSL). Both should produce identical output.
 */

export type Difficulty = 'beginner' | 'intermediate' | 'advanced'

export interface Example {
  name: string
  description: string
  difficulty: Difficulty
  ruby: string
  js: string
}

export const examples: Example[] = [
  {
    name: 'Hello Beep',
    difficulty: 'beginner',
    description: 'The simplest possible Sonic Pi program — one note.',
    ruby: `\
play 60
sleep 1
play 64
sleep 1
play 67`,
    js: `\
live_loop("hello", async ({play, sleep}) => {
  await play(60)
  await sleep(1)
  await play(64)
  await sleep(1)
  await play(67)
  await sleep(1)
})`,
  },

  {
    name: 'Basic Beat',
    difficulty: 'beginner',
    description: 'A four-on-the-floor drum pattern with kick and snare.',
    ruby: `\
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`,
    js: `\
live_loop("drums", async ({sample, sleep}) => {
  await sample("bd_haus")
  await sleep(0.5)
  await sample("sn_dub")
  await sleep(0.5)
})`,
  },

  {
    name: 'Ambient Pad',
    difficulty: 'beginner',
    description: 'Slow chord washes with reverb — ambient music in 6 lines.',
    ruby: `\
use_synth :prophet
live_loop :pad do
  play chord(:e3, :minor), release: 4, amp: 0.6
  sleep 4
end`,
    js: `\
live_loop("pad", async ({play, sleep, use_synth, chord}) => {
  use_synth("prophet")
  const notes = chord("e3", "minor")
  for (const n of notes) {
    await play(n, {release: 4, amp: 0.6})
  }
  await sleep(4)
})`,
  },

  {
    name: 'Arpeggio',
    difficulty: 'intermediate',
    description: 'A rising arpeggio using ring and tick — Sonic Pi\'s signature pattern.',
    ruby: `\
use_synth :tb303
live_loop :arp do
  play (ring 60, 64, 67, 72).tick, release: 0.2, cutoff: 80
  sleep 0.25
end`,
    js: `\
live_loop("arp", async ({play, sleep, use_synth, ring, tick}) => {
  use_synth("tb303")
  const notes = ring(60, 64, 67, 72)
  await play(notes[tick()], {release: 0.2, cutoff: 80})
  await sleep(0.25)
})`,
  },

  {
    name: 'Euclidean Rhythm',
    difficulty: 'intermediate',
    description: 'Euclidean rhythms — spread hits evenly across steps.',
    ruby: `\
live_loop :euclidean do
  pattern = spread(5, 8)
  8.times do |i|
    sample :bd_tek if pattern[i]
    sleep 0.25
  end
end`,
    js: `\
live_loop("euclidean", async ({sample, sleep, spread}) => {
  const pattern = spread(5, 8)
  for (let i = 0; i < 8; i++) {
    if (pattern[i]) await sample("bd_tek")
    await sleep(0.25)
  }
})`,
  },

  {
    name: 'Random Melody',
    difficulty: 'intermediate',
    description: 'Seeded random melody — deterministic but unpredictable.',
    ruby: `\
use_random_seed 42
live_loop :melody do
  use_synth :pluck
  play scale(:c4, :minor_pentatonic).choose, release: 0.3
  sleep 0.25
end`,
    js: `\
live_loop("melody", async ({play, sleep, use_synth, use_random_seed, scale, choose}) => {
  use_random_seed(42)
  use_synth("pluck")
  const notes = scale("c4", "minor_pentatonic")
  await play(choose(notes), {release: 0.3})
  await sleep(0.25)
})`,
  },

  {
    name: 'Sync/Cue',
    difficulty: 'intermediate',
    description: 'Two loops synchronized — the bass waits for the drums.',
    ruby: `\
live_loop :drums do
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
    js: `\
live_loop("drums", async ({sample, sleep, cue}) => {
  await sample("bd_haus")
  await sleep(0.5)
  cue("tick")
  await sample("sn_dub")
  await sleep(0.5)
})

live_loop("bass", async ({play, sleep, sync, use_synth}) => {
  await sync("tick")
  use_synth("tb303")
  await play("e2", {release: 0.3, cutoff: 70})
  await sleep(0.5)
})`,
  },

  {
    name: 'Multi-Layer',
    difficulty: 'intermediate',
    description: 'Three simultaneous loops — drums, bass, and lead.',
    ruby: `\
use_bpm 120

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
    js: `\
live_loop("drums", async ({sample, sleep, use_bpm}) => {
  use_bpm(120)
  await sample("bd_haus")
  await sleep(0.5)
  await sample("hat_snap")
  await sleep(0.25)
  await sample("hat_snap")
  await sleep(0.25)
})

live_loop("bass", async ({play, sleep, use_synth, use_bpm, ring, tick}) => {
  use_bpm(120)
  use_synth("tb303")
  const notes = ring("e2", "e2", "g2", "a2")
  await play(notes[tick()], {release: 0.3, cutoff: 60})
  await sleep(1)
})

live_loop("lead", async ({play, sleep, use_synth, use_bpm, scale, choose}) => {
  use_bpm(120)
  use_synth("pluck")
  const notes = scale("e4", "minor_pentatonic")
  await play(choose(notes), {release: 0.2})
  await sleep(0.25)
})`,
  },

  {
    name: 'FX Chain',
    difficulty: 'intermediate',
    description: 'Nested effects — reverb wrapping distortion.',
    ruby: `\
live_loop :fx_demo do
  with_fx :reverb, room: 0.8 do
    with_fx :distortion, distort: 0.5 do
      play 50, release: 0.5
      sleep 0.5
      play 55, release: 0.5
      sleep 0.5
    end
  end
end`,
    js: `\
live_loop("fx_demo", async (ctx) => {
  await ctx.with_fx("reverb", {room: 0.8}, async (rv) => {
    await rv.with_fx("distortion", {distort: 0.5}, async (dist) => {
      await dist.play(50, {release: 0.5})
      await dist.sleep(0.5)
      await dist.play(55, {release: 0.5})
      await dist.sleep(0.5)
    })
  })
})`,
  },

  {
    name: 'Minimal Techno',
    difficulty: 'intermediate',
    description: 'A stripped-down techno loop with Euclidean hi-hats.',
    ruby: `\
use_bpm 130

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
    js: `\
live_loop("kick", async ({sample, sleep, use_bpm}) => {
  use_bpm(130)
  await sample("bd_haus", {amp: 1.5})
  await sleep(1)
})

live_loop("hats", async ({sample, sleep, use_bpm, spread}) => {
  use_bpm(130)
  const pattern = spread(7, 16)
  for (let i = 0; i < 16; i++) {
    if (pattern[i]) await sample("hat_snap", {amp: 0.4})
    await sleep(0.25)
  }
})

live_loop("acid", async ({play, sleep, use_synth, use_bpm, ring, tick, rrand}) => {
  use_bpm(130)
  use_synth("tb303")
  const notes = ring("e2", "e2", "e3", "e2", "g2", "e2", "a2", "e2")
  await play(notes[tick()], {release: 0.2, cutoff: rrand(40, 120), res: 0.3})
  await sleep(0.25)
})`,
  },
  // ========================================================================
  // Advanced — Original compositions (community-style Sonic Pi pieces)
  // ========================================================================

  {
    name: 'Midnight Drive',
    difficulty: 'advanced',
    description: 'Synthwave/retrowave — lush saw pads, arpeggiated lead, punchy drums, 80s feel.',
    ruby: `\
# "Midnight Drive" — Synthwave
# Inspired by the Sonic Pi community
# Technique: layered supersaws, gated arpeggios, retro drum programming

use_bpm 110

live_loop :director do
  set :section, 0  # intro: pad + slow arp
  sleep 32
  set :section, 1  # verse: drums enter, bass joins
  sleep 32
  set :section, 2  # chorus: full energy, lead soars
  sleep 48
  set :section, 3  # breakdown: strip to pad + arp
  sleep 16
  set :section, 4  # outro: fade all
  sleep 16
  stop
end

live_loop :pad do
  s = get[:section]
  use_synth :supersaw
  vol = 0
  vol = 0.3 if s == 0 or s == 3
  vol = 0.25 if s == 1
  vol = 0.4 if s == 2
  vol = 0.15 if s == 4
  with_fx :reverb, room: 0.85, mix: 0.6 do
    with_fx :lpf, cutoff: 85 do
      chords = [chord(:e3, :minor7), chord(:c3, :major7),
                chord(:a2, :minor7), chord(:b2, :minor)]
      play chords.tick, attack: 2, release: 6, amp: vol
      sleep 4
    end
  end
end

live_loop :arp do
  s = get[:section]
  use_synth :saw
  vol = 0
  vol = 0.2 if s == 0 or s == 3
  vol = 0.3 if s == 1
  vol = 0.4 if s == 2
  vol = 0.1 if s == 4
  notes = ring(:e4, :g4, :b4, :e5, :b4, :g4, :d5, :b4)
  with_fx :echo, phase: 0.375, decay: 4, mix: 0.35 do
    play notes.tick, release: 0.15, amp: vol, cutoff: 95
    sleep 0.25
  end
end

live_loop :bass do
  s = get[:section]
  use_synth :tb303
  vol = 0
  vol = 0.5 if s == 1
  vol = 0.7 if s == 2
  vol = 0.3 if s == 4
  notes = ring(:e2, :e2, :c2, :c2, :a1, :a1, :b1, :b1)
  play notes.tick, release: 0.3, cutoff: 70, res: 0.3, amp: vol
  sleep 0.5
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 1.5 if s == 1
  vol = 2.0 if s == 2
  vol = 0.8 if s == 4
  sample :bd_haus, amp: vol
  sleep 1
end

live_loop :snare do
  s = get[:section]
  vol = 0
  vol = 0.8 if s == 1
  vol = 1.2 if s == 2
  sleep 1
  sample :sn_dub, amp: vol
  sleep 1
end

live_loop :hats do
  s = get[:section]
  vol = 0
  vol = rrand(0.2, 0.5) if s == 1 or s == 2
  sample :drum_cymbal_closed, amp: vol
  sleep 0.25
end

live_loop :lead do
  s = get[:section]
  use_synth :saw
  vol = 0
  vol = 0.35 if s == 2
  notes = [:e5, :d5, :b4, :g4, :a4, :b4, :d5, :e5,
           :g5, :e5, :d5, :b4, :a4, :g4, :a4, :b4]
  with_fx :reverb, room: 0.7 do
    with_fx :flanger, phase: 2, mix: 0.3 do
      play notes.tick, release: 0.4, amp: vol, cutoff: 105
      sleep 0.5
    end
  end
end`,
    js: '',
  },

  {
    name: 'Rainforest',
    difficulty: 'advanced',
    description: 'Ambient/generative — layered nature textures, random plucks, evolving pad, no drums.',
    ruby: `\
# "Rainforest" — Ambient / Generative
# Inspired by the Sonic Pi community
# Technique: rrand for organic randomness, layered textures, no fixed rhythm

use_bpm 70

live_loop :director do
  set :section, 0  # dawn: quiet pad emerges
  sleep 32
  set :section, 1  # morning: bird plucks begin
  sleep 48
  set :section, 2  # midday: full canopy, all layers
  sleep 64
  set :section, 3  # dusk: thin out, slower
  sleep 32
  set :section, 4  # night: fade to silence
  sleep 16
  stop
end

live_loop :canopy_pad do
  s = get[:section]
  use_synth :dark_ambience
  vol = 0
  vol = 0.2 if s == 0
  vol = 0.3 if s == 1
  vol = 0.4 if s == 2
  vol = 0.25 if s == 3
  vol = 0.1 if s == 4
  with_fx :reverb, room: 0.95, mix: 0.8 do
    notes = [chord(:e3, :minor7), chord(:g3, :major7),
             chord(:a3, :minor), chord(:d3, :sus4)]
    play notes.choose, attack: 4, release: 8, amp: vol, cutoff: rrand(60, 80)
    sleep rrand(6, 10)
  end
end

live_loop :bird_plucks do
  s = get[:section]
  use_synth :pluck
  vol = 0
  vol = 0.25 if s == 1
  vol = 0.4 if s == 2
  vol = 0.2 if s == 3
  with_fx :echo, phase: rrand(0.2, 0.5), decay: 3, mix: 0.4 do
    with_fx :reverb, room: 0.8 do
      notes = scale(:e5, :minor_pentatonic, num_octaves: 2)
      play notes.choose, release: rrand(0.1, 0.4), amp: vol
    end
  end
  sleep rrand(0.3, 1.5)
end

live_loop :water_drops do
  s = get[:section]
  use_synth :sine
  vol = 0
  vol = 0.15 if s == 1 or s == 3
  vol = 0.25 if s == 2
  with_fx :reverb, room: 0.9 do
    play rrand_i(72, 96), release: rrand(0.05, 0.2), amp: vol
  end
  sleep rrand(0.5, 3.0)
end

live_loop :wind do
  s = get[:section]
  use_synth :cnoise
  vol = 0
  vol = 0.03 if s == 0 or s == 4
  vol = 0.04 if s == 1 or s == 3
  vol = 0.06 if s == 2
  with_fx :lpf, cutoff: rrand(50, 70) do
    play :c4, release: rrand(3, 6), amp: vol
  end
  sleep rrand(4, 8)
end

live_loop :deep_pulse do
  s = get[:section]
  use_synth :sine
  vol = 0
  vol = 0.2 if s == 2
  vol = 0.15 if s == 1 or s == 3
  with_fx :reverb, room: 0.9 do
    play [:e2, :g2, :a2, :d2].choose, attack: 2, release: 6, amp: vol
  end
  sleep rrand(6, 12)
end

live_loop :insects do
  s = get[:section]
  use_synth :square
  vol = 0
  vol = 0.05 if s == 2
  vol = 0.03 if s == 3
  with_fx :hpf, cutoff: 100 do
    play rrand_i(90, 110), release: rrand(0.02, 0.08), amp: vol if one_in(3)
  end
  sleep rrand(0.1, 0.4)
end`,
    js: '',
  },

  {
    name: 'Concrete Jungle',
    difficulty: 'advanced',
    description: 'Drum & Bass — fast breakbeat patterns, deep reese bass, chopped hats.',
    ruby: `\
# "Concrete Jungle" — Drum & Bass
# Inspired by the Sonic Pi community
# Technique: fast breakbeats, reese bass with wobble, chopped hat patterns

use_bpm 174

live_loop :director do
  set :section, 0  # intro: hats + sparse kick
  sleep 32
  set :section, 1  # build: bass enters, drums fill
  sleep 32
  set :section, 2  # drop: full breakbeat + reese
  sleep 64
  set :section, 3  # breakdown: half-time, pad
  sleep 16
  set :section, 4  # drop 2: full, more chopped
  sleep 64
  stop
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 0.8 if s == 0
  vol = 1.5 if s == 1
  vol = 2.5 if s == 2 or s == 4
  vol = 1.0 if s == 3
  pattern = spread(3, 8)
  sample :bd_tek, amp: vol if pattern.tick
  sleep 0.25
end

live_loop :snare do
  s = get[:section]
  vol = 0
  vol = 0.6 if s == 1
  vol = 1.5 if s == 2 or s == 4
  vol = 0.8 if s == 3
  sleep 1
  sample :sn_dub, amp: vol
  sleep 1
end

live_loop :hats do
  s = get[:section]
  vol = 0
  vol = rrand(0.2, 0.5) if s == 0 or s == 1
  vol = rrand(0.3, 0.7) if s == 2 or s == 4
  vol = rrand(0.1, 0.3) if s == 3
  sample :drum_cymbal_closed, amp: vol, rate: rrand(0.9, 1.3) if spread(5, 8).tick
  sleep 0.125
end

live_loop :ghost_snares do
  s = get[:section]
  vol = 0
  vol = 0.4 if s == 2 or s == 4
  pattern = knit(false, 3, true, 1, false, 2, true, 1, false, 1)
  sample :sn_dub, amp: vol * rrand(0.3, 0.6), rate: 1.4 if pattern.tick
  sleep 0.25
end

live_loop :reese do
  s = get[:section]
  use_synth :tb303
  vol = 0
  vol = 0.4 if s == 1
  vol = 0.7 if s == 2
  vol = 0.8 if s == 4
  vol = 0.3 if s == 3
  notes = ring(:e1, :e1, :g1, :e1, :a1, :e1, :d1, :e1)
  with_fx :wobble, phase: 0.5, mix: 0.6 do
    with_fx :distortion, distort: 0.4 do
      play notes.tick, release: 0.4, cutoff: rrand(60, 100), res: 0.7, amp: vol
      sleep 0.5
    end
  end
end

live_loop :pad do
  s = get[:section]
  use_synth :hollow
  vol = 0
  vol = 0.3 if s == 3
  vol = 0.15 if s == 0
  with_fx :reverb, room: 0.9 do
    play chord(:e3, :minor7), release: 8, amp: vol, cutoff: 75
  end
  sleep 8
end

live_loop :stab do
  s = get[:section]
  use_synth :supersaw
  vol = 0
  vol = 0.4 if s == 2
  vol = 0.5 if s == 4
  if one_in(4)
    with_fx :reverb, room: 0.6 do
      play chord(:e4, :minor), release: 0.15, amp: vol, cutoff: 100
    end
  end
  sleep 0.5
end`,
    js: '',
  },

  {
    name: 'Solar Flare',
    difficulty: 'advanced',
    description: 'Progressive trance — building arpeggios, filter sweeps, euphoric chords, four-on-floor.',
    ruby: `\
# "Solar Flare" — Progressive Trance
# Inspired by the Sonic Pi community
# Technique: line() filter sweeps, building arpeggios, layered pads

use_bpm 138

live_loop :director do
  set :section, 0  # intro: kick + rising filter arp
  sleep 32
  set :section, 1  # build: pads enter, arp intensifies
  sleep 32
  set :section, 2  # drop: full euphoric chords + bass
  sleep 64
  set :section, 3  # breakdown: pad solo, no drums
  sleep 16
  set :section, 4  # climax: everything, peak energy
  sleep 48
  stop
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 1.5 if s == 0 or s == 1
  vol = 2.0 if s == 2 or s == 4
  sample :bd_haus, amp: vol
  sleep 1
end

live_loop :offbeat_hat do
  s = get[:section]
  vol = 0
  vol = 0.4 if s == 0 or s == 1
  vol = 0.6 if s == 2 or s == 4
  sleep 0.5
  sample :drum_cymbal_closed, amp: vol
  sleep 0.5
end

live_loop :clap do
  s = get[:section]
  vol = 0
  vol = 0.8 if s == 1
  vol = 1.2 if s == 2 or s == 4
  sleep 1
  sample :sn_dub, amp: vol
  sleep 1
end

live_loop :arp do
  s = get[:section]
  use_synth :saw
  vol = 0
  vol = 0.2 if s == 0
  vol = 0.3 if s == 1
  vol = 0.4 if s == 2 or s == 4
  vol = 0.15 if s == 3
  co = 70
  co = 90 if s == 1
  co = 110 if s >= 2
  notes = scale(:a3, :minor_pentatonic, num_octaves: 2)
  with_fx :echo, phase: 0.25, decay: 4, mix: 0.4 do
    play notes.tick, release: 0.15, amp: vol, cutoff: co
    sleep 0.125
  end
end

live_loop :pad do
  s = get[:section]
  use_synth :prophet
  vol = 0
  vol = 0.3 if s == 1
  vol = 0.5 if s == 2
  vol = 0.6 if s == 3
  vol = 0.5 if s == 4
  chords = [chord(:a3, :minor), chord(:f3, :major),
            chord(:c4, :major), chord(:g3, :major)]
  with_fx :reverb, room: 0.8, mix: 0.5 do
    play chords.tick, attack: 1, release: 6, amp: vol, cutoff: 90
    sleep 4
  end
end

live_loop :bass do
  s = get[:section]
  use_synth :sine
  vol = 0
  vol = 0.6 if s == 2
  vol = 0.8 if s == 4
  notes = ring(:a1, :a1, :f1, :f1, :c2, :c2, :g1, :g1)
  play notes.tick, release: 0.4, amp: vol
  sleep 0.5
end

live_loop :riser do
  s = get[:section]
  use_synth :cnoise
  vol = 0
  vol = 0.06 if s == 1
  vol = 0.08 if s == 3
  with_fx :hpf, cutoff: rrand(70, 100) do
    play :c4, release: 4, amp: vol
  end
  sleep 4
end`,
    js: '',
  },

  {
    name: 'Pocket Groove',
    difficulty: 'advanced',
    description: 'Lo-fi hip hop — dusty drums, mellow piano chords, vinyl crackle, jazzy bass.',
    ruby: `\
# "Pocket Groove" — Lo-fi Hip Hop
# Inspired by the Sonic Pi community
# Technique: swing timing, noise textures, mellow timbres, jazzy harmony

use_bpm 85

live_loop :director do
  set :section, 0  # intro: vinyl + piano only
  sleep 16
  set :section, 1  # verse: drums enter, bass joins
  sleep 32
  set :section, 2  # chorus: lead melody + full band
  sleep 48
  set :section, 3  # bridge: strip to piano + bass
  sleep 16
  set :section, 4  # outro: fade all layers
  sleep 16
  stop
end

live_loop :vinyl do
  s = get[:section]
  use_synth :cnoise
  vol = 0
  vol = 0.03 if s <= 3
  vol = 0.02 if s == 4
  with_fx :lpf, cutoff: 80 do
    with_fx :hpf, cutoff: 40 do
      play :c4, release: 4, amp: vol
    end
  end
  sleep 4
end

live_loop :piano do
  s = get[:section]
  use_synth :piano
  vol = 0
  vol = 0.4 if s == 0 or s == 3
  vol = 0.35 if s == 1
  vol = 0.5 if s == 2
  vol = 0.2 if s == 4
  chords = [chord(:d3, :minor7), chord(:g3, :dom7),
            chord(:c3, :major7), chord(:a2, :minor7)]
  with_fx :lpf, cutoff: 90 do
    with_fx :reverb, room: 0.5, mix: 0.3 do
      play chords.tick, release: 1.5, amp: vol
      sleep 2
    end
  end
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 1.2 if s == 1
  vol = 1.5 if s == 2
  sample :bd_808, amp: vol
  sleep 1
end

live_loop :snare do
  s = get[:section]
  vol = 0
  vol = 0.6 if s == 1
  vol = 0.8 if s == 2
  sleep 1
  sample :sn_dub, amp: vol, rate: 0.9
  sleep 1
end

live_loop :hats do
  s = get[:section]
  vol = 0
  vol = rrand(0.15, 0.35) if s == 1 or s == 2
  pattern = knit(true, 1, false, 1, true, 1, true, 1)
  sample :drum_cymbal_closed, amp: vol, rate: rrand(0.8, 1.1) if pattern.tick
  sleep 0.25
end

live_loop :bass do
  s = get[:section]
  use_synth :fm
  vol = 0
  vol = 0.4 if s == 1 or s == 3
  vol = 0.5 if s == 2
  vol = 0.2 if s == 4
  notes = ring(:d2, :d2, :g2, :g2, :c2, :c2, :a1, :a1)
  with_fx :lpf, cutoff: 75 do
    play notes.tick, release: 0.5, amp: vol, cutoff: 70
    sleep 0.5
  end
end

live_loop :lead do
  s = get[:section]
  use_synth :pluck
  vol = 0
  vol = 0.35 if s == 2
  notes = scale(:d4, :dorian)
  with_fx :reverb, room: 0.6 do
    play notes.choose, release: rrand(0.3, 0.6), amp: vol if one_in(2)
  end
  sleep 0.5
end`,
    js: '',
  },

  {
    name: 'Neon Grid',
    difficulty: 'advanced',
    description: 'Cyberpunk techno — industrial kick, metallic hats, dark acid line, glitchy FX.',
    ruby: `\
# "Neon Grid" — Cyberpunk Techno
# Inspired by the Sonic Pi community
# Technique: TB-303 acid, krush/distortion, Euclidean patterns, glitch FX

use_bpm 135

live_loop :director do
  set :section, 0  # intro: kick + sparse acid
  sleep 32
  set :section, 1  # build: hats enter, acid intensifies
  sleep 32
  set :section, 2  # drop: full acid + industrial drums
  sleep 64
  set :section, 3  # break: glitch noise + sparse hits
  sleep 16
  set :section, 4  # climax: everything crushed
  sleep 48
  stop
end

live_loop :kick do
  s = get[:section]
  vol = 0
  vol = 1.5 if s == 0 or s == 1
  vol = 2.5 if s == 2 or s == 4
  vol = 0.8 if s == 3
  with_fx :distortion, distort: 0.2 do
    sample :bd_tek, amp: vol
  end
  sleep 0.5
end

live_loop :hats do
  s = get[:section]
  vol = 0
  vol = rrand(0.2, 0.5) if s == 1
  vol = rrand(0.3, 0.7) if s == 2 or s == 4
  pattern = spread(7, 16)
  sample :drum_cymbal_closed, amp: vol, rate: rrand(1.0, 1.5) if pattern.tick
  sleep 0.125
end

live_loop :clap do
  s = get[:section]
  vol = 0
  vol = 1.0 if s == 1 or s == 2
  vol = 1.5 if s == 4
  sleep 1
  sample :sn_dub, amp: vol
  sleep 1
end

live_loop :acid do
  s = get[:section]
  use_synth :tb303
  vol = 0
  vol = 0.3 if s == 0
  vol = 0.5 if s == 1
  vol = 0.7 if s == 2
  vol = 0.8 if s == 4
  vol = 0.2 if s == 3
  lo = 50
  hi = 100
  lo = 60 if s >= 2
  hi = 120 if s >= 2
  with_fx :distortion, distort: 0.5 do
    notes = ring(:e1, :e1, :e2, :e1, :g1, :e1, :bb1, :a1)
    play notes.tick, release: 0.2, cutoff: rrand(lo, hi), res: 0.85, amp: vol
    sleep 0.25
  end
end

live_loop :glitch do
  s = get[:section]
  use_synth :cnoise
  vol = 0
  vol = 0.06 if s == 3
  vol = 0.04 if s == 4
  with_fx :krush, gain: 8, cutoff: rrand(60, 100) do
    play :c4, release: rrand(0.05, 0.2), amp: vol if one_in(3)
  end
  sleep 0.125
end

live_loop :dark_pad do
  s = get[:section]
  use_synth :dark_ambience
  vol = 0
  vol = 0.2 if s == 0
  vol = 0.25 if s == 2 or s == 4
  vol = 0.3 if s == 3
  with_fx :reverb, room: 0.8 do
    play chord(:e2, :minor), release: 8, amp: vol
  end
  sleep 8
end

live_loop :perc do
  s = get[:section]
  vol = 0
  vol = 0.4 if s == 2 or s == 4
  pattern = spread(3, 8)
  sample :perc_bell, amp: vol * rrand(0.3, 0.8), rate: rrand(0.5, 2.0) if pattern.tick
  sleep 0.25
end`,
    js: '',
  },

  {
    name: 'Cloud Cathedral',
    difficulty: 'advanced',
    description: 'Post-rock/ambient — reverb-drenched plucks, swelling pads, delayed melody that builds.',
    ruby: `\
# "Cloud Cathedral" — Post-rock / Ambient
# Inspired by the Sonic Pi community
# Technique: deep reverb/delay stacking, slow crescendo, tremolo swells

use_bpm 100

live_loop :director do
  set :section, 0  # intro: single plucks in space
  sleep 32
  set :section, 1  # build: pad swells, melody forms
  sleep 32
  set :section, 2  # peak: full arrangement, drums enter
  sleep 48
  set :section, 3  # descent: strip layers, slow down
  sleep 24
  set :section, 4  # silence: final note rings out
  sleep 8
  stop
end

live_loop :plucks do
  s = get[:section]
  use_synth :pluck
  vol = 0
  vol = 0.3 if s == 0
  vol = 0.35 if s == 1
  vol = 0.4 if s == 2
  vol = 0.25 if s == 3
  vol = 0.15 if s == 4
  notes = ring(:e4, :b4, :g4, :d5, :a4, :e5, :b4, :fs5)
  with_fx :reverb, room: 0.95, mix: 0.7 do
    with_fx :echo, phase: 0.75, decay: 6, mix: 0.5 do
      play notes.tick, release: rrand(0.3, 0.8), amp: vol
    end
  end
  sleep 1
end

live_loop :pad do
  s = get[:section]
  use_synth :hollow
  vol = 0
  vol = 0.2 if s == 1
  vol = 0.4 if s == 2
  vol = 0.3 if s == 3
  vol = 0.1 if s == 4
  chords = [chord(:e3, :sus4), chord(:b2, :sus2),
            chord(:g3, :major7), chord(:d3, :sus4)]
  with_fx :reverb, room: 0.9, mix: 0.6 do
    with_fx :tremolo, phase: 4, mix: 0.3 do
      play chords.tick, attack: 4, release: 8, amp: vol, cutoff: 80
      sleep 8
    end
  end
end

live_loop :melody do
  s = get[:section]
  use_synth :blade
  vol = 0
  vol = 0.2 if s == 1
  vol = 0.35 if s == 2
  vol = 0.15 if s == 3
  notes = [:e5, :d5, :b4, :a4, :g4, :a4, :b4, :d5]
  durs = [1.5, 1, 0.5, 1, 1.5, 1, 0.5, 1]
  with_fx :reverb, room: 0.85 do
    with_fx :echo, phase: 0.5, decay: 4, mix: 0.4 do
      i = tick % 8
      play notes[i], release: durs[i] * 0.8, amp: vol, cutoff: 90
      sleep durs[i]
    end
  end
end

live_loop :bass_drone do
  s = get[:section]
  use_synth :sine
  vol = 0
  vol = 0.2 if s == 1
  vol = 0.35 if s == 2
  vol = 0.15 if s == 3
  notes = ring(:e2, :e2, :b1, :g2)
  play notes.tick, attack: 2, release: 6, amp: vol
  sleep 8
end

live_loop :drums do
  s = get[:section]
  k_vol = 0
  s_vol = 0
  k_vol = 1.2 if s == 2
  s_vol = 0.6 if s == 2
  sample :bd_haus, amp: k_vol
  sleep 1
  sample :sn_dub, amp: s_vol
  sleep 1
  sample :bd_haus, amp: k_vol * 0.7
  sleep 1
  sample :sn_dub, amp: s_vol * 0.8
  sleep 1
end

live_loop :shimmer do
  s = get[:section]
  use_synth :saw
  vol = 0
  vol = 0.08 if s == 2
  vol = 0.05 if s == 3
  with_fx :reverb, room: 0.95, mix: 0.9 do
    with_fx :hpf, cutoff: 90 do
      play scale(:e5, :minor_pentatonic).choose, release: 0.1, amp: vol if one_in(3)
    end
  end
  sleep 0.25
end`,
    js: '',
  },

  {
    name: 'Algorithm',
    difficulty: 'advanced',
    description: 'Algorave/live-coding showcase — randomized params, Euclidean rhythms, density variations.',
    ruby: `\
# "Algorithm" — Algorave
# Inspired by the Sonic Pi community
# Technique: every parameter randomized within ranges, Euclidean rhythms, density, spread

use_bpm 128

live_loop :director do
  set :section, 0  # intro: sparse algorithmic textures
  sleep 32
  set :section, 1  # build: layers accumulate
  sleep 32
  set :section, 2  # peak: maximum density
  sleep 48
  set :section, 3  # variation: shift all patterns
  sleep 32
  set :section, 4  # outro: dissolve
  sleep 16
  stop
end

live_loop :algo_kick do
  s = get[:section]
  vol = 0
  vol = 1.5 if s == 0 or s == 1
  vol = 2.0 if s == 2 or s == 3
  vol = 1.0 if s == 4
  hits = 4
  hits = 5 if s == 3
  pattern = spread(hits, 8)
  sample :bd_haus, amp: vol if pattern.tick
  sleep 0.25
end

live_loop :algo_snare do
  s = get[:section]
  vol = 0
  vol = 0.6 if s == 1
  vol = 1.0 if s == 2 or s == 3
  vol = 0.4 if s == 4
  hits = 3
  hits = 5 if s == 3
  pattern = spread(hits, 16)
  sample :sn_dub, amp: vol * rrand(0.6, 1.0) if pattern.tick
  sleep 0.25
end

live_loop :algo_hats do
  s = get[:section]
  vol = 0
  vol = rrand(0.1, 0.3) if s == 0
  vol = rrand(0.2, 0.5) if s == 1 or s == 2
  vol = rrand(0.3, 0.6) if s == 3
  vol = rrand(0.05, 0.2) if s == 4
  hits = 5
  hits = 7 if s >= 2
  steps = 8
  steps = 16 if s >= 2
  pattern = spread(hits, steps)
  sample :drum_cymbal_closed, amp: vol, rate: rrand(0.8, 1.6) if pattern.tick
  sleep 0.125
end

live_loop :algo_bass do
  s = get[:section]
  use_synth :tb303
  vol = 0
  vol = 0.4 if s == 0
  vol = 0.5 if s == 1
  vol = 0.7 if s == 2
  vol = 0.6 if s == 3
  vol = 0.3 if s == 4
  notes = scale(:e1, :minor_pentatonic)
  with_fx :distortion, distort: rrand(0.1, 0.5) do
    play notes.choose, release: 0.2, cutoff: rrand(50, 110), res: rrand(0.2, 0.9), amp: vol
    sleep 0.25
  end
end

live_loop :algo_lead do
  s = get[:section]
  synths = [:saw, :square, :pluck, :blade, :zawa]
  use_synth synths.choose
  vol = 0
  vol = 0.2 if s == 1
  vol = 0.35 if s == 2
  vol = 0.3 if s == 3
  vol = 0.1 if s == 4
  notes = scale(:e4, :minor_pentatonic, num_octaves: 2)
  with_fx :echo, phase: [0.25, 0.375, 0.5].choose, decay: rrand(2, 6), mix: 0.4 do
    with_fx :reverb, room: rrand(0.4, 0.9) do
      play notes.choose, release: rrand(0.1, 0.4), amp: vol, cutoff: rrand(70, 110) if one_in(2)
    end
  end
  sleep 0.25
end

live_loop :algo_pad do
  s = get[:section]
  use_synth [:prophet, :hollow, :dark_ambience].choose
  vol = 0
  vol = 0.2 if s == 1
  vol = 0.3 if s == 2
  vol = 0.35 if s == 3
  vol = 0.15 if s == 4
  roots = [:e3, :a3, :b3, :d3, :g3]
  types = [:minor7, :minor, :sus4, :sus2]
  with_fx :reverb, room: rrand(0.6, 0.95) do
    play chord(roots.choose, types.choose), attack: 2, release: rrand(4, 8), amp: vol
  end
  sleep rrand(4, 8)
end

live_loop :algo_perc do
  s = get[:section]
  vol = 0
  vol = 0.3 if s == 2
  vol = 0.4 if s == 3
  vol = 0.15 if s == 4
  sample :perc_bell, amp: vol * rrand(0.2, 0.8), rate: rrand(0.3, 3.0) if one_in(4)
  sleep 0.25
end`,
    js: '',
  },

  {
    name: 'Blade Runner x Techno',
    difficulty: 'advanced',
    description: '10 synced loops — percussion, harmonic engine, synthbass. Techniques: define, line().mirror.tick, panslicer, sync.',
    ruby: `\
# =====================================================
#  BLADE RUNNER x TECHNO
#  10 synced loops: percussion + harmonic engine + synthbass
#  Techniques: define, line().mirror.tick, panslicer, sync
# =====================================================

use_bpm 115

amp_master = 1.0
c_blade    = 72
c_perc     = 115

define :pattern do |p|
  p.ring.tick == "x"
end

live_loop :met1 do
  sleep 1
end

# KICK
live_loop :kick, sync: :met1 do
  sample :bd_haus, amp: 1.5 * amp_master, cutoff: c_perc      if pattern "x-----------x---"
  sample :bd_tek,  amp: 0.5 * amp_master, cutoff: c_perc + 12 if pattern "x-----------x---"
  sleep 0.25
end

# SNARE
with_fx :reverb, mix: 0.3, room: 0.72 do
  live_loop :snare, sync: :met1 do
    sleep 1
    sample :drum_snare_hard, rate: 1.8, cutoff: c_perc, amp: 0.65 * amp_master
    sample :drum_snare_hard, rate: 1.6, start: 0.03, cutoff: c_perc, pan: 0.25, amp: 0.65 * amp_master
    sample :drum_snare_hard, rate: 1.5, start: 0.06, cutoff: c_perc, pan: -0.25, amp: 0.65 * amp_master
    sleep 1
  end
end

# HI-HATS
with_fx :panslicer, mix: 0.22 do
  with_fx :reverb, mix: 0.15 do
    live_loop :hats, sync: :met1 do
      a = rrand(0.38, 0.72) * amp_master
      sample :drum_cymbal_closed, amp: a, rate: 2.2, finish: 0.5, pan: [-0.4, 0.4].choose, cutoff: c_perc if pattern "x-x-x-x-x-x-x-x-xxx-x-x-x-"
      sleep 0.125
    end
  end
end

# CRASH
with_fx :reverb, mix: 0.75 do
  live_loop :crash, sync: :met1 do
    sleep 15.5
    sample :drum_splash_soft, amp: 0.07 * amp_master, cutoff: c_perc - 12, rate: 1.4, finish: 0.3
    sleep 0.5
  end
end

# HARMONIC ENGINE
with_fx :panslicer, mix: 0.18, phase: 8 do
  with_fx :reverb, room: 0.97, mix: 0.78, damp: 0.4 do

    # PADS
    live_loop :pads, sync: :met1 do
      use_synth :blade
      sweep = (line c_blade - 16, c_blade + 16, steps: 16).mirror.tick

      [:c3, :eb3, :g3, :b3].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.3 * amp_master, cutoff: sweep, vibrato_rate: 4.5, vibrato_depth: 0.10, vibrato_delay: 1.5, vibrato_onset: 0.8
      end
      sleep 12

      [:eb3, :g3, :bb3, :d4, :f4].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.3 * amp_master, cutoff: sweep + 8, vibrato_rate: 5.0, vibrato_depth: 0.12, vibrato_delay: 1.2, vibrato_onset: 0.7
      end
      sleep 12

      [:ab2, :c3, :eb3, :g3].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.4 * amp_master, cutoff: sweep + 14, vibrato_rate: 5.5, vibrato_depth: 0.15, vibrato_delay: 1.0, vibrato_onset: 0.6
      end
      sleep 12

      [:g2, :b2, :d3, :f3, :a3].each do |n|
        play n, attack: 3.5, sustain: 5.0, release: 4.5, amp: 1.4 * amp_master, cutoff: sweep + 20, vibrato_rate: 6.0, vibrato_depth: 0.18, vibrato_delay: 0.8, vibrato_onset: 0.5
      end
      sleep 12
    end

    # MELODY
    live_loop :melody, sync: :pads do
      use_synth :blade
      vib = (line 0.10, 0.30, steps: 48).mirror.tick

      play :c5, attack: 1.5, sustain: 2.5, release: 2.5, amp: 0.58 * amp_master, cutoff: c_blade + 6, vibrato_rate: 5.5, vibrato_depth: vib, vibrato_delay: 0.8, vibrato_onset: 0.5
      sleep 5
      play :eb5, attack: 0.8, sustain: 1.5, release: 1.8, amp: 0.52 * amp_master, cutoff: c_blade + 4, vibrato_rate: 5.2, vibrato_depth: vib + 0.02, vibrato_delay: 0.6, vibrato_onset: 0.4
      sleep 4
      play :g5, attack: 0.6, sustain: 1.2, release: 1.5, amp: 0.50 * amp_master, cutoff: c_blade + 8, vibrato_rate: 5.8, vibrato_depth: vib + 0.02, vibrato_delay: 0.5, vibrato_onset: 0.3
      sleep 3

      play :bb5, attack: 2.0, sustain: 3.5, release: 2.5, amp: 0.64 * amp_master, cutoff: c_blade + 12, vibrato_rate: 6.0, vibrato_depth: vib + 0.04, vibrato_delay: 0.9, vibrato_onset: 0.5
      sleep 6
      play :g5, attack: 0.8, sustain: 2.0, release: 2.0, amp: 0.56 * amp_master, cutoff: c_blade + 10, vibrato_rate: 5.8, vibrato_depth: vib + 0.02, vibrato_delay: 0.7, vibrato_onset: 0.4
      sleep 6

      play :c6, attack: 2.5, sustain: 5.5, release: 3.0, amp: 0.68 * amp_master, cutoff: c_blade + 20, vibrato_rate: 6.5, vibrato_depth: vib + 0.08, vibrato_delay: 1.2, vibrato_onset: 0.6
      sleep 12

      play :d6, attack: 3.0, sustain: 4.5, release: 3.5, amp: 0.66 * amp_master, cutoff: c_blade + 24, vibrato_rate: 7.0, vibrato_depth: vib + 0.10, vibrato_delay: 1.0, vibrato_onset: 0.7
      sleep 8
      play :b5, attack: 1.2, sustain: 1.8, release: 2.2, amp: 0.55 * amp_master, cutoff: c_blade + 18, vibrato_rate: 6.5, vibrato_depth: vib + 0.05, vibrato_delay: 0.6, vibrato_onset: 0.4
      sleep 4
    end

    # ECSTASY ARPEGGIOS
    live_loop :ecstasy, sync: :pads do
      use_synth :blade
      arp_chords = [
        [:c4, :eb4, :g4, :b4, :c5, :g4],
        [:eb4, :g4, :bb4, :d5, :f5, :bb4],
        [:ab4, :c5, :eb5, :g5, :ab5, :eb5],
        [:g4, :b4, :d5, :f5, :a5, :d5],
      ]
      4.times do |i|
        arp = arp_chords[i]
        spd = 1.2 - (i * 0.05)
        breath = 12.0 - (arp.length * spd)
        with_fx :echo, phase: 0.75, mix: (line 0.08, 0.72, steps: 128).mirror.tick do
          arp.each do |n|
            play n, attack: 0.04, sustain: spd * 0.32, release: spd * 0.58, amp: rrand(0.18, 0.32) * amp_master, cutoff: c_blade + (i * 6) + rrand(-4, 8), vibrato_rate: rrand(6, 9), vibrato_depth: rrand(0.08, 0.16), vibrato_delay: 0.12, vibrato_onset: 0.06
            sleep spd
          end
        end
        sleep [breath, 0.25].max
      end
    end

    # TEARS
    live_loop :tears, sync: :pads do
      use_synth :blade
      tear_data = [[:eb6, 12], [:g6, 12], [:c7, 12], [:b6, 12]]
      tear_data.each do |td|
        if one_in(2)
          play td[0], attack: rrand(2.5, 4.5), sustain: rrand(3.0, 5.5), release: rrand(4.0, 7.0), amp: rrand(0.12, 0.22) * amp_master, cutoff: rrand(92, 108), vibrato_rate: rrand(4.5, 7.0), vibrato_depth: rrand(0.18, 0.34), vibrato_delay: rrand(1.2, 2.5), vibrato_onset: rrand(0.5, 1.0)
        end
        sleep td[1]
      end
    end

    # SHIMMER
    live_loop :shimmer, sync: :pads do
      use_synth :blade
      pool = [:c6, :eb6, :g6, :bb6, :d7, :c7, :g6, :eb6, :ab6, :f6, :b6, :d6]
      pool.each do |n|
        unless one_in(3)
          play n, attack: rrand(1.0, 3.0), sustain: rrand(0.5, 2.0), release: rrand(3.5, 6.0), amp: rrand(0.06, 0.16) * amp_master, cutoff: rrand(94, 112), vibrato_rate: rrand(7.0, 10.0), vibrato_depth: rrand(0.14, 0.30), vibrato_delay: rrand(0.3, 0.8), vibrato_onset: rrand(0.2, 0.5)
        end
        sleep rrand(1.0, 3.0)
      end
    end

  end
end

# SYNTHBASS
with_fx :panslicer, mix: 0.28 do
  with_fx :reverb, mix: 0.28 do
    live_loop :synthbass, sync: :pads do
      use_synth :tech_saws
      bass_data = [[:c2, 56], [:eb2, 60], [:ab2, 65], [:g2, 69]]
      bass_data.each do |bd|
        play bd[0], sustain: 8.5, release: 3.0, cutoff: bd[1], amp: 0.78 * amp_master, attack: 0.1
        sleep 12
      end
    end
  end
end`,
    js: '',
  },
]

/** Get an example by name (case-insensitive). */
export function getExample(name: string): Example | undefined {
  return examples.find(e => e.name.toLowerCase() === name.toLowerCase())
}

/** Get all example names. */
export function getExampleNames(): string[] {
  return examples.map(e => e.name)
}

/** Get examples grouped by difficulty. */
export function getExamplesByDifficulty(): Record<Difficulty, Example[]> {
  return {
    beginner: examples.filter(e => e.difficulty === 'beginner'),
    intermediate: examples.filter(e => e.difficulty === 'intermediate'),
    advanced: examples.filter(e => e.difficulty === 'advanced'),
  }
}
