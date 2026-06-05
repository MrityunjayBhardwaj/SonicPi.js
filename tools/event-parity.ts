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

// ---------------------------------------------------------------------------
// Onset-SEQUENCE parity (SV61, #377/#378) — the authoritative tiebreaker.
//
// The multiset/verdict above answers "does web produce the same LAYERS?". The
// onset-sequence parity below answers the stricter "does each shared layer fire
// at the same TIMES?". Together they are the complete statement of the engine's
// deterministic output (stages 1-6, terminating at the /s_new emission;
// server.rb:345,672,723) — the layer that the engine OWNS, before scsynth's
// stage-7+ DSP. Pitch-tracking the WAV measures stage 7+, which sums N voices
// into one waveform and re-infers fundamentals frame-by-frame, losing per-event
// identity. THAT loss is the false-DIVERGE class (#453 cymbal, #379 kicks, #378
// multi-loop interleave). When the audio comparator flags DIVERGE/INCONCL on a
// deterministic piece but the /s_new structure AND onset sequences match, the
// engine played the right notes at the right times — the residual is scsynth
// rendering (#417/#268/#273) or tracker noise, not an engine bug.
// ---------------------------------------------------------------------------

export interface OnsetSeqRow {
  synthdef: string
  desktopOnsets: number[]
  webOnsets: number[]
  comparedLen: number // common-prefix length actually compared
  timingMatched: boolean // onset TIMES match within ε over the prefix
  firstMismatchIdx: number // -1 when timing matched (or nothing to compare)
  maxDevMs: number // largest |Δ| over the compared prefix, in ms
  // NOTE-value parity per timetag (deterministic pieces only — SV49: PRNG VALUES
  // are expected to differ, so notes are NOT checked when isPrng). null = not
  // checked (PRNG, or nothing to compare). false = same synthdef fires at the
  // same times but with DIFFERENT notes (a real transposition/wrong-note bug).
  noteMatched: boolean | null
  // matched = timingMatched AND (noteMatched !== false). The promotion gate.
  matched: boolean
}

export interface SequenceParity {
  // null = no judgeable shared significant layer (can neither confirm nor deny);
  // a tiebreaker must NOT promote on null (conservative — SV50 discipline).
  match: boolean | null
  epsilonMs: number
  notesChecked: boolean // false for PRNG pieces (SV49 — values expected to differ)
  rows: OnsetSeqRow[]
  reasons: string[]
}

