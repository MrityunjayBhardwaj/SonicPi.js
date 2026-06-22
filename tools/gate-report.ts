/**
 * gate-report.ts — Launch-gate computation with reproducer-as-verdict overlay (#407).
 *
 * The raw sweep (test_results/examples-sweep.json) records unvarnished verdicts —
 * including INCONCL for rows the pitch-trackers cannot grade. That is honest
 * measurement, but INCONCL means "the instrument can't see," NOT "no bug" (SP106):
 * an INCONCL row may hide a real engine defect (it hid the note(octave:) bug).
 *
 * This script computes the LAUNCH GATE (launch_acceptance_criteria / dharana §28):
 * denominator = non-heavy official rows (PRNG INCLUDED post-EPIC-#531 — they are
 * now graded by /s_new event-parity, SV69; the SV49 "PRNG non-goal" exclusion is
 * retired); pass = MATCH or EVENT-MATCH or PRNG-VARIANT (the cos fallback);
 * threshold ≥70%. For instrument-blind rows it overlays the verdict of an
 * instrument-friendly PROJECTION (tools/gate-reproducers/, see manifest.json) that
 * exercises the SAME engine logic on gradeable material — annotated "graded via
 * projection." Rows with no faithful projection are listed as documented
 * limitations (NOT counted as pass). Heavy/uncapturable rows (no WAV) are excluded.
 *
 * SECOND CRITERION — differential matrix (#469): the gate also reads
 * test_results/diff-matrix.json (tools/diff-matrix.ts → construct×context×position
 * event-parity vs desktop, dharana §36). It is GREEN iff every active cell is a
 * structure-match (match === active, and diverge/timing/empty/error/pending all 0).
 * When present and not-green it BLOCKS the overall gate (listing the diverged
 * cells); when absent it WARNS only (the matrix needs desktop SP + scsynth and is
 * not a CI artifact). Overall = rosterPassed && (matrix absent || matrix green).
 *
 * Usage: npx tsx tools/gate-report.ts
 *   Writes test_results/launch-gate.{json,md,html}.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { navBlock } from './lib/dashboard-nav.ts'

const ROOT = join(import.meta.dirname, '..')
const SWEEP = join(ROOT, 'test_results/examples-sweep.json')
const MANIFEST = join(ROOT, 'tools/gate-reproducers/manifest.json')
const DIFF_MATRIX = join(ROOT, 'test_results/diff-matrix.json')

// --public (or DASHBOARD_PUBLIC=1) → user-facing HTML: drop internal catalogue
// codes, PRNG framing and methodology prose. The pass/fail verdict, counts and
// the per-row table stay. Only the HTML is affected; the JSON/MD keep full detail.
const PUBLIC = process.argv.includes('--public') || process.env.DASHBOARD_PUBLIC === '1'

interface SweepRow {
  example: string; verdict: string; prng: boolean; heavy: boolean
}
interface Evidence { report: string; verdict: string; method?: string; desktop?: string; web?: string; note?: string }
interface Reproducer { example: string; reproducer: string; blindReason: string; projection: string; requires: string[]; evidence: Evidence }
interface Limitation { example: string; verdict: string; reason: string; engineEvidence: string; countsAsPass: boolean }
interface Exclusion { example: string; reason: string; classifier: string }
interface Refreshed { example: string; reason: string; evidence: Evidence }
interface Manifest { gateThresholdPct: number; reproducers: Reproducer[]; limitations: Limitation[]; refreshed?: Refreshed[]; exclusions: Exclusion[] }

const sweep = JSON.parse(readFileSync(SWEEP, 'utf8'))
const rows: SweepRow[] = sweep.entries
const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

// SV61 (#377/#378): EVENT-MATCH is a PASS. On a deterministic piece, per-synthdef
// /s_new onset-sequence parity is the AUTHORITATIVE cross-engine correctness check
// (the engine's output terminates at the OSC emission, server.rb:345,672; audio is
// the lossy stage-7+ layer). A STRUCTURE + onset-sequence match means the engine
// played the right notes at the right times — a real DIVERGE is never promoted.
const isPass = (v: string) => v === 'match' || v === 'event-match' || v === 'prng-variant' || v === 'prngVariant'

// Denominator: non-heavy official rows. PRNG rows are INCLUDED post-EPIC-#531
// (Phase 5b, SV69): their random walk now matches desktop note-for-note, so they
// are graded by /s_new event-parity (a PRNG EVENT-MATCH passes; a PRNG DIVERGE is
// a real failure, tracked in #537). Only heavy/uncapturable rows (no WAV) are out.
const denom = rows.filter(r => !r.heavy)
const reproByEx = new Map(manifest.reproducers.map(r => [r.example, r]))
const limByEx = new Map(manifest.limitations.map(l => [l.example, l]))
const refreshedByEx = new Map((manifest.refreshed ?? []).map(r => [r.example, r]))

interface GateRow { example: string; rawVerdict: string; gateVerdict: string; pass: boolean; gradedVia: string; detail: string }
const gateRows: GateRow[] = denom.map(r => {
  const repro = reproByEx.get(r.example)
  if (repro) {
    const verdict = repro.evidence.verdict
    return {
      example: r.example, rawVerdict: r.verdict, gateVerdict: verdict, pass: isPass(verdict),
      gradedVia: 'projection', detail: `${repro.reproducer} → ${repro.evidence.report}${repro.requires.length ? ` · requires ${repro.requires.join('; ')}` : ''}`,
    }
  }
  const refreshed = refreshedByEx.get(r.example)
  if (refreshed) {
    const verdict = refreshed.evidence.verdict
    return { example: r.example, rawVerdict: r.verdict, gateVerdict: verdict, pass: isPass(verdict), gradedVia: 'raw-refreshed', detail: `re-measured → ${refreshed.evidence.report}` }
  }
  const lim = limByEx.get(r.example)
  if (lim) {
    return { example: r.example, rawVerdict: r.verdict, gateVerdict: lim.verdict, pass: lim.countsAsPass, gradedVia: 'documented-limitation', detail: lim.reason }
  }
  return { example: r.example, rawVerdict: r.verdict, gateVerdict: r.verdict, pass: isPass(r.verdict), gradedVia: 'raw-sweep', detail: '' }
})

const passCount = gateRows.filter(g => g.pass).length
const total = gateRows.length
const pct = total ? (passCount / total) * 100 : 0
const rosterPassed = pct >= manifest.gateThresholdPct

// ---- Second criterion: differential matrix (#469 / dharana §36) ----
interface MatrixCounts {
  match: number; diverge: number; timing: number; webEmpty: number
  desktopEmpty: number; error: number; skipped: number; pending: number
  active: number; total: number
}
interface MatrixCriterion {
  present: boolean; green: boolean | null; generatedAt?: string; window?: number
  counts?: MatrixCounts; diverged?: string[]; note: string
}
function readMatrix(): MatrixCriterion {
  if (!existsSync(DIFF_MATRIX)) {
    return { present: false, green: null, note: 'diff-matrix.json absent — run `npx tsx tools/diff-matrix.ts --fresh && npx tsx tools/build-diff-matrix.ts` (needs desktop SP + scsynth). Not blocking.' }
  }
  const m = JSON.parse(readFileSync(DIFF_MATRIX, 'utf8'))
  const c: MatrixCounts = m.counts
  const offenders = c.diverge + c.timing + c.webEmpty + c.desktopEmpty + c.error + c.pending
  const green = c.match === c.active && offenders === 0
  const diverged: string[] = (m.diverged ?? []).map((d: any) => typeof d === 'string' ? d : (d.cell ?? d.id ?? JSON.stringify(d)))
  return {
    present: true, green, generatedAt: m.generatedAt, window: m.window, counts: c, diverged,
    note: green
      ? `${c.match}/${c.active} cells structure-match · 0 diverge/timing/empty/error.`
      : `NOT green — match ${c.match}/${c.active}, diverge ${c.diverge}, timing ${c.timing}, web-empty ${c.webEmpty}, desktop-empty ${c.desktopEmpty}, error ${c.error}, pending ${c.pending}.`,
  }
}
const matrix = readMatrix()

// Overall: roster threshold AND (matrix green when present). Absent matrix warns, does not block.
const passed = rosterPassed && (matrix.green !== false)

// ---- write JSON ----
const out = {
  generatedFrom: 'examples-sweep.json + tools/gate-reproducers/manifest.json + test_results/diff-matrix.json',
  passed,
  roster: { denominator: total, passCount, pct: +pct.toFixed(1), thresholdPct: manifest.gateThresholdPct, passed: rosterPassed },
  differentialMatrix: matrix,
  // Back-compat: keep the roster fields at top level (pre-#469 consumers read these).
  denominator: total, passCount, pct: +pct.toFixed(1), thresholdPct: manifest.gateThresholdPct,
  rows: gateRows,
  exclusions: manifest.exclusions,
}
writeFileSync(join(ROOT, 'test_results/launch-gate.json'), JSON.stringify(out, null, 2))

// ---- write Markdown ----
const verdictIcon = (g: GateRow) => g.pass ? '✅' : (g.gateVerdict === 'inconcl' ? '⚠️' : '❌')
const matrixIcon = matrix.green === null ? '⚠️' : matrix.green ? '✅' : '❌'
const md = [
  `# Launch Gate`,
  ``,
  `## Overall: **${passed ? '✅ PASS' : '❌ NOT MET'}** — roster ${rosterPassed ? 'pass' : 'fail'} · differential matrix ${matrix.green === null ? 'absent (warn)' : matrix.green ? 'green' : 'NOT green'}`,
  ``,
  `### Criterion 1 — non-heavy official roster (PRNG graded by event-parity, SV69)`,
  ``,
  `**${passCount}/${total} = ${pct.toFixed(1)}%** · threshold ≥${manifest.gateThresholdPct}% · **${rosterPassed ? '✅ PASS' : '❌ NOT MET'}**`,
  ``,
  `### Criterion 2 — Differential matrix ${matrixIcon} (#469 · dharana §36)`,
  ``,
  matrix.present
    ? `${matrix.note}${matrix.generatedAt ? ` _(captured ${matrix.generatedAt}, ${matrix.window}ms window)_` : ''}${matrix.diverged && matrix.diverged.length ? `\n\nOffending cells: ${matrix.diverged.map(c => `\`${c}\``).join(', ')}` : ''}`
    : matrix.note,
  ``,
  `> Pass = MATCH / EVENT-MATCH / PRNG-VARIANT (the cos fallback). PRNG rows are graded by per-synthdef \`/s_new\` event-parity (SV69 — values now match desktop, EPIC #531). Rows the pitch-trackers cannot grade are graded via an instrument-friendly projection that exercises the same engine logic (see \`tools/gate-reproducers/\`). The raw sweep keeps the unvarnished verdicts; this is the launch-gate computation.`,
  ``,
  `> **Validity:** projection/refreshed verdicts are recorded evidence. The engine fixes they depend on — **#405** (play_pattern_timed, b4a2dc1) and **#409** (note octave, 8f38e2c) — are **merged to main**, and both projections were re-captured live against merged main (2026-05-29). Re-capture any reproducer with \`npx tsx tools/compare-desktop-vs-web.ts --file <reproducer.rb>\` and update the manifest evidence to refresh.`,
  ``,
  `| Row | raw sweep | gate verdict | graded via | detail |`,
  `|---|---|---|---|---|`,
  ...gateRows.map(g => `| ${verdictIcon(g)} ${g.example} | ${g.rawVerdict} | ${g.gateVerdict} | ${g.gradedVia} | ${g.detail} |`),
  ``,
  `## Excluded from denominator (heavy / uncapturable rows — no WAV produced)`,
  ...(manifest.exclusions.length ? manifest.exclusions.map(e => `- **${e.example}** — ${e.reason}`) : ['- _(none — PRNG rows are now graded by event-parity, SV69; only heavy/silent rows are excluded as uncapturable)_']),
  ``,
  `_Generated by tools/gate-report.ts from test_results/examples-sweep.json + tools/gate-reproducers/manifest.json._`,
].join('\n')
writeFileSync(join(ROOT, 'test_results/launch-gate.md'), md)

// ---- write HTML (dashboard view, linked from index.html) ----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Public mode: scrub internal catalogue codes and PRNG framing from free-text
// detail/reason strings that originate in gate-reproducers/manifest.json, with
// punctuation cleanup so prose doesn't end up with empty () or stray separators.
const scrub = (s: string): string => {
  if (!PUBLIC) return s
  return s
    .replace(/\(\s*(?:SV|SP|SK)\d+(?:\s*[\/,]\s*(?:SV|SP|SK)?\d+)*\s*\)/g, '')
    .replace(/\b(?:SV|SP|SK)\d+\b/g, '')
    .replace(/\bPRNG[- ]?(?:variant|driven|free|values?)?\b/gi, 'randomness')
    .replace(/\brandom walk\b/gi, 'randomness')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
const rowClass = (g: GateRow) => g.pass ? 'pass' : (g.gateVerdict === 'inconcl' ? 'warn' : 'fail')
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SonicWeb — Launch Gate</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; background: #0e1014; color: #e6e6e6; }
  .tab-bar { display: flex; gap: 4px; padding: 10px 16px; background: #15181f; border-bottom: 1px solid #262b36; align-items: center; }
  .tab-bar a { color: #9aa4b2; text-decoration: none; padding: 4px 10px; border-radius: 6px; }
  .tab-bar a[data-active] { background: #2a3140; color: #fff; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .verdict { font-size: 26px; font-weight: 700; margin: 14px 0; }
  .verdict.pass { color: #4ade80; }
  .verdict.fail { color: #f87171; }
  .note { color: #9aa4b2; max-width: 80ch; margin: 8px 0; }
  table { border-collapse: collapse; width: 100%; margin: 18px 0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #262b36; vertical-align: top; }
  th { color: #9aa4b2; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr.pass td:first-child { border-left: 3px solid #4ade80; }
  tr.warn td:first-child { border-left: 3px solid #fbbf24; }
  tr.fail td:first-child { border-left: 3px solid #f87171; }
  code { background: #1b1f29; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .detail { color: #9aa4b2; font-size: 12px; }
  .excl li { color: #9aa4b2; margin: 4px 0; }
  .crit { border: 1px solid #262b36; border-radius: 8px; padding: 12px 16px; margin: 14px 0; }
  .crit h2 { font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .03em; color: #9aa4b2; }
  .crit .v { font-size: 18px; font-weight: 700; }
  .crit.pass { border-left: 3px solid #4ade80; } .crit.pass .v { color: #4ade80; }
  .crit.fail { border-left: 3px solid #f87171; } .crit.fail .v { color: #f87171; }
  .crit.warn { border-left: 3px solid #fbbf24; } .crit.warn .v { color: #fbbf24; }
</style></head>
<body>
  ${navBlock(PUBLIC ? '🚦 launch gate' : '🚦 Tier-1 launch gate · SV46')}
  <div class="wrap">
    <h1>Launch Gate</h1>
    <div class="verdict ${passed ? 'pass' : 'fail'}">Overall: ${passed ? '✅ PASS' : '❌ NOT MET'}</div>
    <div class="crit ${rosterPassed ? 'pass' : 'fail'}">
      <h2>${PUBLIC ? 'Criterion 1 — official example roster' : 'Criterion 1 — non-heavy official roster (PRNG graded by event-parity · SV69)'}</h2>
      <div class="v">${passCount}/${total} = ${pct.toFixed(1)}% · threshold ≥${manifest.gateThresholdPct}% · ${rosterPassed ? '✅ PASS' : '❌ NOT MET'}</div>
    </div>
    <div class="crit ${matrix.green === null ? 'warn' : matrix.green ? 'pass' : 'fail'}">
      <h2>Criterion 2 — Differential matrix${PUBLIC ? '' : ' <span class="detail">(#469 · construct×context×position vs desktop · dharana §36)</span>'}</h2>
      <div class="v">${matrix.green === null ? '⚠️ ABSENT (warn, not blocking)' : matrix.green ? '✅ GREEN' : '❌ NOT GREEN'}</div>
      <p class="detail">${esc(matrix.note)}${matrix.generatedAt ? ` · captured ${matrix.generatedAt}, ${matrix.window}ms window` : ''}${matrix.diverged && matrix.diverged.length ? ` · offenders: ${matrix.diverged.map(c => esc(c)).join(', ')}` : ''} — <a href="diff-matrix.html" style="color:#9aa4b2">open matrix →</a></p>
    </div>
    <p class="note">${PUBLIC
      ? 'Pass = a piece plays the right notes at the right times (matches desktop), or is musically equivalent. Rows the pitch-trackers cannot grade directly are graded via an equivalent gradeable projection of the same logic.'
      : 'Pass = MATCH / EVENT-MATCH / PRNG-VARIANT (the cos fallback). PRNG rows are graded by per-synthdef <code>/s_new</code> event-parity (SV69 — values now match desktop, EPIC #531); a PRNG DIVERGE is a real failure (tracked in #537). Rows the pitch-trackers cannot grade are graded via an instrument-friendly <b>projection</b> that exercises the same engine logic (<code>tools/gate-reproducers/</code>). The raw sweep keeps the unvarnished verdicts; this is the launch-gate computation. Projection verdicts depend on #405 + #409 (merged), re-captured live on merged main.'}</p>
    <table>
      <thead><tr><th>Row</th><th>Raw sweep</th><th>Gate verdict</th><th>Graded via</th><th>Detail</th></tr></thead>
      <tbody>
${gateRows.map(g => `        <tr class="${rowClass(g)}"><td>${verdictIcon(g)} ${esc(g.example)}</td><td>${g.rawVerdict}</td><td><b>${g.gateVerdict}</b></td><td>${g.gradedVia}</td><td class="detail">${esc(scrub(g.detail))}</td></tr>`).join('\n')}
      </tbody>
    </table>
    <h2 style="font-size:15px">Excluded from denominator <span class="detail">(heavy / uncapturable rows — no WAV)</span></h2>
    <ul class="excl">
${manifest.exclusions.length ? manifest.exclusions.map(e => `      <li><b>${esc(e.example)}</b> — ${esc(scrub(e.reason))}</li>`).join('\n') : `      <li><em>${PUBLIC ? 'none — only heavy/silent rows are excluded as uncapturable' : 'none — PRNG rows are now graded by event-parity (SV69); only heavy/silent rows are excluded as uncapturable'}</em></li>`}
    </ul>
    ${PUBLIC ? '' : `<p class="detail">Generated by <code>tools/gate-report.ts</code> from <code>examples-sweep.json</code> + <code>tools/gate-reproducers/manifest.json</code>. Re-run: <code>npx tsx tools/gate-report.ts</code>.</p>`}
  </div>
</body></html>`
writeFileSync(join(ROOT, 'test_results/launch-gate.html'), html)

console.log(`Launch gate OVERALL: ${passed ? 'PASS' : 'NOT MET'}`)
console.log(`  Criterion 1 — roster: ${passCount}/${total} = ${pct.toFixed(1)}% — ${rosterPassed ? 'PASS' : 'NOT MET'}`)
console.log(`  Criterion 2 — diff matrix: ${matrix.green === null ? 'ABSENT (warn)' : matrix.green ? 'GREEN' : 'NOT GREEN'} — ${matrix.note}`)
console.log(`Wrote test_results/launch-gate.{json,md,html}`)
for (const g of gateRows) console.log(`  ${g.pass ? 'PASS' : 'fail'}  ${g.example.padEnd(20)} ${g.gateVerdict.padEnd(10)} (${g.gradedVia})`)
