/**
 * RandStream — decode Sonic Pi's frozen random-number stream (EPIC #531, Phase 1).
 *
 * Desktop Sonic Pi does NOT generate random numbers with a live PRNG. At boot it
 * loads a fixed table of 441,000 values from `etc/buffers/rand-stream.wav` and
 * `SPRand` indexes into it (`app/server/ruby/core.rb`, class SPRand,
 * `wav_from_buffer_file` + `rand_peek`). The stream is identical across every
 * install and is reset each Run — which is why a piece using `rand`/`choose`/
 * `shuffle` sounds the same on everyone's machine. To match desktop note-for-note
 * we ship the SAME wav and index it the SAME way (GROUND_TRUTH_DESKTOP_SP_PRNG).
 *
 * Desktop reads the wav as `WaveFile::Format.new(:mono, :float, 44100)`. The wav
 * on disk is mono 16-bit PCM, and WaveFile's pcm_16→float conversion is
 * `sample / 32768`, yielding values in [0, 1). We replicate exactly that: parse
 * the RIFF `data` chunk, read signed 16-bit little-endian samples, divide by
 * 32768. Verified: table[1..4] == the golden `rand` values asserted in desktop's
 * `test/lang/core/test_random.rb` (0.75006103515625, 0.733917236328125,
 * 0.464202880859375, 0.24249267578125).
 */

/** The frozen stream length desktop hard-codes (`rand_peek`'s `% 441000`). */
export const RAND_STREAM_LENGTH = 441000

/** Divisor for WaveFile's pcm_16 → float conversion (signed 16-bit full scale). */
const PCM16_FULL_SCALE = 32768

const RIFF = 0x52494646 // 'RIFF'
const WAVE = 0x57415645 // 'WAVE'
const DATA = 0x64617461 // 'data'

/**
 * Decode a rand-stream wav (mono 16-bit PCM) into the 441,000-value table
 * `SPRand` indexes. Returns a `Float64Array` of `RAND_STREAM_LENGTH` values in
 * [0, 1), each `sampleInt16 / 32768`.
 *
 * Parses RIFF chunks to find `data` (rather than assuming a 44-byte header) so it
 * is robust to extra chunks. Throws on a non-RIFF/WAVE buffer or a missing `data`
 * chunk — a corrupt table must fail loudly, never silently mis-seed the stream.
 */
export function decodeRandStream(bytes: ArrayBuffer | Uint8Array): Float64Array {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)

  if (u8.byteLength < 12 || dv.getUint32(0, false) !== RIFF || dv.getUint32(8, false) !== WAVE) {
    throw new Error('RandStream: not a RIFF/WAVE buffer')
  }

  // Walk chunks from offset 12 to find `data`.
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= u8.byteLength) {
    const id = dv.getUint32(off, false)
    const size = dv.getUint32(off + 4, true)
    if (id === DATA) {
      dataOff = off + 8
      dataLen = size
      break
    }
    off += 8 + size + (size & 1) // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error('RandStream: no data chunk')

  const available = Math.min(RAND_STREAM_LENGTH, dataLen >> 1) // 2 bytes/sample
  const table = new Float64Array(RAND_STREAM_LENGTH)
  for (let i = 0; i < available; i++) {
    table[i] = dv.getInt16(dataOff + i * 2, true) / PCM16_FULL_SCALE
  }
  return table
}
