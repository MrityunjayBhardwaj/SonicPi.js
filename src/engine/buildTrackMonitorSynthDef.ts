/**
 * Builds the `sonic_pi_track_monitor` SynthDef binary (SCgf v1 format).
 *
 * This is a hand-compiled SynthDef — no sclang needed. The graph is
 * trivial enough that building the binary in JS is straightforward:
 *
 *   arg in_bus=0, out_bus_master=0, out_bus_track=0, amp=1;
 *   var sig = In.ar(in_bus, 2);
 *   Out.ar(out_bus_master, sig * amp);
 *   Out.ar(out_bus_track, sig * amp);
 *
 * The monitor reads stereo audio from an internal scsynth bus (loopBus),
 * multiplies by amp, and writes to TWO output buses:
 *   - out_bus_master (bus 0) → mixer chain → speakers
 *   - out_bus_track (output channel 2+) → AudioWorklet → AnalyserNode
 *
 * This eliminates the need to compile the SynthDef with Desktop
 * SuperCollider or upload it to the SuperSonic CDN. Load via /d_recv
 * at session startup.
 *
 * SCgf v1 format reference:
 *   https://doc.sccode.org/Reference/Synth-Definition-File-Format.html
 *
 * UGen graph (6 nodes):
 *   0: Control (kr, 0 in, 4 out)  → in_bus, out_bus_master, out_bus_track, amp
 *   1: In      (ar, 1 in, 2 out)  → reads stereo from in_bus
 *   2: BinaryOpUGen (ar, *, 2 in, 1 out) → In.L * amp
 *   3: BinaryOpUGen (ar, *, 2 in, 1 out) → In.R * amp
 *   4: Out     (ar, 3 in, 0 out)  → out_bus_master, scaled_L, scaled_R
 *   5: Out     (ar, 3 in, 0 out)  → out_bus_track, scaled_L, scaled_R
 */

const RATE_SCALAR = 0
const RATE_CONTROL = 1
const RATE_AUDIO = 2

const BINOP_MULTIPLY = 2

/** Write a Pascal-style string (1-byte length prefix + ASCII bytes). */
function writePstring(view: DataView, offset: number, s: string): number {
  view.setUint8(offset, s.length)
  offset += 1
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i))
  }
  return offset + s.length
}

/** Write a UGen spec and return the new offset. */
function writeUGen(
  view: DataView,
  offset: number,
  name: string,
  rate: number,
  inputs: Array<[number, number]>,  // [ugenIndex, outputIndex] pairs
  numOutputs: number,
  outputRate: number,
  special: number = 0,
): number {
  offset = writePstring(view, offset, name)
  view.setInt8(offset, rate);                    offset += 1
  view.setInt16(offset, inputs.length, false);   offset += 2  // BE
  view.setInt16(offset, numOutputs, false);      offset += 2
  view.setInt16(offset, special, false);         offset += 2

  for (const [ugenIdx, outIdx] of inputs) {
    view.setInt16(offset, ugenIdx, false);       offset += 2
    view.setInt16(offset, outIdx, false);        offset += 2
  }

  for (let i = 0; i < numOutputs; i++) {
    view.setInt8(offset, outputRate);            offset += 1
  }

  return offset
}

/** Write a named parameter entry and return the new offset. */
function writeParamName(
  view: DataView,
  offset: number,
  name: string,
  index: number,
): number {
  offset = writePstring(view, offset, name)
  view.setInt16(offset, index, false)
  return offset + 2
}

/**
 * Build the complete `sonic_pi_track_monitor` SynthDef as a Uint8Array.
 *
 * Returns bytes suitable for `/d_recv`:
 *   bridge.send('/d_recv', buildTrackMonitorSynthDef())
 */
