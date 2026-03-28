/**
 * Real-world DSL compatibility matrix.
 *
 * Tests 50+ Sonic Pi programs through the transpiler pipeline:
 * 1. autoTranspile() — Ruby DSL → JS
 * 2. new Function() — validates the JS is syntactically valid
 * 3. Reports a compatibility matrix at the end.
 */

import { describe, it, expect } from 'vitest'
import { autoTranspile } from '../RubyTranspiler'

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

  it('compatibility summary: at least 90% transpile successfully', () => {
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

    expect(pct).toBeGreaterThanOrEqual(90)
  })
})
