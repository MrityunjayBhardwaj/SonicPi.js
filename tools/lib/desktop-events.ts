/**
 * Desktop Sonic Pi /s_new EVENT capture (issue #446).
 *
 * Closes the audio-opacity grounding gap (vyapti SV53): the audio comparator
 * is opaque past desktop's audio output, so per-layer `/s_new` structure can
 * only be inferred from a histogram. This module captures the LITERAL OSC
 * event stream desktop Sonic Pi sends to its scsynth, so event-level
 * divergence ("web dropped the noise layer") is directly observable.
 *
 * MECHANISM (grounded by observation 2026-06-02, not inference):
 *   scsynth honors the `/dumpOSC 1` command and streams every incoming OSC
 *   message to its stdout, which Sonic Pi routes live into
 *   `~/.sonic-pi/log/scsynth.log` in canonical SuperCollider format:
 *
 *     [ "/s_new", "sonic-pi-basic_mixer", 9, 0, 2, "amp", 1, ... ]
 *     [ "#bundle", 17134385929134665728,
 *       [ "/s_new", "sonic-pi-beep", 10, 1, 8, "note", 60, "out_bus", 20 ]
 *     ]
 *
 *   Bundle NTP timetag → absolute schedule time (SP10 BPM scaling already
 *   resolved by desktop before send). No sudo, no UDP proxy, no port
 *   reconfiguration — we just toggle dumpOSC and read the log delta.
 *
 * Flow: discover ports → /dumpOSC 1 → mark scsynth.log offset → /run-code →
 *       wait window → /stop-all-jobs → /dumpOSC 0 → parse log delta.
 */

import { readFileSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { createSocket, type Socket } from 'dgram'
import { homedir } from 'os'
import { resolve } from 'path'

const SCSYNTH_LOG = resolve(homedir(), '.sonic-pi/log/scsynth.log')

// ---------------------------------------------------------------------------
// Port + token discovery (extends capture-desktop.ts to expose the scsynth port)
// ---------------------------------------------------------------------------

export interface DesktopPorts {
  guiSendToSpider: number // we send /run-code + /stop-all-jobs here
  scsynth: number // we send /dumpOSC here
  token: number
}

export function discoverPorts(): DesktopPorts {
  const psOutput = execSync('ps -axo args', { encoding: 'utf8' })
  // daemon spawns: spider-server.rb -u GUI_SEND GUI_LISTEN SCSYNTH SCSYNTH_SEND
  //                                    OSC_CUES TAU SPIDER_LISTEN_TO_TAU TOKEN
  const m = psOutput.match(
    /spider-server\.rb\s+-u\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)/,
  )
  if (!m) {
    throw new Error(
      'Sonic Pi is not running (no spider-server.rb process found).\n' +
        '→ Run `open -a "Sonic Pi"` and wait ~15 seconds for scsynth to boot.',
    )
  }
  return {
    guiSendToSpider: parseInt(m[1], 10),
    scsynth: parseInt(m[3], 10),
    token: parseInt(m[8], 10),
  }
}

// ---------------------------------------------------------------------------
// Minimal OSC 1.0 encoder (no dependency) — mirrors tools/capture-desktop.ts
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
function sendUdp(host: string, port: number, packet: Buffer): Promise<void> {
  return new Promise((res, rej) => {
    const sock: Socket = createSocket('udp4')
    sock.send(packet, port, host, (err) => {
      sock.close()
      err ? rej(err) : res()
    })
  })
}

// ---------------------------------------------------------------------------
// dumpOSC log parser
// ---------------------------------------------------------------------------

/** A normalized OSC event extracted from scsynth's dumpOSC stream. */
export interface OscEvent {
  addr: string // /s_new | /n_set | /n_free | /g_new
  synthdef?: string // for /s_new — full name, e.g. "sonic-pi-beep"
  nodeId?: number
  addAction?: number
  group?: number
  params: Record<string, number | string>
  /** seconds relative to the first scheduled (bundled) event; null = immediate (no timetag). */
  tRel: number | null
  raw: string
}

/**
 * Is this event an FX node (with_fx synthdef)? Mirrors event-parity's `classify`
 * fx test. Used to EXCLUDE FX nodes from the rebase anchor: with_fx creates its
 * FX node at registration time, which on web is tRel=0 even when the with_fx sits
 * after a sleep. Anchoring the rebase on it shifts the whole web timeline and
 * manufactures a false onset gap vs desktop (where the FX node is immediate,
 * tRel=null, already excluded). Anchoring on non-FX events (voices + the vt-0
 * marker) keeps both sides on the same zero. (SP122 residual, issue #466.)
 */
export function isFxEvent(e: { synthdef?: string }): boolean {
  const s = e.synthdef
  return !!s && (s.includes('-fx_') || s.includes('_fx_'))
}

/** NTP 64-bit fixed-point → seconds (high 32 = secs since 1900, low 32 = fraction). */
function ntpToSeconds(ntpStr: string): number {
  const v = BigInt(ntpStr)
  const secs = Number(v >> 32n)
  const frac = Number(v & 0xffffffffn) / 4294967296
  return secs + frac
}

const TRACKED = new Set(['/s_new', '/n_set', '/n_free', '/g_new'])

/**
 * Parse a dumpOSC log delta into normalized events.
 * Handles plain top-level messages and `#bundle` blocks (with NTP timetag).
 * Non-OSC lines (`late 0.14`, `FAILURE IN SERVER ...`) are skipped.
 */
