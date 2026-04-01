/**
 * Minimal OSC bundle encoder — fallback when SuperSonic.osc is unavailable.
 *
 * OSC binary format: 4-byte aligned strings, int32/float32 in big-endian,
 * bundles prefixed with "#bundle\0" + 8-byte NTP timetag.
 */

/** NTP epoch offset: seconds between 1900-01-01 and 1970-01-01. */
export const NTP_EPOCH_OFFSET = 2208988800

/**
 * Convert AudioContext seconds to NTP timestamp (seconds since 1900-01-01).
 * Uses performance.timeOrigin for wall-clock anchor.
 */
export function audioTimeToNTP(
  audioTime: number,
  audioCtxCurrentTime: number,
): number {
  const wallNow = (performance.timeOrigin + performance.now()) / 1000
  const delta = audioTime - audioCtxCurrentTime
  return wallNow + delta + NTP_EPOCH_OFFSET
}

/** Pad length to next 4-byte boundary. */
function pad4(n: number): number {
  return (n + 3) & ~3
}

/** Write a null-terminated, 4-byte-padded string into DataView. Returns new offset. */
function writeString(dv: DataView, off: number, s: string): number {
  const start = off
  for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i))
  // Null terminator + pad to 4-byte boundary
  const end = start + pad4(s.length + 1)
  while (off < end) dv.setUint8(off++, 0)
  return off
}

/**
 * Encode a single OSC message inside an OSC bundle with an NTP timetag.
 *
 * Matches SuperSonic.osc.encodeSingleBundle(timetag, address, args) signature.
 */
export function encodeSingleBundle(
  ntpTime: number,
  address: string,
  args: (string | number)[],
): Uint8Array {
  const buf = new ArrayBuffer(4096)
  const dv = new DataView(buf)
  let off = 0

  // "#bundle\0" (8 bytes)
  const tag = '#bundle\0'
  for (let i = 0; i < 8; i++) dv.setUint8(off++, tag.charCodeAt(i))

  // NTP timetag: 32-bit seconds + 32-bit fraction (big-endian)
  const secs = Math.floor(ntpTime) >>> 0
  const frac = ((ntpTime - Math.floor(ntpTime)) * 0x100000000) >>> 0
  dv.setUint32(off, secs, false); off += 4
  dv.setUint32(off, frac, false); off += 4

  // Element size placeholder (fill after encoding message)
  const sizeOff = off; off += 4
  const msgStart = off

  // Address
  off = writeString(dv, off, address)

  // Type tag string
  let types = ','
  for (const a of args) types += typeof a === 'string' ? 's' : (Number.isInteger(a) ? 'i' : 'f')
  off = writeString(dv, off, types)

  // Arguments
  for (const a of args) {
    if (typeof a === 'string') {
      off = writeString(dv, off, a)
    } else if (Number.isInteger(a)) {
      dv.setInt32(off, a, false); off += 4
    } else {
      dv.setFloat32(off, a, false); off += 4
    }
  }

  // Fill element size
  dv.setUint32(sizeOff, off - msgStart, false)

  return new Uint8Array(buf, 0, off)
}

/**
 * Encode an OSC message (without bundle wrapping).
 * Returns the raw message bytes for embedding in a multi-message bundle.
 */
export function encodeMessage(
  address: string,
  args: (string | number)[],
): Uint8Array {
  const buf = new ArrayBuffer(4096)
  const dv = new DataView(buf)
  let off = 0

  off = writeString(dv, off, address)

  let types = ','
  for (const a of args) types += typeof a === 'string' ? 's' : (Number.isInteger(a) ? 'i' : 'f')
  off = writeString(dv, off, types)

  for (const a of args) {
    if (typeof a === 'string') {
      off = writeString(dv, off, a)
    } else if (Number.isInteger(a)) {
      dv.setInt32(off, a, false); off += 4
    } else {
      dv.setFloat32(off, a, false); off += 4
    }
  }

  return new Uint8Array(buf, 0, off)
}

/**
 * Encode multiple OSC messages into a single bundle with one NTP timetag.
 * This is how Sonic Pi dispatches — all events between sleeps share one timestamp.
 */
export function encodeBundle(
  ntpTime: number,
  messages: Array<{ address: string; args: (string | number)[] }>,
): Uint8Array {
  const buf = new ArrayBuffer(65536) // large enough for many messages
  const dv = new DataView(buf)
  let off = 0

  // "#bundle\0"
  const tag = '#bundle\0'
  for (let i = 0; i < 8; i++) dv.setUint8(off++, tag.charCodeAt(i))

  // NTP timetag
  const secs = Math.floor(ntpTime) >>> 0
  const frac = ((ntpTime - Math.floor(ntpTime)) * 0x100000000) >>> 0
  dv.setUint32(off, secs, false); off += 4
  dv.setUint32(off, frac, false); off += 4

  // Each message: 4-byte size prefix + message bytes
  for (const msg of messages) {
    const msgBytes = encodeMessage(msg.address, msg.args)
    dv.setUint32(off, msgBytes.length, false); off += 4
    new Uint8Array(buf, off, msgBytes.length).set(msgBytes)
    off += msgBytes.length
  }

  return new Uint8Array(buf, 0, off)
}
