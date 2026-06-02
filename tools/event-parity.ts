/**
 * Event-based desktop↔web parity (issue #446).
 *
 * Diffs the two `/s_new` event STRUCTURES — which synthdef, how many, in what
 * order, scheduled when — between desktop Sonic Pi and our web engine. This is
 * the missing OUR-side observation of the DESKTOP boundary (vyapti SV53/SV8):
 * the audio comparator is opaque past desktop's audio and can only verify the
 * dominant harmonic content; this reads the literal per-layer event stream.
 *
 * PRNG param VALUES are EXPECTED to differ (SV49: desktop reads a frozen
 * rand-stream table, we use MT19937). We therefore diff STRUCTURE (synthdef
 * multiset + order + timing), NOT random values — separating "engine plays the
 * right composition" from "different random walk", at the event level, with no
 * audio inference.
 *
 * Usage:
 *   npx tsx tools/event-parity.ts --file path/to/code.rb --duration 12000
 *   npx tsx tools/event-parity.ts "play 60; sleep 1; play 67"
 *   npx tsx tools/event-parity.ts --file x.rb --desktop-only   # debug one side
 *
 * Prereqs: Sonic Pi.app running (scsynth booted) + vite dev server at
 * BASE_URL (default http://localhost:5173). Observation tool, not a test.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { captureDesktopEvents, type OscEvent } from './lib/desktop-events.ts'
import { captureWebEvents } from './lib/web-events.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')

// ---------------------------------------------------------------------------
// Synthdef classification — voices (the composition layers) vs FX vs infra.
// ---------------------------------------------------------------------------

const INFRA = new Set([
  'sonic-pi-mixer',
  'sonic-pi-basic_mixer',
  'sonic_pi_track_monitor',
  'sonic-pi-recorder',
  'sonic-pi-sound_in',
  'sonic-pi-sound_in_stereo',
])

type Kind = 'voice' | 'fx' | 'infra'
function classify(synthdef: string): Kind {
  if (INFRA.has(synthdef)) return 'infra'
  if (synthdef.includes('-fx_') || synthdef.includes('_fx_')) return 'fx'
  return 'voice'
}

/** short label for display: strip the sonic-pi- prefix. */
function short(synthdef: string): string {
  return synthdef.replace(/^sonic-pi-/, '').replace(/^sonic_pi_/, '')
}

interface SideSummary {
  total: number
  voiceCounts: Record<string, number> // synthdef → count (voices only)
  fxCounts: Record<string, number>
  firstOnset: Record<string, number | null> // synthdef → first tRel
  voiceOrder: string[] // synthdef first-appearance order (voices only)
}

function summarize(events: OscEvent[]): SideSummary {
  const voiceCounts: Record<string, number> = {}
  const fxCounts: Record<string, number> = {}
  const firstOnset: Record<string, number | null> = {}
  const voiceOrder: string[] = []
  const seen = new Set<string>()
  for (const e of events) {
    if (e.addr !== '/s_new' || !e.synthdef) continue
    const kind = classify(e.synthdef)
    if (kind === 'infra') continue
    const bucket = kind === 'fx' ? fxCounts : voiceCounts
    bucket[e.synthdef] = (bucket[e.synthdef] ?? 0) + 1
    if (!(e.synthdef in firstOnset)) firstOnset[e.synthdef] = e.tRel
    if (kind === 'voice' && !seen.has(e.synthdef)) {
      seen.add(e.synthdef)
      voiceOrder.push(e.synthdef)
    }
  }
  const total = Object.values(voiceCounts).reduce((a, b) => a + b, 0)
  return { total, voiceCounts, fxCounts, firstOnset, voiceOrder }
}

// ---------------------------------------------------------------------------
// Structural diff + verdict
// ---------------------------------------------------------------------------

interface SynthRow {
  synthdef: string
  desktop: number
  web: number
  ratio: number | null // web/desktop
  significant: boolean // a real layer (not a rare PRNG choose-pick)
  status: 'match' | 'count-differs' | 'only-desktop' | 'only-web'
  desktopOnset: number | null // first-appearance tRel (gating signal)
  webOnset: number | null
}

interface ParityReport {
  verdict: 'STRUCTURE-MATCH' | 'STRUCTURE-DIVERGE' | 'DESKTOP-EMPTY' | 'WEB-EMPTY'
  isPrng: boolean
  reasons: string[]
  rows: SynthRow[]
  fxRows: SynthRow[]
  desktopTotal: number
  webTotal: number
  totalRatio: number | null
  orderMatch: boolean
  desktopOrder: string[]
  webOrder: string[]
}

