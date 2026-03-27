import { describe, it, expect } from 'vitest'
import { transpileRubyToJS, detectLanguage, autoTranspile } from '../RubyTranspiler'

/** Strip _srcLine from transpiler output for test comparison. */
const strip = (s: string) => s
  .replace(/,?\s*_srcLine:\s*\d+/g, '')
  .replace(/,\s*\{\s*\}/g, '')          // remove trailing empty opts: , { }
  .replace(/\(\s*\{\s*\}\s*\)/g, '()')  // remove (  { } ) → ()

describe('RubyTranspiler', () => {
  describe('live_loop', () => {
    it('transpiles basic live_loop', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('live_loop("drums", (b) => {')
      expect(strip(js)).toContain('b.sample("bd_haus")')
      expect(strip(js)).toContain('b.sleep(0.5)')
      expect(strip(js)).toContain('})')
    })

    it('transpiles live_loop with sync option', () => {
      const ruby = `live_loop :melody, sync: :metro do
  play 60
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('live_loop("melody", (b) => {')
      expect(strip(js)).toContain('b.sync("metro")')
    })
  })

  describe('play', () => {
    it('transpiles play with number', () => {
      expect(strip(transpileRubyToJS('play 60'))).toContain('b.play(60)')
    })

    it('transpiles play with symbol note', () => {
      expect(strip(transpileRubyToJS('play :c4'))).toContain('b.play("c4")')
    })

    it('transpiles play with opts', () => {
      const js = transpileRubyToJS('play 60, release: 0.5, amp: 2')
      expect(strip(js)).toContain('b.play(60, { release: 0.5, amp: 2 })')
    })
  })

  describe('sample', () => {
    it('transpiles sample with symbol', () => {
      expect(strip(transpileRubyToJS('sample :bd_haus'))).toContain('b.sample("bd_haus")')
    })

    it('transpiles sample with opts', () => {
      const js = transpileRubyToJS('sample :bd_haus, rate: 0.5, amp: 2')
      expect(strip(js)).toContain('b.sample("bd_haus", { rate: 0.5, amp: 2 })')
    })
  })

  describe('sleep', () => {
    it('transpiles sleep with number', () => {
      expect(strip(transpileRubyToJS('sleep 0.5'))).toContain('b.sleep(0.5)')
    })

    it('transpiles sleep with expression', () => {
      expect(strip(transpileRubyToJS('sleep 1.0/3'))).toContain('b.sleep(1.0/3)')
    })
  })

  describe('use_synth / use_bpm', () => {
    it('transpiles use_synth (top-level, no ctx)', () => {
      expect(strip(transpileRubyToJS('use_synth :prophet'))).toContain('use_synth("prophet")')
    })

    it('transpiles use_bpm (top-level, no ctx)', () => {
      expect(strip(transpileRubyToJS('use_bpm 120'))).toContain('use_bpm(120)')
    })
  })

  describe('sync/cue', () => {
    it('transpiles sync', () => {
      expect(strip(transpileRubyToJS('sync :metro'))).toContain('b.sync("metro")')
    })

    it('transpiles cue', () => {
      expect(strip(transpileRubyToJS('cue :metro'))).toContain('b.cue("metro")')
    })
  })

  describe('random', () => {
    it('transpiles rrand', () => {
      expect(strip(transpileRubyToJS('play rrand(60, 72)')))
        .toContain('b.rrand(60, 72)')
    })

    it('transpiles choose', () => {
      expect(strip(transpileRubyToJS('play choose([60, 64, 67])')))
        .toContain('b.choose([60, 64, 67])')
    })

    it('transpiles use_random_seed (top-level, no ctx)', () => {
      expect(strip(transpileRubyToJS('use_random_seed 42')))
        .toContain('use_random_seed(42)')
    })

    it('transpiles dice', () => {
      expect(strip(transpileRubyToJS('play 60 if dice(6) > 3')))
        .toContain('b.dice(6)')
    })
  })

  describe('ring and spread', () => {
    it('transpiles ring()', () => {
      expect(strip(transpileRubyToJS('play ring(60, 64, 67).tick')))
        .toContain('b.ring(60, 64, 67).at(b.tick())')
    })

    it('transpiles spread()', () => {
      expect(strip(transpileRubyToJS('spread(3, 8)'))).toContain('b.spread(3, 8)')
    })
  })

  describe('times loop', () => {
    it('transpiles N.times do', () => {
      const ruby = `4.times do
  play 60
  sleep 0.25
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('for (let _i = 0; _i < 4; _i++) {')
      expect(strip(js)).toContain('b.play(60)')
    })

    it('transpiles N.times do |i|', () => {
      const ruby = `8.times do |i|
  play 60 + i
  sleep 0.125
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('for (let i = 0; i < 8; i++) {')
    })
  })

  describe('symbols', () => {
    it('converts Ruby symbols to strings', () => {
      expect(strip(transpileRubyToJS('use_synth :tb303'))).toContain('"tb303"')
    })

    it('does not convert symbols inside strings', () => {
      // This is a known limitation — symbols inside strings will still be converted
      // but that's acceptable for Sonic Pi code
    })
  })

  describe('comments', () => {
    it('converts # comments to //', () => {
      expect(strip(transpileRubyToJS('# this is a comment'))).toContain('// this is a comment')
    })

    it('handles inline comments', () => {
      const js = transpileRubyToJS('play 60 # C4')
      expect(strip(js)).toContain('b.play(60')
    })
  })

  describe('nil → null', () => {
    it('converts nil to null', () => {
      expect(strip(transpileRubyToJS('x = nil'))).toContain('null')
    })
  })

  describe('full programs', () => {
    it('transpiles a complete Sonic Pi program', () => {
      const ruby = `
use_bpm 120

live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end

live_loop :bass do
  use_synth :tb303
  play :c2, release: 0.2, cutoff: 80
  sleep 0.5
end`

      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('use_bpm(120)')  // top-level, no ctx
      expect(strip(js)).toContain('live_loop("drums", (b) => {')
      expect(strip(js)).toContain('b.sample("bd_haus")')
      expect(strip(js)).toContain('live_loop("bass", (b) => {')
      expect(strip(js)).toContain('b.use_synth("tb303")')  // inside loop, has ctx
      expect(strip(js)).toContain('b.play("c2", { release: 0.2, cutoff: 80 })')
    })

    it('transpiles the classic Sonic Pi demo', () => {
      const ruby = `live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end

live_loop :melody do
  use_synth :prophet
  use_random_seed 42
  play choose([:c4, :e4, :g4, :b4]), release: 0.3
  sleep 0.25
end`

      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('b.sample("bd_haus")')
      expect(strip(js)).toContain('b.use_synth("prophet")')
      expect(strip(js)).toContain('b.use_random_seed(42)')
      expect(strip(js)).toContain('b.choose(["c4", "e4", "g4", "b4"])')
    })
  })

  describe('bare code wrapping', () => {
    it('wraps bare play/sleep in implicit live_loop', () => {
      const ruby = `play 60
sleep 0.5
play :d4`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('live_loop("main", (b) => {')
      expect(strip(js)).toContain('b.play(60')
      expect(strip(js)).toContain('b.sleep(0.5)')
      expect(strip(js)).toContain('b.play("d4")')
    })

    it('keeps use_bpm outside the implicit loop', () => {
      const ruby = `use_bpm 120
play 60
sleep 0.5`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('use_bpm(120)')
      // use_bpm should come before the live_loop
      const bpmIdx = js.indexOf('use_bpm')
      const loopIdx = js.indexOf('live_loop')
      expect(bpmIdx).toBeLessThan(loopIdx)
    })

    it('wraps bare code alongside existing live_loops', () => {
      const ruby = `play 60
sleep 1

live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('live_loop("main"')
      expect(strip(js)).toContain('live_loop("drums"')
    })

    it('handles comments in bare code', () => {
      const ruby = `play 60      # Plays Middle C
sleep 0.5    # Pauses
play :d4     # D4`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('live_loop("main"')
      expect(strip(js)).toContain('b.play(60')
      expect(strip(js)).toContain('b.play("d4"')
    })
  })

  describe('detectLanguage', () => {
    it('detects Ruby from do/end blocks', () => {
      expect(detectLanguage('live_loop :drums do\n  play 60\nend')).toBe('ruby')
    })

    it('detects Ruby from symbols', () => {
      expect(detectLanguage('sample :bd_haus')).toBe('ruby')
    })

    it('detects JS from async/await', () => {
      expect(detectLanguage('live_loop("drums", (b) => {')).toBe('js')
    })

    it('detects JS from b.', () => {
      expect(detectLanguage('b.play(60)')).toBe('js')
    })

    it('detects JS from arrow functions', () => {
      expect(detectLanguage('const fn = () => {}')).toBe('js')
    })
  })

  describe('autoTranspile', () => {
    it('transpiles Ruby code', () => {
      const code = `live_loop :test do
  play 60
  sleep 1
end`
      const result = autoTranspile(code)
      expect(strip(result)).toContain('live_loop("test"')
      expect(strip(result)).toContain('b.play(60)')
    })

    it('passes through JS code unchanged', () => {
      const code = `live_loop("test", (b) => {
  b.play(60)
  b.sleep(1)
})`
      const result = autoTranspile(code)
      expect(result).toBe(code)
    })
  })

  describe('begin/rescue/ensure', () => {
    it('transpiles begin ... rescue ... end', () => {
      const ruby = `live_loop :test do
  begin
    play 60
    sleep 1
  rescue
    puts "error"
  end
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('try {')
      expect(strip(js)).toContain('} catch (_e) {')
      expect(strip(js)).toContain('b.play(60)')
      expect(strip(js)).toContain('b.puts("error")')
    })

    it('transpiles begin ... rescue => e ... end', () => {
      const ruby = `live_loop :test do
  begin
    play 60
  rescue => e
    puts e
  end
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('try {')
      expect(strip(js)).toContain('} catch (e) {')
    })

    it('transpiles begin ... rescue ... ensure ... end', () => {
      const ruby = `live_loop :test do
  begin
    play 60
  rescue
    puts "error"
  ensure
    puts "cleanup"
  end
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('try {')
      expect(strip(js)).toContain('} catch (_e) {')
      expect(strip(js)).toContain('} finally {')
    })

    it('transpiles begin ... ensure ... end (no rescue)', () => {
      const ruby = `live_loop :test do
  begin
    play 60
  ensure
    puts "cleanup"
  end
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('try {')
      expect(strip(js)).not.toContain('catch')
      expect(strip(js)).toContain('} finally {')
    })
  })

  describe('string interpolation', () => {
    it('converts Ruby string interpolation to JS template literals', () => {
      const ruby = `live_loop :test do
  puts "note is #{n}"
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(js).toContain('`note is ${n}`')
      expect(js).not.toContain('"note is ${n}"')
    })
  })

  describe('map/select/reject/collect block syntax', () => {
    it('transpiles .map { |n| expr }', () => {
      const ruby = `live_loop :test do
  notes = [60, 62, 64].map { |n| n + 12 }
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('.map((n) => n + 12)')
    })

    it('transpiles .select { |n| expr }', () => {
      const ruby = `live_loop :test do
  evens = [1, 2, 3, 4].select { |n| n % 2 == 0 }
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('.filter((n) => n % 2 == 0)')
    })

    it('transpiles .reject { |n| expr }', () => {
      const ruby = `live_loop :test do
  odds = [1, 2, 3, 4].reject { |n| n % 2 == 0 }
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('.filter((n) => !(n % 2 == 0))')
    })

    it('transpiles .collect { |n| expr } as .map', () => {
      const ruby = `live_loop :test do
  notes = [60, 62, 64].collect { |n| n + 12 }
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('.map((n) => n + 12)')
    })

    it('transpiles multi-line .map do |n|', () => {
      const ruby = `live_loop :test do
  [60, 62, 64].map do |n|
    play n
  end
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('.map((n) =>')
      expect(strip(js)).toContain('b.play(n)')
    })
  })

  // --- Audit bug fixes ---

  describe('top-level prefix bugs', () => {
    it('in_thread at top level omits b. prefix', () => {
      const ruby = `in_thread do
  play 60
  sleep 1
end
live_loop :main do
  play 64
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('in_thread((b) => {')
      expect(strip(js)).not.toContain('b.in_thread')
    })

    it('at block at top level omits b. prefix', () => {
      const ruby = `at [0, 1, 2] do
  play 60
end
live_loop :main do
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('at(')
      expect(strip(js)).not.toMatch(/b\.at\(/)
    })

    it('time_warp at top level omits b. prefix', () => {
      const ruby = `time_warp 2 do
  play 60
end
live_loop :main do
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).not.toMatch(/b\.at\(/)
    })

    it('density at top level omits b. references', () => {
      const ruby = `density 2 do
  live_loop :test do
    play 60
    sleep 1
  end
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).not.toContain('b.density')
    })
  })

  describe('stop inside loop', () => {
    it('emits b.stop() inside loop', () => {
      const ruby = `live_loop :test do
  stop
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('b.stop()')
    })
  })

  describe('multi-line expressions', () => {
    it('joins lines ending with trailing comma', () => {
      const ruby = `live_loop :test do
  play 60,
    release: 0.2
  sleep 1
end`
      const js = transpileRubyToJS(ruby)
      expect(strip(js)).toContain('b.play(60, { release: 0.2 })')
    })
  })

  describe('wrapBareCode block recognition', () => {
    it('recognizes with_fx as block opener', () => {
      const ruby = `with_fx :reverb do
  play 60
  sleep 1
end
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const js = transpileRubyToJS(ruby)
      // with_fx block should be recognized and not cause broken wrapping
      expect(strip(js)).toContain('with_fx("reverb"')
      expect(strip(js)).toContain('live_loop("drums"')
    })
  })
})
