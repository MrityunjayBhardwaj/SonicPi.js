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
})