export function buildTrackMonitorSynthDef(): Uint8Array {
  // Pre-calculate exact size to avoid over-allocation.
  //
  // Header:       4 (magic) + 4 (version) + 2 (count) = 10
  // Name:         1 + 22 = 23  ("sonic_pi_track_monitor")
  // Constants:    2 (count=0)
  // Params:       2 (count=4) + 4*4 (defaults) = 18
  // Param names:  2 (count=4) + (1+6+2) + (1+14+2) + (1+13+2) + (1+3+2) = 2 + 9+17+16+6 = 50
  // UGens header: 2 (count=6)
  //   UGen 0 (Control):      1+7 + 1 + 2+2+2 + 0 + 4 = 19
  //   UGen 1 (In):           1+2 + 1 + 2+2+2 + 1*4 + 2 = 16
  //   UGen 2 (BinaryOpUGen): 1+12 + 1 + 2+2+2 + 2*4 + 1 = 29
  //   UGen 3 (BinaryOpUGen): 1+12 + 1 + 2+2+2 + 2*4 + 1 = 29
  //   UGen 4 (Out):          1+3 + 1 + 2+2+2 + 3*4 + 0 = 23
  //   UGen 5 (Out):          1+3 + 1 + 2+2+2 + 3*4 + 0 = 23
  // Variants:     2 (count=0)
  //
  // Total: 10 + 23 + 2 + 18 + 50 + 2 + 19+16+29+29+23+23 + 2 = 246

  const buf = new ArrayBuffer(246)
  const view = new DataView(buf)
  let o = 0

  // ── File header ──────────────────────────────────────────────
  // Magic: "SCgf"
  view.setUint8(o, 0x53); o += 1  // S
  view.setUint8(o, 0x43); o += 1  // C
  view.setUint8(o, 0x67); o += 1  // g
  view.setUint8(o, 0x66); o += 1  // f
  // Version: 1
  view.setInt32(o, 1, false); o += 4
  // Number of SynthDefs: 1
  view.setInt16(o, 1, false); o += 2

  // ── SynthDef name ────────────────────────────────────────────
  o = writePstring(view, o, 'sonic_pi_track_monitor')

  // ── Constants ────────────────────────────────────────────────
  view.setInt16(o, 0, false); o += 2  // 0 constants

  // ── Parameters ───────────────────────────────────────────────
  view.setInt16(o, 4, false); o += 2  // 4 params
  // Initial values (float32 BE)
  view.setFloat32(o, 0.0, false); o += 4  // in_bus = 0
  view.setFloat32(o, 0.0, false); o += 4  // out_bus_master = 0
  view.setFloat32(o, 0.0, false); o += 4  // out_bus_track = 0
  view.setFloat32(o, 1.0, false); o += 4  // amp = 1

  // ── Parameter names ──────────────────────────────────────────
  view.setInt16(o, 4, false); o += 2  // 4 param names
  o = writeParamName(view, o, 'in_bus', 0)
  o = writeParamName(view, o, 'out_bus_master', 1)
  o = writeParamName(view, o, 'out_bus_track', 2)
  o = writeParamName(view, o, 'amp', 3)

  // ── UGens ────────────────────────────────────────────────────
  view.setInt16(o, 6, false); o += 2  // 6 UGens

  // UGen 0: Control (kr, 0 inputs, 4 outputs)
  // Outputs the 4 named parameters at control rate.
  o = writeUGen(view, o, 'Control', RATE_CONTROL,
    [],                // no inputs
    4, RATE_CONTROL)   // 4 outputs, all kr

  // UGen 1: In (ar, 1 input, 2 outputs)
  // Reads stereo audio from in_bus.
  o = writeUGen(view, o, 'In', RATE_AUDIO,
    [[0, 0]],          // input: Control.in_bus
    2, RATE_AUDIO)     // 2 outputs (stereo), ar

  // UGen 2: BinaryOpUGen * (ar, 2 inputs, 1 output)
  // Left channel × amp
  o = writeUGen(view, o, 'BinaryOpUGen', RATE_AUDIO,
    [[1, 0], [0, 3]],  // In.L, Control.amp
    1, RATE_AUDIO,
    BINOP_MULTIPLY)

  // UGen 3: BinaryOpUGen * (ar, 2 inputs, 1 output)
  // Right channel × amp
  o = writeUGen(view, o, 'BinaryOpUGen', RATE_AUDIO,
    [[1, 1], [0, 3]],  // In.R, Control.amp
    1, RATE_AUDIO,
    BINOP_MULTIPLY)

  // UGen 4: Out (ar, 3 inputs, 0 outputs)
  // Write scaled stereo to master bus.
  o = writeUGen(view, o, 'Out', RATE_AUDIO,
    [[0, 1], [2, 0], [3, 0]],  // Control.out_bus_master, scaled_L, scaled_R
    0, RATE_AUDIO)

  // UGen 5: Out (ar, 3 inputs, 0 outputs)
  // Write scaled stereo to track bus (per-loop AnalyserNode tap).
  o = writeUGen(view, o, 'Out', RATE_AUDIO,
    [[0, 2], [2, 0], [3, 0]],  // Control.out_bus_track, scaled_L, scaled_R
    0, RATE_AUDIO)

  // ── Variants ─────────────────────────────────────────────────
  view.setInt16(o, 0, false); o += 2  // 0 variants

  // Sanity check — we should have used exactly 250 bytes.
  if (o !== 246) {
    throw new Error(
      `SynthDef binary size mismatch: wrote ${o} bytes, expected 246. ` +
      `This is a bug in buildTrackMonitorSynthDef().`
    )
  }

  return new Uint8Array(buf)
}
