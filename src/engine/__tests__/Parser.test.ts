import { describe, it, expect } from 'vitest'
import { parseAndTranspile } from '../Parser'

describe('Parser', () => {
  it('transpiles basic live_loop', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('live_loop("drums"')
    expect(code).toContain('b.sample("bd_haus")')
    expect(code).toContain('b.sleep(0.5)')
    expect(code).toContain('})')
  })

  it('transpiles live_loop with sync option', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :bass, sync: :drums do
  play :e2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('live_loop("bass"')
    expect(code).toContain('b.sync("drums")')
    expect(code).toContain('b.play("e2")')
  })

  it('transpiles with_fx', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :fx do
  with_fx :reverb do
    play 60
    sleep 1
  end
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('with_fx("reverb"')
    expect(code).toContain('b.play(60)')
  })

  it('transpiles if/elsif/else/end', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  if true
    play 60
  elsif false
    play 64
  else
    play 67
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('if (true)')
    expect(code).toContain('else if (false)')
    expect(code).toContain('} else {')
  })

  it('transpiles unless block', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  unless false
    play 60
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('if (!(false))')
  })

  it('transpiles N.times do |i|', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  4.times do |i|
    play 60
    sleep 0.25
  end
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('for (let i = 0; i < 4; i++)')
  })

  it('transpiles define with b parameter and body prefixes', () => {
    const { code, errors } = parseAndTranspile(`
define :bass_line do
  play :e2
  sleep 0.5
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('function bass_line(b)')
    expect(code).not.toContain('async function')
    expect(code).toContain('b.play("e2")')
    expect(code).toContain('b.sleep(0.5)')
  })

  it('transpiles define with params', () => {
    const { code, errors } = parseAndTranspile(`
define :bass do |n|
  play n
  sleep 0.5
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('function bass(b, n)')
    expect(code).toContain('b.play(n)')
  })

  it('rewrites call site for defined function', () => {
    const { code, errors } = parseAndTranspile(`
define :bass do |n|
  play n
  sleep 0.5
end

live_loop :main do
  bass :c2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('bass(b, "c2")')
  })

  it('rewrites call site with no args', () => {
    const { code, errors } = parseAndTranspile(`
define :hit do
  sample :bd_haus
  sleep 0.5
end

live_loop :drums do
  hit
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('hit(b)')
  })

  it('transpiles in_thread as builder call', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  in_thread do
    play 72
    sleep 0.5
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.in_thread((b) => {')
    expect(code).toContain('b.play(72)')
    expect(code).toContain('b.sleep(0.5)')
    expect(code).not.toContain(';(async () => {')
    expect(code).not.toContain('})()')
  })

  it('transpiles comments', () => {
    const { code, errors } = parseAndTranspile(`
# This is a comment
live_loop :test do
  play 60  # inline comment
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('// This is a comment')
  })

  it('transpiles use_synth and use_bpm', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  use_synth :tb303
  use_bpm 120
  play :c4
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.use_synth("tb303")')
    expect(code).toContain('b.use_bpm(120)')
  })

  it('transpiles trailing if/unless', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  play 60 if true
  sample "bd_haus" unless false
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('if (true) { b.play(60) }')
    expect(code).toContain('if (!(false)) { b.sample("bd_haus") }')
  })

  it('reports error for unclosed block', () => {
    const { errors } = parseAndTranspile(`
live_loop :test do
  play 60
  sleep 1
`)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain('end')
  })

  it('transpiles symbols to strings', () => {
    const { code } = parseAndTranspile(`
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end
`)
    expect(code).toContain('"bd_haus"')
    expect(code).not.toContain(':bd_haus')
  })

  it('transpiles puts and print', () => {
    const { code } = parseAndTranspile(`
live_loop :test do
  puts "hello"
  print "world"
  sleep 1
end
`)
    expect(code).toContain('b.puts("hello")')
    expect(code).toContain('b.puts("world")')
  })

  it('transpiles loop do', () => {
    const { code, errors } = parseAndTranspile(`
loop do
  play 60
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('while (true)')
  })

  it('transpiles s = play to use lastRef for control', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  s = play 60, note_slide: 1
  sleep 1
  control s, note: 65
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.play(60')
    expect(code).toContain('const s = b.lastRef')
    expect(code).toContain('b.control(s')
  })

  it('converts string interpolation to backtick template literals', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  puts "hello #{name} world"
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('`hello ${name} world`')
    expect(code).not.toContain('"hello ${name} world"')
  })

  it('transpiles at with times array', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  at [0, 0.5] do
    play 60
    sleep 0.25
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.at(')
    expect(code).toContain('null, (b) => {')
    expect(code).toContain('b.play(60)')
    expect(code).toContain('b.sleep(0.25)')
  })

  it('transpiles at with times and values arrays', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  at [0, 1, 2], [:c4, :e4, :g4] do |beat, note|
    play note
    sleep 0.25
  end
  sleep 3
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.at(')
    expect(code).toContain('"c4"')
    expect(code).toContain('"e4"')
    expect(code).toContain('"g4"')
    expect(code).toContain('(b, beat, note) => {')
    expect(code).toContain('b.play(note)')
  })

  it('transpiles time_warp as at() sugar', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  time_warp 2 do
    play 60
  end
  sleep 4
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.at([2], null, (b) => {')
    expect(code).toContain('b.play(60)')
  })

  it('transpiles density with save/restore', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  density 2 do
    play 60
    sleep 1
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('const __prevDensity = b.density')
    expect(code).toContain('b.density = __prevDensity * 2')
    expect(code).toContain('b.density = __prevDensity')
    expect(code).toContain('b.play(60)')
    expect(code).toContain('b.sleep(1)')
  })

  it('transpiles .each do |n| to for-of loop', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  [60, 62, 64].each do |n|
    play n
    sleep 0.25
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('for (const n of [60, 62, 64])')
    expect(code).toContain('b.play(n)')
    expect(code).toContain('b.sleep(0.25)')
  })

  it('transpiles .each without block variable', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  [60, 62, 64].each do
    play 60
    sleep 0.25
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('for (const _item of [60, 62, 64])')
  })

  it('transpiles .each on a variable', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  notes = [60, 62, 64]
  notes.each do |n|
    play n
    sleep 0.25
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('for (const n of notes)')
  })

  it('transpiles .map with single-line curly brace block', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  notes = [60, 62, 64].map { |n| n + 12 }
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('.map((n) => n + 12)')
  })

  it('transpiles .select with single-line curly brace block', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  evens = [1, 2, 3, 4].select { |n| n % 2 == 0 }
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('.filter((n) => n % 2 == 0)')
  })

  it('transpiles .reject with single-line curly brace block', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  odds = [1, 2, 3, 4].reject { |n| n % 2 == 0 }
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('.filter((n) => !(n % 2 == 0))')
  })

  it('transpiles .collect as alias for .map', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  notes = [60, 62, 64].collect { |n| n + 12 }
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('.map((n) => n + 12)')
  })

  it('transpiles multi-line .map do |n|', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  [60, 62, 64].map do |n|
    play n
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('.map((n) =>')
    expect(code).toContain('b.play(n)')
  })

  it('transpiles begin ... rescue ... end', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  begin
    play 60
    sleep 1
  rescue
    puts "error"
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('try {')
    expect(code).toContain('} catch (_e) {')
    expect(code).toContain('b.play(60)')
    expect(code).toContain('b.puts("error")')
  })

  it('transpiles begin ... rescue => e ... end', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  begin
    play 60
  rescue => e
    puts e
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('try {')
    expect(code).toContain('} catch (e) {')
  })

  it('transpiles begin ... rescue ... ensure ... end', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  begin
    play 60
  rescue
    puts "error"
  ensure
    puts "cleanup"
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('try {')
    expect(code).toContain('} catch (_e) {')
    expect(code).toContain('} finally {')
    expect(code).toContain('b.puts("cleanup")')
  })

  it('transpiles live_audio :mic', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :input do
  live_audio :mic
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.live_audio("mic")')
  })

  it('transpiles live_audio :mic with stereo option', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :input do
  live_audio :mic, stereo: true
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.live_audio("mic"')
    expect(code).toMatch(/stereo\s*:\s*true/)
  })

  // --- BUG-12: kwargs token reconstruction ---

  it('reconstructs keyword args without spaces around colons', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  sample :bd_haus, amp: 2
  sleep 0.5
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('{ amp: 2')
    expect(code).not.toContain('amp : 2')
  })

  it('reconstructs multiple kwargs correctly', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  play 60, release: 0.5, amp: 2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('{ release: 0.5, amp: 2')
  })

  it('reconstructs with_fx opts as kwargs object', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  with_fx :reverb, room: 0.5 do
    play 60
    sleep 1
  end
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('{ room: 0.5 }')
    expect(code).not.toContain('room : 0.5')
  })

  // --- BUG-01/02/03/04: top-level prefix ---

  it('in_thread at top level omits b. prefix', () => {
    const { code, errors } = parseAndTranspile(`
in_thread do
  play 60
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('in_thread((b) => {')
    expect(code).not.toContain('b.in_thread')
  })

  it('at block at top level omits b. prefix', () => {
    const { code, errors } = parseAndTranspile(`
at [0, 1, 2] do
  play 60
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('at(')
    expect(code).not.toContain('b.at(')
  })

  it('time_warp at top level omits b. prefix', () => {
    const { code, errors } = parseAndTranspile(`
time_warp 2 do
  play 60
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('at([2]')
    expect(code).not.toContain('b.at(')
  })

  it('density at top level omits b. references', () => {
    const { code, errors } = parseAndTranspile(`
density 2 do
  play 60
end
`)
    expect(errors).toHaveLength(0)
    expect(code).not.toContain('b.density')
  })

  // --- BUG-19: stop inside loop ---

  it('stop inside loop emits b.stop()', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  stop
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.stop()')
  })

  it('stop at top level emits stop()', () => {
    const { code, errors } = parseAndTranspile(`stop`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('stop()')
    expect(code).not.toContain('b.stop()')
  })

  // --- BUG-18: multi-line expressions ---

  it('joins lines ending with trailing comma', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  play 60,
    release: 0.2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('b.play(60')
    expect(code).toContain('release: 0.2')
    // Should be a single play call with kwargs, not separate lines
    expect(code).not.toMatch(/^release/m)
  })

  // --- stop_loop ---

  it('transpiles stop_loop :name at top level', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :foo do
  sleep 1
end
stop_loop :foo
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('stop_loop("foo")')
    expect(code).not.toContain('b.stop_loop')
  })

  it('transpiles stop_loop :name inside a loop', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :ctrl do
  stop_loop :drums
  sleep 4
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('stop_loop("drums")')
  })

  // --- multi-line continuation ---

  it('joins lines ending with &&', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  if x > 0 &&
    y > 0
    play 60
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('x > 0 && y > 0')
  })

  it('joins lines ending with ||', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  if a ||
    b
    play 60
  end
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('a || b')
  })

  it('joins lines ending with +', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  x = 1 +
    2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('1 + 2')
  })

  it('does NOT join lines when variable ends with "or" (e.g. color, minor)', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  color = :minor
  x = 5
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    // These must be separate statements, not joined into "minor x = 5"
    expect(code).toContain('"minor"')
    expect(code).toContain('const x = 5')
  })

  it('joins lines ending with backslash', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  x = 1 \\
    + 2
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('1 + 2')
  })

  // --- ternary operator ---

  it('transpiles ternary with numeric values', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  vol = x > 0 ? 0.8 : 0.5
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('0.8')
    expect(code).toContain('0.5')
    expect(code).toContain('?')
  })

  it('transpiles ternary with symbol values', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  n = cond ? :C4 : :G3
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('"C4"')
    expect(code).toContain('"G3"')
    expect(code).toContain('?')
  })

  it('kwargs colons are not affected by ternary fix', () => {
    const { code, errors } = parseAndTranspile(`
live_loop :test do
  play 60, amp: 0.5, release: 1
  sleep 1
end
`)
    expect(errors).toHaveLength(0)
    expect(code).toContain('amp: 0.5')
    expect(code).toContain('release: 1')
    expect(code).not.toContain('amp : 0.5')
  })
})
