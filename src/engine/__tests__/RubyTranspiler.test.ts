import { describe, it, expect } from 'vitest'
import { detectLanguage, autoTranspile, autoTranspileDetailed } from '../RubyTranspiler'

/**
 * Tests for the RubyTranspiler public API.
 *
 * Transpilation correctness is covered by TreeSitterTranspiler.test.ts (69 tests)
 * and RealWorldTreeSitter.test.ts (6 tests). This file tests language detection,
 * bare code wrapping, and the autoTranspile entry points.
 */
describe('RubyTranspiler', () => {
  describe('detectLanguage', () => {
    it('detects Ruby from do/end blocks', () => {
      expect(detectLanguage('live_loop :test do\n  play 60\nend')).toBe('ruby')
    })

    it('detects Ruby from symbols', () => {
      expect(detectLanguage('sample :bd_haus')).toBe('ruby')
    })

    it('detects JS from async/await', () => {
      expect(detectLanguage('async function foo() {}')).toBe('js')
    })

    it('detects JS from b. prefix', () => {
      expect(detectLanguage('b.play(60)')).toBe('js')
    })

    it('detects JS from arrow functions', () => {
      expect(detectLanguage('const f = () => 42')).toBe('js')
    })

    it('defaults to ruby', () => {
      expect(detectLanguage('play 60')).toBe('ruby')
    })
  })

  describe('autoTranspile', () => {
    it('transpiles Ruby code and returns a string', () => {
      const ruby = `live_loop :test do
  play 60
  sleep 1
end`
      const js = autoTranspile(ruby)
      expect(js).toContain('live_loop')
      expect(js).toContain('b.play')
      expect(js).toContain('b.sleep')
    })

    it('passes through JS code unchanged', () => {
      const js = `live_loop("test", (b) => {
  b.play(60)
  b.sleep(1)
})`
      expect(autoTranspile(js)).toBe(js)
    })
  })

  describe('autoTranspileDetailed', () => {
    it('passes through JS code with usedFallback: false', () => {
      const code = `live_loop("test", (b) => {
  b.play(60)
  b.sleep(1)
})`
      const result = autoTranspileDetailed(code)
      expect(result.code).toBe(code)
      expect(result.usedFallback).toBe(false)
    })

    it('returns method: tree-sitter for Ruby code', () => {
      const code = `live_loop :test do
  play 60
  sleep 1
end`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      expect(result.method).toBe('tree-sitter')
    })

    it('TreeSitter handles splat operator without fallback', () => {
      const code = `live_loop :test do
  notes = [*ring(:c4, :e4, :g4)]
  play notes.tick
  sleep 0.25
end`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      expect(result.code).toBeTruthy()
    })
  })

  describe('bare code wrapping', () => {
    it('wraps bare play/sleep in implicit live_loop', () => {
      const code = `play 60\nsleep 1`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      expect(result.code).toContain('__run_once')
    })

    it('keeps use_bpm outside the implicit loop', () => {
      const code = `use_bpm 120\nplay 60\nsleep 1`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      // use_bpm should be at top level, not inside the wrapped loop
      expect(result.code).toContain('use_bpm')
    })

    it('wraps bare code alongside existing live_loops', () => {
      const code = `play 60
sleep 1
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      expect(result.code).toContain('__run_once')
      expect(result.code).toContain('live_loop("drums"')
    })

    it('does not wrap code that has no bare DSL calls', () => {
      const code = `live_loop :test do
  play 60
  sleep 1
end`
      const result = autoTranspileDetailed(code)
      expect(result.usedFallback).toBe(false)
      expect(result.code).not.toContain('__run_once')
    })
  })
})