export interface ParityReport {
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
  // Per-synthdef onset-sequence parity (SV61). Orthogonal to `verdict` (which is
  // the multiset structure): a piece can STRUCTURE-MATCH the layers but mis-time
  // them (wrong loop period) — that is a real engine bug and shows here as
  // match=false. The EVENT-MATCH tiebreaker requires BOTH STRUCTURE-MATCH and
  // sequenceParity.match===true.
  sequenceParity: SequenceParity
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

// Per-onset match tolerance for the onset-SEQUENCE parity (SV61). Desktop
// schedules in real time and carries ~2ms scheduling jitter (observed on #378:
// 1.998 vs web's exact 2.0). 15ms sits comfortably above that jitter floor and
// far below any real timing bug (a wrong loop period drifts UNBOUNDED — the very
// first cycle already exceeds 15ms, e.g. period 2.0 vs 2.5 ⇒ 500ms at onset 1).
// Too loose masks real timing bugs; too tight makes jitter a false-DIVERGE. The
// PREFIX-compare below (not full-length) absorbs the cold-start window-trim.
const ONSET_EPS_SEC = 0.015

interface VoiceEvent { t: number; note: number | null }

/** Voice-only /s_new {time, note} per synthdef, sorted by (time, note). FX/infra
 *  excluded (same `classify` partition the multiset diff uses); null tRel
 *  (immediate, unscheduled) dropped — only scheduled events are comparable. The
 *  secondary sort by note canonicalises the order WITHIN a simultaneous cluster
 *  (e.g. bizet plays two octave-stacked beeps at one tick) so the two engines'
 *  intra-tick serialisation order — which is musically inaudible and arbitrary —
 *  does not register as a divergence. */
function voiceEventsBySynthdef(events: OscEvent[]): Record<string, VoiceEvent[]> {
  const out: Record<string, VoiceEvent[]> = {}
  for (const e of events) {
    if (e.addr !== '/s_new' || !e.synthdef || e.tRel === null) continue
    if (classify(e.synthdef) !== 'voice') continue
    const note = typeof e.params?.note === 'number' ? (e.params.note as number) : null
    ;(out[e.synthdef] ??= []).push({ t: e.tRel, note })
  }
  for (const k of Object.keys(out))
    out[k].sort((a, b) => a.t - b.t || (a.note ?? 0) - (b.note ?? 0))
  return out
}

// Bucket width for grouping near-simultaneous onsets into one "tick" when
// comparing the per-tick NOTE multiset. Wider than ε so jitter never splits a
// cluster, far below any musical inter-onset gap.
const TICK_BUCKET_SEC = 0.02

/** The sorted multiset of notes at each time-bucket, as a comparable string key
 *  per bucket index (buckets ordered by time). */
function noteBucketsByTime(evs: VoiceEvent[]): string[] {
  const m = new Map<number, number[]>()
  for (const e of evs) {
    const k = Math.round(e.t / TICK_BUCKET_SEC)
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(e.note ?? NaN)
  }
  return [...m.keys()].sort((a, b) => a - b).map((k) =>
    JSON.stringify(m.get(k)!.slice().sort((a, b) => a - b)),
  )
}

/**
 * Onset-SEQUENCE parity (SV61). For every SIGNIFICANT layer present on BOTH sides
 * (a dropped layer is already a STRUCTURE-DIVERGE; per-event parity is only
 * meaningful for shared layers), the engine's deterministic output is verified on
 * TWO axes:
 *  1. TIMING — PREFIX-compare the sorted onset times. PREFIX because web captures
 *     ~1 fewer cycle (cold-start warmup trims the fixed window, SP22/SV15); ε
 *     (ONSET_EPS_SEC) absorbs desktop's ~2ms real-time jitter.
 *  2. NOTES — per-timetag note MULTISET equality (deterministic pieces only —
 *     SV49: PRNG note VALUES are expected to differ). This closes the hole that
 *     timing+structure alone leaves: a real transposition bug (same synthdef at
 *     the same times, WRONG notes) would otherwise be falsely EVENT-MATCHed.
 *     Compared as multisets-per-tick because simultaneous onsets (octave stacks)
 *     have arbitrary intra-tick order on each engine — only the set is musical.
 * matched = timingMatched AND noteMatched !== false.
 * match===null when there is no judgeable shared significant layer.
 */
function computeSequenceParity(
  desktop: OscEvent[],
  web: OscEvent[],
  rows: SynthRow[],
  checkNotes: boolean,
  eps = ONSET_EPS_SEC,
): SequenceParity {
  const dEv = voiceEventsBySynthdef(desktop)
  const wEv = voiceEventsBySynthdef(web)
  const shared = rows.filter(
    (r) => r.significant && r.status !== 'only-desktop' && r.status !== 'only-web',
  )
  const seqRows: OnsetSeqRow[] = []
  const reasons: string[] = []
  for (const r of shared) {
    const d = dEv[r.synthdef] ?? []
    const w = wEv[r.synthdef] ?? []
    const dT = d.map((e) => e.t)
    const wT = w.map((e) => e.t)
    const len = Math.min(dT.length, wT.length)
    // Axis 1 — timing.
    let firstMismatchIdx = -1
    let maxDevMs = 0
    for (let i = 0; i < len; i++) {
      const devMs = Math.abs(dT[i] - wT[i]) * 1000
      if (devMs > maxDevMs) maxDevMs = devMs
      if (devMs > eps * 1000 && firstMismatchIdx < 0) firstMismatchIdx = i
    }
    const timingMatched = len > 0 && firstMismatchIdx < 0
    // Axis 2 — notes (deterministic only). Per-tick multiset over the common
    // prefix of buckets.
    let noteMatched: boolean | null = null
    if (checkNotes && len > 0) {
      const dB = noteBucketsByTime(d)
      const wB = noteBucketsByTime(w)
      const bn = Math.min(dB.length, wB.length)
      let ok = bn > 0
      for (let i = 0; i < bn; i++) if (dB[i] !== wB[i]) { ok = false; break }
      noteMatched = ok
    }
    const matched = timingMatched && noteMatched !== false
    seqRows.push({
      synthdef: r.synthdef,
      desktopOnsets: dT,
      webOnsets: wT,
      comparedLen: len,
      timingMatched,
      firstMismatchIdx,
      maxDevMs: Math.round(maxDevMs * 10) / 10,
      noteMatched,
      matched,
    })
    if (len === 0) {
      reasons.push(`${short(r.synthdef)}: no scheduled onsets to compare on one side`)
    } else if (!timingMatched) {
      const i = firstMismatchIdx
      reasons.push(
        `${short(r.synthdef)}: onset #${i} desktop ${dT[i]}s vs web ${wT[i]}s ` +
          `(Δ ${Math.round(Math.abs(dT[i] - wT[i]) * 1000)}ms > ${eps * 1000}ms ε) — mis-timed layer`,
      )
    } else if (noteMatched === false) {
      reasons.push(
        `${short(r.synthdef)}: onset times match but per-tick NOTE multiset differs — wrong notes (transposition?)`,
      )
    } else {
      reasons.push(
        `${short(r.synthdef)}: ${len} onsets match within ε (max Δ ${Math.round(maxDevMs * 10) / 10}ms)` +
          `${noteMatched ? ', notes match' : ''}`,
      )
    }
  }
  const judged = seqRows.filter((s) => s.comparedLen > 0)
  const match = judged.length === 0 ? null : judged.every((s) => s.matched)
  return { match, epsilonMs: eps * 1000, notesChecked: checkNotes, rows: seqRows, reasons }
}

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

