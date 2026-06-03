/**
 * diff-matrix.ts — the differential-coverage matrix driver (issue #459, dharana §36).
 *
 * Enumerates the construct×modifier×position space (tools/lib/matrix-cells.ts),
 * runs EACH cell's deterministic reproducer through the event-parity oracle
 * (web /s_new vs desktop /s_new — structure + first-onset + count), and writes a
 * resumable results file the viewer (tools/build-diff-matrix.ts) renders.
 *
 * Desktop IS the oracle (dharana §36): any STRUCTURE-DIVERGE is a real bug, zero
 * human judgment. This makes event-parity a SYSTEMATIC gate over the whole DSL
 * surface instead of an ad-hoc per-fixture tool (closes Finding 1's blindness).
 *
 * RESUMABLE (SK19 — the headed/headless capture loop can die ~15 fixtures in):
 *   every completed cell is flushed to disk immediately; a re-run skips cells
 *   already present (unless --fresh). Desktop + web capture run CONCURRENTLY
 *   within a cell (they share no resource — desktop toggles dumpOSC on the app's
 *   scsynth, web runs its own scsynth-WASM in a private browser), but cells run
 *   SEQUENTIALLY (the desktop scsynth.log offset is a shared, serial resource).
 *
 * Usage:
 *   npx tsx tools/diff-matrix.ts                 # run/resume the full matrix
 *   npx tsx tools/diff-matrix.ts --fresh         # discard prior results, re-run all
 *   npx tsx tools/diff-matrix.ts --only sync     # only cells whose id contains "sync"
 *   npx tsx tools/diff-matrix.ts --duration 8000 # per-cell capture window (default 8000)
 *   npx tsx tools/diff-matrix.ts --list          # print enumeration, no capture
 *
 * Prereqs (same as event-parity): Sonic Pi.app running (scsynth booted, fresh) +
 * vite dev server at BASE_URL. Observation tool, not a unit test.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureDesktopEvents, type OscEvent } from './lib/desktop-events.ts'
import { captureWebEvents } from './lib/web-events.ts'
import { buildReport } from './event-parity.ts'
import { enumerateCells, summarizeCells, type Cell } from './lib/matrix-cells.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TR = resolve(ROOT, 'test_results')
const RESULTS = resolve(TR, 'diff-matrix-results.json')

type Status = 'match' | 'diverge' | 'empty' | 'skipped' | 'error'

interface CellResult {
  id: string
  construct: string
  modifier: string
  position: string
  seam: boolean
  skip: string | null
  code: string
  status: Status
  verdict: string | null
  report: ReturnType<typeof buildReport> | null
  desktop: OscEvent[]
  web: OscEvent[]
  error: string | null
  capturedAt: string | null
}

interface ResultsFile {
  generatedAt: string
  duration: number
  cells: Record<string, CellResult>
}

function loadResults(): ResultsFile {
  if (existsSync(RESULTS)) {
    try {
      return JSON.parse(readFileSync(RESULTS, 'utf8')) as ResultsFile
    } catch {
      /* corrupt → start fresh */
    }
  }
  return { generatedAt: new Date().toISOString(), duration: 0, cells: {} }
}

function saveResults(rf: ResultsFile): void {
  mkdirSync(TR, { recursive: true })
  rf.generatedAt = new Date().toISOString()
  writeFileSync(RESULTS, JSON.stringify(rf, null, 2))
}

function statusFromVerdict(v: string): Status {
  if (v === 'STRUCTURE-MATCH') return 'match'
  if (v === 'STRUCTURE-DIVERGE') return 'diverge'
  return 'empty' // DESKTOP-EMPTY / WEB-EMPTY
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ])
}

