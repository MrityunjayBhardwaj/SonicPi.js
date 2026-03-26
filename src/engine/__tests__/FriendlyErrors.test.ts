import { describe, it, expect } from 'vitest'
import { friendlyError, formatFriendlyError, KNOWN_FX } from '../FriendlyErrors'

describe('FriendlyErrors', () => {
  it('wraps unknown synth errors with suggestions', () => {
    const err = new Error('loadSynthDef failed for synth: sonic-pi-bep')
    const fe = friendlyError(err)
    expect(fe.title).toContain('bep')
    expect(fe.message).toContain('beep') // suggests closest match
  })

  it('wraps unknown sample errors', () => {
    const err = new Error('sample bd_hous.flac not found')
    const fe = friendlyError(err)
    expect(fe.title).toContain('bd_hous')
    expect(fe.message).toContain('bd_haus') // suggests closest match
  })

  it('wraps not-initialized errors', () => {
    const err = new Error('SonicPiEngine not initialized — call init() first')
    const fe = friendlyError(err)
    expect(fe.title).toBe('Engine not ready')
    expect(fe.message).toContain('init()')
  })

  it('wraps is-not-a-function errors', () => {
    const err = new Error('foo is not a function')
    const fe = friendlyError(err)
    expect(fe.title).toContain('foo')
    expect(fe.message).toContain('Typo')
  })

  it('wraps undefined variable errors', () => {
    const err = new Error('c4 is not defined')
    const fe = friendlyError(err)
    expect(fe.title).toContain('c4')
    expect(fe.message).toContain('string')
  })

  it('wraps syntax errors', () => {
    const err = new Error('SyntaxError: Unexpected token }')
    const fe = friendlyError(err)
    expect(fe.title).toBe('Syntax error')
    expect(fe.message).toContain('bracket')
  })

  it('wraps unknown task errors', () => {
    const err = new Error('Unknown task: drums')
    const fe = friendlyError(err)
    expect(fe.title).toContain('drums')
    expect(fe.message).toContain('live_loop')
  })

  it('wraps unknown FX errors with suggestions', () => {
    const err = new Error('loadSynthDef failed: sonic-pi-fx_reverbb not found')
    const fe = friendlyError(err)
    expect(fe.title).toContain('reverbb')
    expect(fe.message).toContain('reverb') // suggests closest match
  })

  it('wraps unknown FX errors without close match', () => {
    const err = new Error('unknown fx: zzzzzznotreal')
    const fe = friendlyError(err)
    expect(fe.title).toContain('zzzzzznotreal')
    expect(fe.message).toContain('Available FX include')
  })

  it('exports KNOWN_FX as a non-empty list', () => {
    expect(Array.isArray(KNOWN_FX)).toBe(true)
    expect(KNOWN_FX.length).toBeGreaterThan(0)
    expect(KNOWN_FX).toContain('reverb')
  })

  it('falls back gracefully for unrecognized errors', () => {
    const err = new Error('something completely unexpected happened')
    const fe = friendlyError(err)
    expect(fe.title).toBe('Something went wrong')
    expect(fe.message).toContain('something completely unexpected')
  })

  it('formats errors for display', () => {
    const err = new Error('SonicPiEngine not initialized — call init() first')
    const formatted = formatFriendlyError(friendlyError(err))
    expect(formatted).toContain('Engine not ready')
    expect(formatted).toContain('──')
  })

  it('preserves original error reference', () => {
    const err = new Error('test')
    const fe = friendlyError(err)
    expect(fe.original).toBe(err)
  })
})