  // Onset-sequence parity (SV61) — orthogonal to the multiset verdict above.
  // Notes are checked only on deterministic pieces (SV49: PRNG note VALUES differ
  // by construction; for PRNG we verify timing/structure, not note values).
  const sequenceParity = computeSequenceParity(desktop, web, rows, !isPrng)

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
    sequenceParity,
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
  // Onset-sequence parity (SV61) — the stricter "same times?" check.
  const sp = r.sequenceParity
  const spIcon = sp.match === null ? '—' : sp.match ? '✓' : '✗'
  const spWord = sp.match === null ? 'N/A (no judgeable shared layer)' : sp.match ? 'MATCH' : 'DIVERGE'
  console.log(`\nOnset-sequence parity (SV61, ε=${sp.epsilonMs}ms, prefix-compared${sp.notesChecked ? ', +notes' : ', timing-only (PRNG)'}): ${spIcon} ${spWord}`)
  for (const row of sp.rows) {
    const ic = row.comparedLen === 0 ? '—' : row.matched ? '✓' : '✗'
    const detail = row.comparedLen === 0
      ? 'no comparable onsets'
      : !row.timingMatched
        ? `mis-timed @#${row.firstMismatchIdx} (max Δ ${row.maxDevMs}ms)`
        : row.noteMatched === false
          ? `times match but NOTES differ (wrong notes)`
          : `${row.comparedLen} onsets, max Δ ${row.maxDevMs}ms${row.noteMatched ? ', notes ✓' : ''}`
    console.log(`  ${ic} ${short(row.synthdef).padEnd(22)} ${detail}`)
  }
  if (r.verdict === 'STRUCTURE-MATCH' && sp.match === true)
    console.log(`  → EVENT-MATCH eligible: structure + onset sequences both match (engine plays right notes at right times).`)
  else if (r.verdict === 'STRUCTURE-MATCH' && sp.match === false)
    console.log(`  → NOT event-match: layers match but onset sequence (timing or notes) diverges — real engine bug.`)

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
