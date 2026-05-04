/**
 * Desktop Sonic Pi capture tool — sends Ruby code to the running Sonic Pi.app
 * via OSC, captures the resulting WAV, and writes a report alongside the
 * existing browser-side captures (.captures/) for A/B comparison.
 *
 * Mirrors the surface of tools/capture.ts so the e2e parity workflow can run
 * desktop ↔ web side-by-side. This is an OBSERVATION tool, not a test.
 *
 * Usage:
 *   npx tsx tools/capture-desktop.ts                          # default snippet
 *   npx tsx tools/capture-desktop.ts "play 60; sleep 1"       # inline code
 *   npx tsx tools/capture-desktop.ts --file path/to/code.rb   # from file
 *   npx tsx tools/capture-desktop.ts --duration 12000         # 12 seconds
 *   npx tsx tools/capture-desktop.ts --name minimal_techno    # custom report name
 *
 * Prereqs:
 *   1. Sonic Pi.app must be running. If not: `open -a "Sonic Pi"` and wait
 *      for boot (~10s) before running this tool.
 *   2. The tool discovers the running instance's OSC ports and auth token
 *      from the live `spider-server.rb` process args via `ps`.
 *
 * Wire format:
 *   /run-code is a Sonic Pi internal OSC endpoint with type tag `,is` —
 *   int (the auth token printed by the daemon at boot) then string (the
 *   user's code). Token is a signed 32-bit integer that rotates per boot.
 *   /stop-all-jobs takes the token alone (`,i`).
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { createSocket, type Socket } from 'dgram'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const RECORDINGS_DIR = resolve(__dirname, '../.captures/desktop-recordings')
const DEFAULT_DURATION = 8000

// ---------------------------------------------------------------------------
// Port + token discovery
// ---------------------------------------------------------------------------

interface DesktopPorts {
  guiSendToSpider: number  // we send /run-code here
  guiListenToSpider: number // spider replies here (we don't currently parse replies)
  token: number
}

function discoverPorts(): DesktopPorts {
  let psOutput: string
  try {
    psOutput = execSync('ps -axo args', { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`ps failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // The daemon spawns ruby with positional args:
  //   spider-server.rb -u GUI_SEND_TO_SPIDER GUI_LISTEN_TO_SPIDER SCSYNTH SCSYNTH_SEND OSC_CUES TAU SPIDER_LISTEN_TO_TAU TOKEN
  // (8 args total after -u; ports are listed in daemon.log under "Selected ports".)
  const m = psOutput.match(
    /spider-server\.rb\s+-u\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)/,
  )
  if (!m) {
    throw new Error(
      'Sonic Pi is not running (no spider-server.rb process found).\n' +
      '→ Run `open -a "Sonic Pi"` and wait ~10 seconds for it to boot.',
    )
  }
  return {
    guiSendToSpider: parseInt(m[1], 10),
    guiListenToSpider: parseInt(m[2], 10),
    token: parseInt(m[8], 10),
  }
}

// ---------------------------------------------------------------------------
// Minimal OSC 1.0 encoder (no dependency)
// ---------------------------------------------------------------------------

function pad4(buf: Buffer): Buffer {
  const padLen = (4 - (buf.length % 4)) % 4
  return padLen === 0 ? buf : Buffer.concat([buf, Buffer.alloc(padLen)])
}

function oscString(s: string): Buffer {
  return pad4(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]))
}

function oscInt32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n)
  return b
}

function oscMessage(addr: string, typeTag: string, args: Array<string | number>): Buffer {
  const parts: Buffer[] = [oscString(addr), oscString(',' + typeTag)]
  for (let i = 0; i < typeTag.length; i++) {
    const t = typeTag[i]
    if (t === 's') parts.push(oscString(String(args[i])))
    else if (t === 'i') parts.push(oscInt32(args[i] as number))
    else throw new Error(`Unsupported OSC type tag: ${t}`)
  }
  return Buffer.concat(parts)
}

async function sendUdp(host: string, port: number, packet: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createSocket('udp4')
    sock.send(packet, port, host, (err) => {
      sock.close()
      err ? reject(err) : resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// WAV stats — same shape as tools/capture.ts (PCM 16-bit interleaved)
// ---------------------------------------------------------------------------

interface AudioStats {
  duration: number
  peak: number
  rms: number
  clipping: number
  sampleRate: number
  channels: number
}

function analyzeWav(path: string): AudioStats | null {
  try {
    const buf = readFileSync(path)
    const sampleRate = buf.readUInt32LE(24)
    const bitsPerSample = buf.readUInt16LE(34)
    const channels = buf.readUInt16LE(22)
    const dataOffset = 44
    const bytesPerSample = bitsPerSample / 8
    const numSamples = Math.floor((buf.length - dataOffset) / (channels * bytesPerSample))
    let sumSq = 0
    let peak = 0
    let clipCount = 0
    for (let i = 0; i < numSamples; i++) {
      const off = dataOffset + i * channels * bytesPerSample
      const val = buf.readInt16LE(off) / 32768.0
      sumSq += val * val
      const a = Math.abs(val)
      if (a > peak) peak = a
      if (a > 0.95) clipCount++
    }
    const rms = Math.sqrt(sumSq / numSamples)
    return {
      duration: numSamples / sampleRate,
      peak: Math.round(peak * 10000) / 10000,
      rms: Math.round(rms * 10000) / 10000,
      clipping: Math.round((clipCount / numSamples) * 10000) / 100,
      sampleRate,
      channels,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Capture flow
// ---------------------------------------------------------------------------

interface DesktopCaptureResult {
  timestamp: string
  code: string
  duration: number
  reportPath: string
  audioPath: string | null
  audioStats: AudioStats | null
  ports: DesktopPorts
  notes: string[]
}

async function runDesktopCapture(
  code: string,
  opts: { duration?: number; name?: string } = {},
): Promise<DesktopCaptureResult> {
  const duration = opts.duration ?? DEFAULT_DURATION
  const name = opts.name ?? 'capture'
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = `desktop_${ts}_${safeName}`

  mkdirSync(CAPTURES_DIR, { recursive: true })
  mkdirSync(RECORDINGS_DIR, { recursive: true })
  const audioPath = resolve(RECORDINGS_DIR, `${prefix}.wav`)
  const reportPath = resolve(CAPTURES_DIR, `${prefix}.md`)

  const ports = discoverPorts()
  const notes: string[] = []

  // Wrap the user's code with a recording-controller in_thread so it survives
  // alongside whatever live_loops the user declared. The thread sleeps the
  // capture window in REAL time (not bpm-scaled) via `rt(N)`-equivalent: we
  // just send a literal sleep at default 60 BPM, where 1 beat == 1 second.
  // After recording_stop we save to the absolute path. The user's loops keep
  // running; /stop-all-jobs below tears them down.
  const durationSec = duration / 1000.0
  const wrapped =
    `recording_start\n` +
    `in_thread do\n` +
    `  sleep ${durationSec}\n` +
    `  recording_stop\n` +
    `  recording_save "${audioPath}"\n` +
    `end\n` +
    `\n` +
    code

  // /run-code wire format: [token as int, code as string].
  const runPacket = oscMessage('/run-code', 'is', [ports.token, wrapped])
  await sendUdp('127.0.0.1', ports.guiSendToSpider, runPacket)
  notes.push(`sent /run-code to 127.0.0.1:${ports.guiSendToSpider} (token ${ports.token})`)

  // Wait the capture window + ~2.5s for recording_save to flush WAV to disk.
  await new Promise((r) => setTimeout(r, duration + 2500))

  // Tear down user's code and the recording thread cleanly.
  const stopPacket = oscMessage('/stop-all-jobs', 'i', [ports.token])
  await sendUdp('127.0.0.1', ports.guiSendToSpider, stopPacket)
  notes.push(`sent /stop-all-jobs`)

  // Give the file system a moment to settle, then check the WAV.
  await new Promise((r) => setTimeout(r, 500))
  let audioStats: AudioStats | null = null
  if (existsSync(audioPath)) {
    const sz = statSync(audioPath).size
    if (sz > 44) audioStats = analyzeWav(audioPath)
    else notes.push(`WAV exists at ${audioPath} but is empty (${sz} bytes)`)
  } else {
    notes.push(
      `Recording not produced at ${audioPath}. Likely causes:\n` +
      `  • Sonic Pi rejected the code — check ~/.sonic-pi/log/spider.log\n` +
      `  • duration too short for recording to flush\n` +
      `  • a syntax/runtime error in the user code`,
    )
  }

  return {
    timestamp: new Date().toISOString(),
    code,
    duration,
    reportPath,
    audioPath: audioStats ? audioPath : null,
    audioStats,
    ports,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Report writer (matches tools/capture.ts feel)
// ---------------------------------------------------------------------------

function writeReport(r: DesktopCaptureResult): void {
  const lines: string[] = []
  lines.push(`# Desktop Sonic Pi Capture: ${r.timestamp}`)
  lines.push('')
  lines.push(`- **Duration window:** ${r.duration} ms`)
  lines.push(`- **Spider port:** ${r.ports.guiSendToSpider} (token ${r.ports.token})`)
  lines.push('')

  lines.push('## Code')
  lines.push('```ruby')
  lines.push(r.code.trim())
  lines.push('```')
  lines.push('')

  if (r.audioStats && r.audioPath) {
    const s = r.audioStats
    lines.push('## Audio (Level 3 — observation, not inference)')
    lines.push(`- **Path:** \`${r.audioPath}\``)
    lines.push(`- **Sample rate:** ${s.sampleRate} Hz, **channels:** ${s.channels}`)
    lines.push(`- **Duration:** ${s.duration.toFixed(3)}s`)
    lines.push(`- **Peak:** ${s.peak}`)
    lines.push(`- **RMS:** ${s.rms}`)
    lines.push(`- **Clipping:** ${s.clipping}%`)
    if (s.peak < 0.01) lines.push(`- ⚠ **Silent output** — the user code may not have produced audio`)
    if (s.rms > 0.3) lines.push(`- ⚠ **Loud output** — RMS ${s.rms} (Sonic Pi reference ≈ 0.19)`)
  } else {
    lines.push('## Audio')
    lines.push(`_No WAV produced._`)
  }
  lines.push('')

  if (r.notes.length > 0) {
    lines.push('## Notes')
    for (const n of r.notes) lines.push(`- ${n}`)
  }

  writeFileSync(r.reportPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { code: string; duration: number; name: string } {
  let duration = DEFAULT_DURATION
  let name = 'inline'
  let code = `play 60\nsleep 1\nplay 67\nsleep 1\nplay 72\nsleep 1`
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--duration') duration = parseInt(argv[++i], 10)
    else if (a === '--name') name = argv[++i]
    else if (a === '--file') {
      const path = argv[++i]
      code = readFileSync(path, 'utf8')
      name = basename(path).replace(/\.[^.]+$/, '')
    } else if (!a.startsWith('--')) {
      code = a
    }
  }
  return { code, duration, name }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`▶ Desktop capture (${args.duration}ms): ${args.name}`)
  const result = await runDesktopCapture(args.code, {
    duration: args.duration,
    name: args.name,
  })
  writeReport(result)
  console.log(`✓ Report: ${result.reportPath}`)
  if (result.audioPath) {
    console.log(`✓ WAV:    ${result.audioPath}`)
    if (result.audioStats) {
      const s = result.audioStats
      console.log(`  ${s.duration.toFixed(2)}s · peak ${s.peak} · RMS ${s.rms} · clip ${s.clipping}%`)
    }
  } else {
    console.log(`⚠ No WAV produced. See report for diagnostics.`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
