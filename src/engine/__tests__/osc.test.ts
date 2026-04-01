import { describe, it, expect } from 'vitest'
import { encodeSingleBundle, NTP_EPOCH_OFFSET, audioTimeToNTP } from '../osc'

/** Read a null-terminated string from a Uint8Array at given offset. */
function readString(buf: Uint8Array, offset: number): { value: string; end: number } {
  let end = offset
  while (end < buf.length && buf[end] !== 0) end++
  const value = new TextDecoder().decode(buf.slice(offset, end))
  // Advance past null + padding to 4-byte boundary
  const padded = end + 1
  const aligned = (padded + 3) & ~3
  return { value, end: aligned }
}

describe('OSC encoder', () => {
  it('encodes #bundle header', () => {
    const bundle = encodeSingleBundle(1, '/test', [])
    const header = new TextDecoder().decode(bundle.slice(0, 7))
    expect(header).toBe('#bundle')
    expect(bundle[7]).toBe(0) // null terminator
  })

  it('encodes NTP timetag at bytes 8-15', () => {
    const ntpTime = NTP_EPOCH_OFFSET + 123.75 // 123.75 seconds after Unix epoch
    const bundle = encodeSingleBundle(ntpTime, '/test', [])
    const dv = new DataView(bundle.buffer, bundle.byteOffset)

    const secs = dv.getUint32(8, false)
    const frac = dv.getUint32(12, false)

    expect(secs).toBe(Math.floor(ntpTime) >>> 0)
    // 0.75 * 2^32 = 3221225472
    expect(frac).toBe(3221225472)
  })

  it('encodes address string', () => {
    const bundle = encodeSingleBundle(1, '/s_new', [])
    // Message starts at byte 20 (8 header + 8 timetag + 4 size)
    const { value } = readString(bundle, 20)
    expect(value).toBe('/s_new')
  })

  it('encodes type tag string', () => {
    const bundle = encodeSingleBundle(1, '/s_new', ['sonic-pi-beep', 42, 0.5])
    // Address: "/s_new\0\0" = 8 bytes, starts at 20 → type tag at 28
    const { value } = readString(bundle, 28)
    expect(value).toBe(',sif') // string, int, float
  })

  it('encodes string argument', () => {
    const bundle = encodeSingleBundle(1, '/s_new', ['sonic-pi-beep', 1000, 0, 100])
    const text = new TextDecoder().decode(bundle)
    expect(text).toContain('sonic-pi-beep')
  })

  it('encodes int32 argument', () => {
    const bundle = encodeSingleBundle(1, '/test', [42])
    // Find the int after header + timetag + size + address + typetag
    // /test\0\0\0 = 8 bytes (at 20), ,i\0\0 = 4 bytes (at 28), int at 32
    const dv = new DataView(bundle.buffer, bundle.byteOffset)
    expect(dv.getInt32(32, false)).toBe(42)
  })

  it('encodes float32 argument', () => {
    const bundle = encodeSingleBundle(1, '/test', [3.14])
    const dv = new DataView(bundle.buffer, bundle.byteOffset)
    // /test\0\0\0 = 8 bytes (at 20), ,f\0\0 = 4 bytes (at 28), float at 32
    expect(dv.getFloat32(32, false)).toBeCloseTo(3.14, 2)
  })

  it('encodes a full /s_new message', () => {
    const bundle = encodeSingleBundle(
      NTP_EPOCH_OFFSET + 1.0,
      '/s_new',
      ['sonic-pi-beep', 1000, 0, 100, 'note', 60, 'amp', 0.5],
    )

    // Should be valid binary data
    expect(bundle.length).toBeGreaterThan(20)
    // Header check
    expect(new TextDecoder().decode(bundle.slice(0, 7))).toBe('#bundle')
    // Contains both the address and synthdef name
    const text = new TextDecoder().decode(bundle)
    expect(text).toContain('/s_new')
    expect(text).toContain('sonic-pi-beep')
    expect(text).toContain('note')
    expect(text).toContain('amp')
  })

  it('distinguishes int vs float in type tags', () => {
    // Integer args should get 'i', float args 'f'
    const bundle = encodeSingleBundle(1, '/test', [42, 3.14, 0, 1.0])
    // Types: 42=int, 3.14=float, 0=int, 1.0=float (1.0 is NOT integer in JS)
    // Actually Number.isInteger(1.0) === true, so it'll be 'i'
    // and Number.isInteger(0) === true, so 'i'
    const { value } = readString(bundle, 20 + 8) // after "/test\0\0\0" (8 bytes)
    expect(value).toBe(',ifii') // 42=i, 3.14=f, 0=i, 1.0=i (JS quirk)
  })
})

describe('audioTimeToNTP', () => {
  it('returns NTP time in reasonable range', () => {
    const ntp = audioTimeToNTP(1.0, 0.5)
    // Should be current wall time + 0.5s offset + NTP epoch
    const expectedApprox = Date.now() / 1000 + NTP_EPOCH_OFFSET + 0.5
    expect(ntp).toBeCloseTo(expectedApprox, 0) // within 1 second
  })

  it('future audioTime produces higher NTP than past', () => {
    const ntp1 = audioTimeToNTP(1.0, 1.0) // now
    const ntp2 = audioTimeToNTP(2.0, 1.0) // 1s in future
    expect(ntp2 - ntp1).toBeCloseTo(1.0, 2)
  })
})