export function parseDumpOsc(text: string): OscEvent[] {
  const lines = text.split('\n')
  const events: OscEvent[] = []
  let bundleNtp: number | null = null // absolute NTP seconds of the open bundle (null outside a bundle)
  let bundleImmediate = false // timetag == 1 means "now"

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    // Bundle header: [ "#bundle", <ntp>,
    const bh = line.match(/^\[\s*"#bundle"\s*,\s*(\d+)\s*,?$/)
    if (bh) {
      const ntpRaw = bh[1]
      bundleImmediate = ntpRaw === '1'
      bundleNtp = bundleImmediate ? null : ntpToSeconds(ntpRaw)
      continue
    }
    // Bundle terminator
    if (line === ']') {
      bundleNtp = null
      bundleImmediate = false
      continue
    }
    // A message line — complete JSON array (dumpOSC uses JSON-compatible syntax
    // for everything except the 64-bit bundle timetag, handled above).
    if (line.startsWith('[')) {
      let arr: unknown[]
      try {
        arr = JSON.parse(line) as unknown[]
      } catch {
        continue // not a parseable message line — skip
      }
      const addr = arr[0]
      if (typeof addr !== 'string' || !TRACKED.has(addr)) continue

      // Scheduled events carry the bundle's NTP seconds; immediate bundles
      // (timetag 1 = "now") and plain top-level messages have no meaningful
      // absolute time → null, so the rebase below anchors only on real
      // scheduled times (mixing an immediate-0 with absolute NTP would break it).
      const ev: OscEvent = { addr, params: {}, tRel: bundleNtp, raw: line }
      if (addr === '/s_new') {
        // /s_new name nodeId addAction group [k v]...
        ev.synthdef = String(arr[1])
        ev.nodeId = Number(arr[2])
        ev.addAction = Number(arr[3])
        ev.group = Number(arr[4])
        for (let i = 5; i + 1 < arr.length; i += 2) {
          ev.params[String(arr[i])] = arr[i + 1] as number | string
        }
      } else if (addr === '/n_set') {
        ev.nodeId = Number(arr[1])
        for (let i = 2; i + 1 < arr.length; i += 2) {
          ev.params[String(arr[i])] = arr[i + 1] as number | string
        }
      } else if (addr === '/n_free') {
        ev.nodeId = Number(arr[1])
      } else if (addr === '/g_new') {
        ev.nodeId = Number(arr[1])
        ev.addAction = Number(arr[2])
        ev.group = Number(arr[3])
      }
      events.push(ev)
    }
  }

  // Rebase tRel to the EARLIEST scheduled event so both engines share a 0-based
  // timeline (the absolute NTP epoch is meaningless for diff). Anchor on the
  // minimum, not the first-in-order — events are not strictly time-sorted, and a
  // first-in-order anchor produces spurious negative onsets.
  // EXCLUDE FX nodes from the anchor (issue #466): see isFxEvent. Desktop FX
  // nodes are usually already immediate (tRel=null) and excluded, but anchoring
  // on non-FX symmetrically with the web side guarantees both share the same
  // zero. Fall back to all scheduled events if there are no non-FX ones.
  const nonFx = events.filter((e) => e.tRel !== null && !isFxEvent(e)).map((e) => e.tRel as number)
  const allScheduled = events.filter((e) => e.tRel !== null).map((e) => e.tRel as number)
  const scheduled = nonFx.length > 0 ? nonFx : allScheduled
  if (scheduled.length > 0) {
    const t0 = Math.min(...scheduled)
    for (const e of events) {
      if (e.tRel !== null) e.tRel = Math.round((e.tRel - t0) * 1000) / 1000
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Capture orchestration
// ---------------------------------------------------------------------------

export interface DesktopEventCapture {
  events: OscEvent[]
  ports: DesktopPorts
  rawDeltaLen: number
  notes: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Run `code` on desktop Sonic Pi with dumpOSC enabled and return the parsed
 * /s_new event stream. Events-only (no recording) to minimize confounding OSC.
 */
export async function captureDesktopEvents(
  code: string,
  opts: { duration?: number } = {},
): Promise<DesktopEventCapture> {
  const duration = opts.duration ?? 8000
  const ports = discoverPorts()
  const notes: string[] = []

  // Enable dumpOSC on scsynth and mark the log offset BEFORE running code.
  await sendUdp('127.0.0.1', ports.scsynth, oscMessage('/dumpOSC', 'i', [1]))
  await sleep(250)
  const logOffset = statSync(SCSYNTH_LOG).size
  notes.push(`dumpOSC enabled on scsynth:${ports.scsynth}, log offset ${logOffset}`)

  // Run user code inside in_thread + with_bpm 60 sleep window so live_loops
  // fire async for the full window without the main thread blocking (mirrors
  // capture-desktop.ts), then stop. No recording — we only want events.
  const durationSec = duration / 1000.0
  const wrapped =
    `in_thread do\n${code}\nend\n` + `with_bpm 60 do\n  sleep ${durationSec}\nend\n`
  await sendUdp('127.0.0.1', ports.guiSendToSpider, oscMessage('/run-code', 'is', [ports.token, wrapped]))
  notes.push(`sent /run-code to spider:${ports.guiSendToSpider} (token ${ports.token})`)

  await sleep(duration + 1000)

  await sendUdp('127.0.0.1', ports.guiSendToSpider, oscMessage('/stop-all-jobs', 'i', [ports.token]))
  await sleep(300)
  await sendUdp('127.0.0.1', ports.scsynth, oscMessage('/dumpOSC', 'i', [0]))
  await sleep(300)

  const delta = readFileSync(SCSYNTH_LOG).slice(logOffset).toString('utf8')
  const events = parseDumpOsc(delta)
  notes.push(`parsed ${events.length} tracked events from ${delta.length} bytes of dumpOSC`)
  return { events, ports, rawDeltaLen: delta.length, notes }
}