// Count tolerance for shared synthdefs (PRNG walks vary run-to-run, SV49).
const COUNT_TOL = 0.5 // web within [0.5×, 2×] of desktop is "same layer, different walk"

// PRNG tokens (SV49) — when present, raw per-window counts and which member of
// a `.choose` set fires are EXPECTED to differ; the random walk is divergent by
// construction (desktop frozen rand-stream vs our MT19937).
const PRNG_TOKENS =
  /\b(choose|rrand|rrand_i|rand|rand_i|shuffle|dice|one_in|pick|rand_look|ring_shuffle)\b/

function detectPrng(code: string): boolean {
  return PRNG_TOKENS.test(code)
}

/** A synthdef is a "significant layer" (vs a rare PRNG choose-pick) if it fires
 *  at least 3 times AND is ≥5% of that side's total voice volume. */
function isSignificant(count: number, sideTotal: number): boolean {
  return count >= 3 && count >= 0.05 * sideTotal
}

function diffCounts(
  d: Record<string, number>,
  w: Record<string, number>,
  dOnset: Record<string, number | null>,
  wOnset: Record<string, number | null>,
  dTotal: number,
  wTotal: number,
): SynthRow[] {
  const keys = new Set([...Object.keys(d), ...Object.keys(w)])
  const rows: SynthRow[] = []
  for (const k of keys) {
    const desktop = d[k] ?? 0
    const web = w[k] ?? 0
    const significant = isSignificant(desktop, dTotal) || isSignificant(web, wTotal)
    let status: SynthRow['status']
    if (desktop === 0) status = 'only-web'
    else if (web === 0) status = 'only-desktop'
    else {
      const ratio = web / desktop
      status = ratio >= COUNT_TOL && ratio <= 1 / COUNT_TOL ? 'match' : 'count-differs'
    }
    rows.push({
      synthdef: k,
      desktop,
      web,
      ratio: desktop ? web / desktop : null,
      significant,
      status,
      desktopOnset: dOnset[k] ?? null,
      webOnset: wOnset[k] ?? null,
    })
  }
  rows.sort((a, b) => b.desktop + b.web - (a.desktop + a.web))
  return rows
}

// First-onset gap that counts as a gating divergence: a shared layer that
// starts much later on one side (e.g. cue-gated on desktop, ungated on web).
const ONSET_GAP_SEC = 3