async function runCell(cell: Cell, duration: number): Promise<CellResult> {
  const base = {
    id: cell.id,
    construct: cell.construct,
    modifier: cell.modifier,
    position: cell.position,
    seam: cell.seam,
    skip: cell.skip,
    code: cell.code,
    capturedAt: new Date().toISOString(),
  }
  if (cell.skip) {
    return { ...base, status: 'skipped', verdict: null, report: null, desktop: [], web: [], error: null }
  }
  try {
    // Concurrent: desktop (dumpOSC on the app scsynth) + web (private browser).
    // No shared resource within a cell; cells are serialized by the caller.
    const [dc, wc] = await withTimeout(
      Promise.all([captureDesktopEvents(cell.code, { duration }), captureWebEvents(cell.code, { duration })]),
      duration + 45000,
      cell.id,
    )
    const report = buildReport(dc.events, wc.events, cell.code)
    return {
      ...base,
      status: statusFromVerdict(report.verdict),
      verdict: report.verdict,
      report,
      desktop: dc.events,
      web: wc.events,
      error: null,
    }
  } catch (err) {
    return {
      ...base,
      status: 'error',
      verdict: null,
      report: null,
      desktop: [],
      web: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function parseArgs(argv: string[]) {
  let duration = 8000
  let fresh = false
  let only: string | null = null
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--duration') duration = parseInt(argv[++i], 10)
    else if (a === '--fresh') fresh = true
    else if (a === '--only') only = argv[++i]
    else if (a === '--list') list = true
  }
  return { duration, fresh, only, list }
}

async function main(): Promise<void> {
  const { duration, fresh, only, list } = parseArgs(process.argv.slice(2))
  const cells = enumerateCells()
  const summary = summarizeCells(cells)

  console.log(`Differential-coverage matrix (#459) — ${summary.total} cells · ${summary.active} active · ${summary.skipped} skipped`)
  console.log('Skipped (logged, never silent):')
  for (const c of summary.skippedCells) console.log(`  · ${c.id} — ${c.skip}`)

  if (list) {
    console.log('\n=== full enumeration ===')
    for (const c of cells) console.log(`  ${c.skip ? 'SKIP' : 'cell'}  ${c.id}${c.seam ? '  [seam]' : ''}`)
    return
  }

  const rf = fresh ? { generatedAt: new Date().toISOString(), duration, cells: {} } : loadResults()
  rf.duration = duration

  // Always (re)record skip rows so the viewer shows them even before any capture.
  for (const c of cells) {
    if (c.skip && !rf.cells[c.id]) {
      rf.cells[c.id] = {
        id: c.id, construct: c.construct, modifier: c.modifier, position: c.position,
        seam: c.seam, skip: c.skip, code: c.code, status: 'skipped', verdict: null,
        report: null, desktop: [], web: [], error: null, capturedAt: null,
      }
    }
  }

  const todo = cells.filter((c) => {
    if (c.skip) return false
    if (only && !c.id.includes(only)) return false
    const prev = rf.cells[c.id]
    return !prev || prev.status === 'error' // re-run errors on resume
  })

  console.log(`\nTo capture this run: ${todo.length} cell(s)${only ? ` (filtered by "${only}")` : ''}, window ${duration}ms each.\n`)
  saveResults(rf)

  let n = 0
  for (const cell of todo) {
    n++
    process.stdout.write(`[${n}/${todo.length}] ${cell.id} … `)
    const res = await runCell(cell, duration)
    rf.cells[cell.id] = res
    saveResults(rf) // flush immediately — resumable across death (SK19)
    const detail =
      res.status === 'error'
        ? `ERROR ${res.error}`
        : `${res.verdict} (d${res.report?.desktopTotal ?? '?'}/w${res.report?.webTotal ?? '?'})`
    console.log(`${res.status === 'match' ? '✓' : res.status === 'diverge' ? '✗' : '⚠'} ${detail}`)
  }

  // Final tally over ALL active cells present in results.
  const active = Object.values(rf.cells).filter((c) => !c.skip)
  const tally = (s: Status) => active.filter((c) => c.status === s).length
  console.log(`\n${'='.repeat(64)}`)
  console.log(`MATRIX TALLY — ${active.length} active cells captured`)
  console.log(`  ✓ match    ${tally('match')}`)
  console.log(`  ✗ diverge  ${tally('diverge')}`)
  console.log(`  ⚠ empty    ${tally('empty')}`)
  console.log(`  ! error    ${tally('error')}`)
  const diverged = active.filter((c) => c.status === 'diverge')
  if (diverged.length) {
    console.log(`\nDIVERGENT cells (real bugs per the desktop oracle):`)
    for (const c of diverged) {
      const seam = c.seam ? '[seam] ' : ''
      console.log(`  ✗ ${seam}${c.id}`)
      for (const r of c.report?.reasons ?? []) console.log(`      • ${r}`)
    }
  }
  console.log(`${'='.repeat(64)}`)
  console.log(`\n✓ results → ${RESULTS}`)
  console.log(`  next: npx tsx tools/build-diff-matrix.ts  (render the viewer)`)
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
