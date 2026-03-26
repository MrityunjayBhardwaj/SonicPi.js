import { describe, it, expect } from 'vitest'
import { friendlyError, formatFriendlyError, KNOWN_FX, KNOWN_SYNTHS } from '../FriendlyErrors'
import { getSynthParams, getFxParams, SYNTH_PARAMS, FX_PARAMS } from '../SynthParams'

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

  it('wraps unknown parameter errors with suggestions', () => {
    const err = new Error('unknown param: cuutoff for synth: tb303')
    const fe = friendlyError(err)
    expect(fe.title).toContain('cuutoff')
    expect(fe.title).toContain('tb303')
    expect(fe.message).toContain('cutoff') // suggests closest match
  })

  it('wraps unknown FX parameter errors', () => {
    const err = new Error('unknown param: rooom for fx: reverb')
    const fe = friendlyError(err)
    expect(fe.title).toContain('rooom')
    expect(fe.title).toContain('FX')
    expect(fe.message).toContain('room')
  })

  it('preserves original error reference', () => {
    const err = new Error('test')
    const fe = friendlyError(err)
    expect(fe.original).toBe(err)
  })
})

describe('SynthParams', () => {
  it('getSynthParams for beep returns common params', () => {
    const params = getSynthParams('beep')
    expect(params).toContain('note')
    expect(params).toContain('amp')
    expect(params).toContain('attack')
    expect(params).toContain('release')
    expect(params).toContain('cutoff')
  })

  it('getSynthParams for tb303 includes wave and cutoff', () => {
    const params = getSynthParams('tb303')
    expect(params).toContain('cutoff')
    expect(params).toContain('wave')
    expect(params).toContain('pulse_width')
  })

  it('getSynthParams for pluck includes pluck-specific params', () => {
    const params = getSynthParams('pluck')
    expect(params).toContain('noise_amp')
    expect(params).toContain('pluck_decay')
    expect(params).toContain('max_delay_time')
  })

  it('getFxParams for reverb includes room and damp', () => {
    const params = getFxParams('reverb')
    expect(params).toContain('room')
    expect(params).toContain('damp')
    expect(params).toContain('mix') // from common
  })

  it('getFxParams for echo includes phase and decay', () => {
    const params = getFxParams('echo')
    expect(params).toContain('phase')
    expect(params).toContain('decay')
    expect(params).toContain('amp') // from common
  })

  it('SYNTH_PARAMS covers all KNOWN_SYNTHS', () => {
    for (const synth of KNOWN_SYNTHS) {
      expect(SYNTH_PARAMS).toHaveProperty(synth)
    }
  })

  it('FX_PARAMS covers all KNOWN_FX', () => {
    for (const fx of KNOWN_FX) {
      expect(FX_PARAMS).toHaveProperty(fx)
    }
  })

  it('returns common params for unknown synth', () => {
    const params = getSynthParams('nonexistent')
    // Should still return common params
    expect(params).toContain('note')
    expect(params).toContain('amp')
  })
})