export function buildReport(desktop: OscEvent[], web: OscEvent[], code: string): ParityReport {
  const ds = summarize(desktop)
  const ws = summarize(web)
  const isPrng = detectPrng(code)
  const rows = diffCounts(ds.voiceCounts, ws.voiceCounts, ds.firstOnset, ws.firstOnset, ds.total, ws.total)
  const fxRows = diffCounts(ds.fxCounts, ws.fxCounts, ds.firstOnset, ws.firstOnset, ds.total, ws.total)

  const reasons: string[] = []
  // A "dropped layer" — the ROBUST divergence signal — is a SIGNIFICANT desktop
  // layer that web does not produce at all. A rare one-sided synthdef (e.g. one
  // member of a `.choose` set) is PRNG layer-selection (SV49), not a bug.
  const droppedLayers = rows.filter((r) => r.status === 'only-desktop' && r.significant)
  const extraLayers = rows.filter((r) => r.status === 'only-web' && r.significant)
  const rareOneSided = rows.filter(
    (r) => (r.status === 'only-desktop' || r.status === 'only-web') && !r.significant,
  )
  const countDiffers = rows.filter((r) => r.status === 'count-differs')
  // Gating: a shared significant layer whose first onset is far apart.
  const gatingGaps = rows.filter(
    (r) =>
      r.status !== 'only-desktop' &&
      r.status !== 'only-web' &&
      r.significant &&
      r.desktopOnset !== null &&
      r.webOnset !== null &&
      Math.abs(r.desktopOnset - r.webOnset) >= ONSET_GAP_SEC,
  )

  let verdict: ParityReport['verdict']
  if (ds.total === 0) {
    verdict = 'DESKTOP-EMPTY'
    reasons.push('Desktop produced no voice /s_new — cannot compare (check Sonic Pi / scsynth).')
  } else if (ws.total === 0) {
    verdict = 'WEB-EMPTY'
    reasons.push('Web produced no voice /s_new — engine refused or silent.')
  } else if (droppedLayers.length > 0) {
    verdict = 'STRUCTURE-DIVERGE'
    reasons.push(
      `Web DROPPED ${droppedLayers.length} significant layer(s) desktop produces: ` +
        droppedLayers.map((r) => `${short(r.synthdef)}×${r.desktop}`).join(', '),
    )
  } else {
    verdict = 'STRUCTURE-MATCH'
    reasons.push(
      isPrng
        ? 'Significant layers present on both sides (PRNG piece — counts/choices vary by SV49).'
        : 'Significant synthdef multiset matches.',
    )
  }

  // Supplementary observations (do not flip the verdict, but flag for follow-up).
  if (extraLayers.length > 0)
    reasons.push(
      `Web reached EXTRA significant layer(s) absent from desktop in this window: ` +
        extraLayers.map((r) => `${short(r.synthdef)}×${r.web}`).join(', ') +
        ` — web is denser/ahead here; check first-onsets for gating divergence.`,
    )
  if (gatingGaps.length > 0)
    reasons.push(
      `Gating/timing: shared layer first-onset differs ≥${ONSET_GAP_SEC}s — ` +
        gatingGaps
          .map((r) => `${short(r.synthdef)} desktop@${r.desktopOnset}s vs web@${r.webOnset}s`)
          .join(', '),
    )
  if (countDiffers.length > 0)
    reasons.push(
      `Shared-layer counts differ${isPrng ? ' (expected for PRNG, SV49)' : ''}: ` +
        countDiffers.map((r) => `${short(r.synthdef)} d${r.desktop}/w${r.web}`).join(', '),
    )
  if (rareOneSided.length > 0)
    reasons.push(
      `Rare one-sided synthdef(s)${isPrng ? ' (PRNG choose-variance, SV49)' : ''}: ` +
        rareOneSided
          .map((r) => `${short(r.synthdef)} ${r.desktop > 0 ? `desktop×${r.desktop}` : `web×${r.web}`}`)
          .join(', '),
    )

  // Order of significant-layer first-appearance.
  const dSig = ds.voiceOrder.filter((s) => isSignificant(ds.voiceCounts[s] ?? 0, ds.total))
  const wSig = ws.voiceOrder.filter((s) => isSignificant(ws.voiceCounts[s] ?? 0, ws.total))
  const orderMatch = dSig.length === wSig.length && dSig.every((s, i) => s === wSig[i])
  if (!orderMatch)
    reasons.push(
      `Significant-layer first-appearance order differs (desktop: ${dSig.map(short).join('→')} | ` +
        `web: ${wSig.map(short).join('→')})${isPrng ? ' — common for PRNG layer selection' : ' — thread-start timing'}.`,
    )

  return {
    verdict,
    isPrng,
    reasons,
    rows,
    fxRows,
    desktopTotal: ds.total,
    webTotal: ws.total,
    totalRatio: ds.total ? Math.round((ws.total / ds.total) * 100) / 100 : null,
    orderMatch,
    desktopOrder: dSig.map(short),
    webOrder: wSig.map(short),
  }
}

// ---------------------------------------------------------------------------
// Pretty report
// ---------------------------------------------------------------------------

function printReport(name: string, r: ParityReport): void {
  const bar = '─'.repeat(64)
  console.log(`\n${bar}`)
  console.log(`EVENT PARITY: ${name}`)
  console.log(bar)
  const icon =
    r.verdict === 'STRUCTURE-MATCH' ? '✓' : r.verdict.includes('EMPTY') ? '⚠' : '✗'
  console.log(`Verdict: ${icon} ${r.verdict}`)
  for (const reason of r.reasons) console.log(`  • ${reason}`)
  console.log('')
  console.log(`Source: ${r.isPrng ? 'PRNG-driven (SV49 — counts/choices expected to vary)' : 'deterministic'}`)
  console.log(`Voice /s_new total — desktop ${r.desktopTotal}, web ${r.webTotal}` +
    (r.totalRatio !== null ? ` (web ${r.totalRatio}× desktop)` : ''))
  console.log('')
  const onset = (v: number | null) => (v === null ? '—' : `${v}s`)
  console.log(
    `  ${'synthdef'.padEnd(22)} ${'desktop'.padStart(7)} ${'web'.padStart(6)} ${'ratio'.padStart(6)} ${'d@onset'.padStart(8)} ${'w@onset'.padStart(8)}  status`,
  )
  for (const row of r.rows) {
    const flag =
      row.status === 'only-desktop'
        ? row.significant ? '✗ DROPPED on web' : '· rare (web 0)'
        : row.status === 'only-web'
          ? row.significant ? '+ extra on web' : '· rare (desktop 0)'
          : row.status === 'count-differs' ? '~ count differs' : '✓'
    console.log(
      `  ${short(row.synthdef).padEnd(22)} ${String(row.desktop).padStart(7)} ${String(row.web).padStart(6)} ` +
        `${(row.ratio !== null ? row.ratio.toFixed(2) : '—').padStart(6)} ${onset(row.desktopOnset).padStart(8)} ${onset(row.webOnset).padStart(8)}  ${flag}`,
    )
  }
  if (r.fxRows.length > 0) {
    console.log(`\n  FX:`)
    for (const row of r.fxRows) {
      const flag =
        row.status === 'only-desktop' ? (row.significant ? '✗ DROPPED on web' : '· rare') :
        row.status === 'only-web' ? (row.significant ? '+ extra on web' : '· rare') :
        row.status === 'count-differs' ? '~ count differs' : '✓'
      console.log(`  ${short(row.synthdef).padEnd(22)} ${String(row.desktop).padStart(7)} ${String(row.web).padStart(6)}  ${flag}`)
    }
  }
  console.log(`\nNote: PRNG param VALUES are not diffed (SV49 non-goal). Structure + timing only.`)
  console.log(`A fixed wall-clock window counts more events on the faster-progressing engine;`)
  console.log(`"DROPPED" = a significant desktop layer web never produces (the robust divergence).`)
  console.log(bar + '\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  let duration = 12000
  let name = 'inline'
  let code = `play 60\nsleep 0.5\nplay 67\nsleep 0.5\nplay 72`
  let mode: 'both' | 'desktop' | 'web' = 'both'
  let replay: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--duration') duration = parseInt(argv[++i], 10)
    else if (a === '--name') name = argv[++i]
    else if (a === '--desktop-only') mode = 'desktop'
    else if (a === '--web-only') mode = 'web'
    else if (a === '--replay') replay = argv[++i]
    else if (a === '--file') {
      const path = argv[++i]
      code = readFileSync(path, 'utf8')
      name = basename(path).replace(/\.[^.]+$/, '')
    } else if (!a.startsWith('--')) code = a
  }
  return { code, duration, name, mode, replay }
}

async function main(): Promise<void> {
  const { code, duration, name, mode, replay } = parseArgs(process.argv.slice(2))

  // --replay: re-evaluate the verdict on an already-captured JSON (no capture).
  if (replay) {
    const saved = JSON.parse(readFileSync(replay, 'utf8'))
    const report = buildReport(saved.desktop, saved.web, saved.code ?? '')
    printReport(saved.name ?? basename(replay), report)
    return
  }

  mkdirSync(CAPTURES_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')

  let desktop: OscEvent[] = []
  let web: OscEvent[] = []

  if (mode !== 'web') {
    console.log(`▶ Desktop event capture (${duration}ms): ${name}`)
    const dc = await captureDesktopEvents(code, { duration })
    desktop = dc.events
    for (const n of dc.notes) console.log(`  ${n}`)
  }
  if (mode !== 'desktop') {
    console.log(`▶ Web event capture (${duration}ms): ${name}`)
    const wc = await captureWebEvents(code, { duration })
    web = wc.events
    for (const n of wc.notes) console.log(`  ${n}`)
  }

  if (mode === 'both') {
    const report = buildReport(desktop, web, code)
    printReport(name, report)
    const outPath = resolve(CAPTURES_DIR, `eventparity_${ts}_${name}.json`)
    writeFileSync(
      outPath,
      JSON.stringify({ name, ts, duration, code, report, desktop, web }, null, 2),
    )
    console.log(`✓ ${outPath}`)
    if (report.verdict === 'STRUCTURE-DIVERGE') process.exitCode = 2
  } else {
    const events = mode === 'desktop' ? desktop : web
    const s = summarize(events)
    console.log(`\n${mode} voice counts:`, JSON.stringify(s.voiceCounts, null, 2))
    console.log(`${mode} fx counts:`, JSON.stringify(s.fxCounts, null, 2))
    console.log(`${mode} order:`, s.voiceOrder.map(short).join(' → '))
  }
}

// Only run as a CLI when invoked directly (not when imported by tests).
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main().catch((err) => {
    console.error('✗', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
