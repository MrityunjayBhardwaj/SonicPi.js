/**
 * build-diff-matrix.ts — the "Diff Matrix" dashboard viewer (issue #459, dharana §36).
 *
 * Renders tools/diff-matrix.ts results (test_results/diff-matrix-results.json) into:
 *   test_results/diff-matrix.json   manifest (status counts + seam-cluster read)
 *   test_results/diff-matrix.html   viewer — the construct×modifier×position GRID
 *                                   (the cost-curve / clustering read of §36) plus a
 *                                   per-cell detail card (verdict, /s_new diff, source).
 *
 * The grid is the deductive instrument: each cell is colored by the desktop-oracle
 * verdict, so divergence CLUSTERING in the hoist/fork seam column is read directly
 * (fatality check, §36 step 5). Skipped cells are shown explicitly (no silent caps).
 *
 * Usage: npx tsx tools/build-diff-matrix.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { navBlock } from './lib/dashboard-nav.ts'
import { CONSTRUCTS, MODIFIERS, POSITIONS, enumerateCells } from './lib/matrix-cells.ts'
import { deriveStatus, type Derived } from './lib/matrix-status.ts'

// seam is a CLASSIFICATION (recomputed from the live enumeration), not measured
// data — so the §36-corrected isSeam applies without re-capturing.
const seamById = new Map(enumerateCells().map((c) => [c.id, c.seam]))
const seamOf = (id: string) => seamById.get(id) ?? false

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TR = resolve(ROOT, 'test_results')
const RESULTS = resolve(TR, 'diff-matrix-results.json')

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const short = (s: string) => s.replace(/^sonic-pi-/, '').replace(/^sonic_pi_/, '')

interface SynthRow {
  synthdef: string; desktop: number; web: number; ratio: number | null
  significant: boolean; status: string; desktopOnset: number | null; webOnset: number | null
}
interface ParityReport {
  verdict: string; isPrng: boolean; reasons: string[]; rows: SynthRow[]; fxRows: SynthRow[]
  desktopTotal: number; webTotal: number; totalRatio: number | null
  orderMatch: boolean; desktopOrder: string[]; webOrder: string[]
  // SV61 onset-sequence parity (#476) — drives the 'timing' status (#477).
  sequenceParity?: { match: boolean | null } | null
}
interface OscEvent { addr: string; synthdef?: string; params: Record<string, number | string>; tRel: number | null }
interface CellResult {
  id: string; construct: string; modifier: string; position: string; seam: boolean
  skip: string | null; code: string
  status: 'match' | 'diverge' | 'empty' | 'skipped' | 'error'
  verdict: string | null; report: ParityReport | null
  desktop: OscEvent[]; web: OscEvent[]; error: string | null; capturedAt: string | null
}
interface ResultsFile { generatedAt: string; duration: number; cells: Record<string, CellResult> }

if (!existsSync(RESULTS)) {
  console.error(`✗ ${RESULTS} not found — run \`npx tsx tools/diff-matrix.ts\` first.`)
  process.exit(1)
}
const rf = JSON.parse(readFileSync(RESULTS, 'utf8')) as ResultsFile
const cells = Object.values(rf.cells)
const byId = new Map(cells.map((c) => [c.id, c]))

// ── status helpers ───────────────────────────────────────────────────────────
// Classification (incl. the 'timing' blind-spot recompute) lives in the shared
// tools/lib/matrix-status.ts so the driver and this viewer agree structurally
// (#477). 'timing' now fires on the SV61 onset-sequence signal (ε=15ms) as well
// as the coarse ≥ONSET_GAP first-onset gap — catching sub-second mis-timing like
// the #475 nested-in_thread fork (0.3s) that the coarse gap alone missed.
const derivedById = new Map(cells.map((c) => [c.id, deriveStatus(c)]))

// 'timing' and 'diverge' are both real bugs per the desktop oracle (the seam read
// counts both); 'timing' gets its own colour so the grid shows the failure MODE.
const STATUS_META: Record<string, { cls: string; icon: string }> = {
  match: { cls: 'pass', icon: '✓' },
  diverge: { cls: 'fail', icon: '✗' },
  timing: { cls: 'time', icon: '◷' },
  web_empty: { cls: 'fail', icon: '∅' },
  desktop_empty: { cls: 'warn', icon: '⚠' },
  error: { cls: 'err', icon: '!' },
  skipped: { cls: 'skip', icon: '·' },
  pending: { cls: 'pend', icon: '–' },
}

// ── the grid: rows = construct×position, cols = modifier ───────────────────────
function gridCell(construct: string, position: string, modifier: string): string {
  const id = `${construct}__${modifier}__${position}`
  const c = byId.get(id)
  if (!c) {
    const m = STATUS_META.pending
    return `<td class="g ${m.cls}" title="${esc(id)} — not captured yet">${m.icon}</td>`
  }
  const d = derivedById.get(id) ?? 'pending'
  const m = STATUS_META[d] ?? STATUS_META.pending
  const seam = seamOf(c.id) ? ' seam' : ''
  if (d === 'skipped') {
    return `<td class="g ${m.cls}${seam}" title="${esc(id)} — SKIPPED: ${esc(c.skip)}">${m.icon}</td>`
  }
  const tip = `${id} — ${d === 'timing' ? 'TIMING-DIVERGE (onset gap, count matched)' : c.verdict ?? c.status}` +
    (c.report ? ` (d${c.report.desktopTotal}/w${c.report.webTotal})` : '') +
    (c.error ? ` — ${c.error}` : '')
  return `<td class="g ${m.cls}${seam}" title="${esc(tip)}"><a href="#${esc(id)}">${m.icon}</a></td>`
}

function gridTable(): string {
  const head =
    `<tr><th class="rk">construct</th><th class="rk">pos</th>` +
    MODIFIERS.map((mo) => `<th>${esc(mo.replace('_', ' '))}</th>`).join('') +
    `</tr>`
  const rows: string[] = []
  for (const construct of CONSTRUCTS) {
    POSITIONS.forEach((position, i) => {
      const cellsHtml = MODIFIERS.map((mo) => gridCell(construct, position, mo)).join('')
      const ctd = i === 0 ? `<td class="ck" rowspan="${POSITIONS.length}">${esc(construct)}</td>` : ''
      rows.push(`<tr>${ctd}<td class="pk">${esc(position.replace('_', '-'))}</td>${cellsHtml}</tr>`)
    })
  }
  return `<table class="grid"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`
}

// ── per-cell detail card ───────────────────────────────────────────────────────
function rowCells(r: SynthRow): string {
  const flag =
    r.status === 'only-desktop'
      ? r.significant ? '<span class="st fail">✗ DROPPED on web</span>' : '<span class="st mute">· rare (web 0)</span>'
      : r.status === 'only-web'
        ? r.significant ? '<span class="st accent">+ extra on web</span>' : '<span class="st mute">· rare (desktop 0)</span>'
        : r.status === 'count-differs' ? '<span class="st flag">~ count differs</span>' : '<span class="st pass">✓</span>'
  const onset = (v: number | null | undefined) => (v == null ? '—' : `${v}s`)
  const gap =
    Number.isFinite(r.desktopOnset as number) && Number.isFinite(r.webOnset as number) &&
    Math.abs((r.desktopOnset as number) - (r.webOnset as number)) >= 3 ? ' gap' : ''
  return `<tr><td class="syn">${esc(short(r.synthdef))}</td><td class="num">${r.desktop}</td><td class="num">${r.web}</td>` +
    `<td class="num">${r.ratio !== null ? r.ratio.toFixed(2) : '—'}</td><td class="num${gap}">${onset(r.desktopOnset)}</td>` +
    `<td class="num${gap}">${onset(r.webOnset)}</td><td>${flag}</td></tr>`
}

function streamRows(evs: OscEvent[]): string {
  return evs.filter((e) => e.addr === '/s_new').map((e) => {
    const params = Object.entries(e.params)
      .map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'number' ? Number(v.toFixed(4)) : v)}`).join(', ')
    return `<div class="ev"><span class="evt">${e.tRel === null ? '—' : e.tRel + 's'}</span><span class="evn">${esc(short(e.synthdef ?? e.addr))}</span><span class="evp">${params}</span></div>`
  }).join('')
}

function detailCard(c: CellResult): string {
  const d = derivedById.get(c.id) ?? 'pending'
  const m = STATUS_META[d] ?? STATUS_META.pending
  const label = d === 'timing' ? 'TIMING-DIVERGE' : (c.verdict ?? d.toUpperCase())
  const badge = `<span class="verdict ${m.cls}">${m.icon} ${esc(label)}</span>`
  const seamTag = seamOf(c.id) ? '<span class="tag seam">hoist/fork seam</span>' : '<span class="tag">non-seam</span>'
  if (c.status === 'skipped') {
    return `<section class="card skipcard" id="${esc(c.id)}">
      <div class="head"><div class="title">${esc(c.id)} ${badge}</div><div class="meta">${seamTag}</div></div>
      <div class="skipnote">SKIPPED — ${esc(c.skip)}</div></section>`
  }
  const r = c.report
  const reasons = r ? r.reasons.map((x) => `<li>${esc(x)}</li>`).join('') : ''
  const voiceRows = r ? r.rows.map(rowCells).join('') : ''
  const fxRows = r && r.fxRows.length
    ? `<div class="tbl-h">FX</div><table class="diff"><thead><tr><th>synthdef</th><th>desktop</th><th>web</th><th>ratio</th><th>d@onset</th><th>w@onset</th><th>status</th></tr></thead><tbody>${r.fxRows.map(rowCells).join('')}</tbody></table>`
    : ''
  const errLine = c.error ? `<div class="errnote">ERROR — ${esc(c.error)}</div>` : ''
  const totals = r
    ? `<div class="totals">Voice /s_new — desktop <b>${r.desktopTotal}</b>, web <b>${r.webTotal}</b>${r.totalRatio !== null ? ` · web <b>${r.totalRatio}×</b> desktop` : ''}</div>`
    : ''
  const table = r
    ? `<table class="diff"><thead><tr><th>synthdef</th><th>desktop</th><th>web</th><th>ratio</th><th>d@onset</th><th>w@onset</th><th>status</th></tr></thead><tbody>${voiceRows}</tbody></table>${fxRows}`
    : ''
  const streams = r
    ? `<details class="raw"><summary>raw /s_new streams (${c.desktop.filter((e) => e.addr === '/s_new').length} desktop · ${c.web.filter((e) => e.addr === '/s_new').length} web)</summary>
        <div class="streams"><div class="stream"><div class="stream-h">desktop /s_new</div>${streamRows(c.desktop) || '<div class="ev mute">none</div>'}</div>
        <div class="stream"><div class="stream-h">web /s_new</div>${streamRows(c.web) || '<div class="ev mute">none</div>'}</div></div></details>`
    : ''
  return `<section class="card" id="${esc(c.id)}">
    <div class="head"><div class="title">${esc(c.id)} ${badge}</div>
      <div class="meta">${seamTag}<span class="tag">${esc(c.modifier.replace('_', ' '))}</span><span class="tag">${esc(c.position.replace('_', '-'))}</span></div></div>
    ${errLine}<ul class="reasons">${reasons}</ul>${totals}${table}
    <div class="src-h">reproducer</div><pre class="src">${esc(c.code)}</pre>${streams}</section>`
}

// ── tallies + seam-cluster read (the §36 fatality instrument) ──────────────────
const active = cells.filter((c) => !c.skip)
const der = (c: CellResult) => derivedById.get(c.id) ?? 'pending'
const tally = (s: Derived) => active.filter((c) => der(c) === s).length
const counts = {
  match: tally('match'), diverge: tally('diverge'), timing: tally('timing'),
  webEmpty: tally('web_empty'), desktopEmpty: tally('desktop_empty'),
  error: tally('error'), skipped: cells.filter((c) => c.skip).length,
  pending: 60 - cells.filter((c) => c.capturedAt || c.skip).length, // 60 = full space
  active: active.length, total: cells.length,
}
// Real engine bugs per the oracle: dropped-layer (diverge) + onset-gap (timing) +
// web rendered nothing (web_empty). desktop_empty is a harness issue, NOT counted.
const REAL_DIVERGE: Derived[] = ['diverge', 'timing', 'web_empty']
const diverged = active.filter((c) => REAL_DIVERGE.includes(der(c)))
const seamDiverge = diverged.filter((c) => seamOf(c.id)).length
const nonSeamDiverge = diverged.filter((c) => !seamOf(c.id)).length
const seamActive = active.filter((c) => seamOf(c.id)).length
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

writeFileSync(join(TR, 'diff-matrix.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), window: rf.duration, counts,
  fatalityRead: { seamActive, seamDiverge, nonSeamDiverge,
    note: 'seamDiverge clustering with diverse failure modes = fatality (restructure); else converging family (patch).' },
  diverged: diverged.map((c) => ({ id: c.id, seam: seamOf(c.id), kind: der(c), reasons: c.report?.reasons ?? [] })),
  cells: cells.map((c) => ({ id: c.id, status: der(c), verdict: c.verdict, seam: seamOf(c.id), skip: c.skip })),
}, null, 2))

// stable detail order: web_empty → diverge → timing → desktop_empty → error → match → skipped.
const RANK: Record<Derived, number> = { web_empty: 0, diverge: 1, timing: 2, desktop_empty: 3, error: 4, match: 5, skipped: 6, pending: 7 }
const rank = (c: CellResult) => RANK[der(c)]
const ordered = [...cells].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
const detailCards = ordered.map(detailCard).join('\n')

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SonicWeb — Diff Matrix (construct×context)</title>
<style>
  :root{--bg:#1a1b26;--bg-elev:#1f2335;--bg-card:#16161e;--border:#2a2e46;
    --text:#c0caf5;--text-dim:#7a85b3;--text-mute:#565f89;--accent:#7aa2f7;--accent2:#ff1493;
    --pass:#9ece6a;--flag:#e0af68;--fail:#f7768e;--warn:#e0af68;--err:#ff9e64;--incon:#565f89;--time:#7dcfff;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 24px 60px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .sub{color:var(--text-dim);font-size:12.5px;margin:0 0 18px;font-family:var(--mono)}
  .sub b{color:var(--text)}
  .hero{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .stat{font-family:var(--mono);font-size:12px;padding:4px 12px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border)}
  .stat b{font-size:16px}
  .stat.pass b{color:var(--pass)} .stat.fail b{color:var(--fail)} .stat.warn b{color:var(--warn)}
  .stat.err b{color:var(--err)} .stat.skip b{color:var(--text-mute)} .stat.pend b{color:var(--text-mute)} .stat.time b{color:var(--time)}
  .fatality{background:#16161e;border:1px solid var(--border);border-left:3px solid var(--accent2);border-radius:10px;padding:13px 16px;margin:16px 0 22px;font-size:12.5px;color:var(--text-dim);line-height:1.6}
  .fatality b{color:var(--text)} .fatality .v{font-family:var(--mono);color:var(--accent2)}
  .grid{border-collapse:collapse;font-family:var(--mono);font-size:12px;margin:6px 0 26px}
  .grid th{color:var(--text-mute);font-weight:400;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;text-align:center;border-bottom:1px solid var(--border)}
  .grid th.rk{text-align:left}
  .grid td{padding:0;text-align:center;border:1px solid #20232f}
  .grid td.ck{color:var(--text);padding:6px 10px;font-weight:600;background:var(--bg-card);text-align:left;vertical-align:middle}
  .grid td.pk{color:var(--text-dim);padding:6px 10px;text-align:left;background:#14151c}
  .grid td.g{width:90px;height:30px;font-size:14px;font-weight:700}
  .grid td.g a{display:block;width:100%;height:100%;line-height:30px}
  .grid td.g.pass{background:#18241066;color:var(--pass)} .grid td.g.fail{background:#2a151b;color:var(--fail)}
  .grid td.g.time{background:#0f2630;color:var(--time)}
  .grid td.g.warn{background:#241f12;color:var(--warn)} .grid td.g.err{background:#2a1f14;color:var(--err)}
  .grid td.g.skip{background:#121319;color:var(--text-mute)}
  .grid td.g.pend{background:#121319;color:#3a3f5a}
  .grid td.g.seam{box-shadow:inset 0 0 0 2px #ff149344}
  .legend{font-family:var(--mono);font-size:11px;color:var(--text-mute);margin:-18px 0 24px;display:flex;gap:14px;flex-wrap:wrap}
  .legend span b{font-weight:700}
  .legend .seamkey{box-shadow:inset 0 0 0 2px #ff149366;padding:1px 8px;border-radius:3px}
  .card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px}
  .card.skipcard{opacity:.72}
  .head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
  .title{font-size:14px;font-weight:700;display:flex;align-items:center;gap:10px;font-family:var(--mono)}
  .meta{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--text-mute)}
  .verdict{font-family:var(--mono);font-size:11px;padding:2px 9px;border-radius:20px}
  .verdict.pass{background:#1f2a16;color:var(--pass)} .verdict.fail{background:#2a151b;color:var(--fail)}
  .verdict.warn{background:#241f12;color:var(--warn)} .verdict.err{background:#2a1f14;color:var(--err)}
  .verdict.time{background:#10222a;color:var(--time)}
  .verdict.skip{background:#1a1c26;color:var(--text-mute)}
  .tag{font-family:var(--mono);font-size:10.5px;padding:1px 8px;border-radius:20px;background:var(--bg-elev);color:var(--text-dim)}
  .tag.seam{background:#2a1020;color:var(--accent2)}
  .reasons{margin:10px 0;padding-left:18px;color:var(--text-dim);font-size:12px;line-height:1.5}
  .reasons li{margin:2px 0}
  .skipnote{font-family:var(--mono);font-size:12px;color:var(--text-mute);margin-top:8px}
  .errnote{font-family:var(--mono);font-size:12px;color:var(--err);margin-top:8px}
  .totals{font-family:var(--mono);font-size:12px;color:var(--text-dim);margin:6px 0 10px}
  .totals b{color:var(--text)}
  table.diff{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px;margin-bottom:6px}
  table.diff th{text-align:left;color:var(--text-mute);font-weight:400;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-bottom:1px solid var(--border)}
  table.diff td{padding:3px 8px;border-bottom:1px solid #20232f}
  table.diff td.syn{color:var(--text)} table.diff td.num{text-align:right;color:var(--text-dim)}
  table.diff td.num.gap{color:var(--flag);font-weight:700}
  .st.pass{color:var(--pass)} .st.fail{color:var(--fail)} .st.flag{color:var(--flag)} .st.accent{color:var(--accent)} .st.mute{color:var(--text-mute)}
  .tbl-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 2px}
  .src-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 4px}
  pre.src{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;font-family:var(--mono);font-size:11px;color:var(--text-dim);max-height:280px;margin:0}
  details.raw{margin-top:8px;border-top:1px solid var(--border);padding-top:8px}
  details.raw summary{cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--text-dim)}
  .streams{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}
  .stream-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
  .ev{display:flex;gap:8px;font-family:var(--mono);font-size:11px;padding:1px 0;border-bottom:1px solid #1c1f2b}
  .ev .evt{color:var(--text-mute);min-width:48px;text-align:right} .ev .evn{color:var(--accent);min-width:120px}
  .ev .evp{color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .ev.mute{color:var(--text-mute)}
  footer{margin-top:30px;color:var(--text-mute);font-family:var(--mono);font-size:11px;border-top:1px solid var(--border);padding-top:14px}
</style></head>
<body>
${navBlock('construct×context matrix · #459 · dharana §36')}
<div class="wrap">
  <h1>Diff Matrix — construct × context × position, event-parity vs desktop</h1>
  <p class="sub">The finite scheduling-DSL space, each cell's deterministic reproducer diffed at the <b>/s_new</b> event level against desktop Sonic Pi (the oracle). Window <b>${rf.duration / 1000}s</b>. Built <b>${esc(now)}</b>.</p>
  <div class="hero">
    <span class="stat pass">match <b>${counts.match}</b></span>
    <span class="stat fail">diverge <b>${counts.diverge}</b></span>
    <span class="stat time">timing <b>${counts.timing}</b></span>
    <span class="stat fail">web-empty <b>${counts.webEmpty}</b></span>
    <span class="stat warn">desktop-empty <b>${counts.desktopEmpty}</b></span>
    <span class="stat err">error <b>${counts.error}</b></span>
    <span class="stat skip">skipped <b>${counts.skipped}</b></span>
    <span class="stat pend">pending <b>${counts.pending}</b></span>
  </div>
  <div class="fatality">
    <b>Fatality read (dharana §36 step 5).</b> Hoist/fork-seam cells diverging: <span class="v">${seamDiverge}/${seamActive}</span>. Non-seam diverging: <span class="v">${nonSeamDiverge}</span>.
    Divergence clustering in the seam column <i>with diverse failure modes</i> (timing + data + async + scope) ⇒ fatality confirmed ⇒ no-hoist restructure. Only the known few, flat cost curve ⇒ converging family ⇒ keep per-gap patches. The grid below is that measurement; seam cells are <span class="seamkey">outlined</span>.
  </div>
  ${gridTable()}
  <div class="legend">
    <span><b style="color:var(--pass)">✓</b> match</span>
    <span><b style="color:var(--fail)">✗</b> diverge (dropped layer)</span>
    <span><b style="color:var(--time)">◷</b> timing (onset gap, count matched)</span>
    <span><b style="color:var(--fail)">∅</b> web-empty (web renders nothing)</span>
    <span><b style="color:var(--warn)">⚠</b> desktop-empty (harness)</span>
    <span><b style="color:var(--err)">!</b> error</span>
    <span><b style="color:var(--text-mute)">·</b> skipped (logged)</span>
    <span><b style="color:#3a3f5a">–</b> pending</span>
    <span class="seamkey">hoist/fork seam</span>
  </div>
  ${detailCards}
  <footer>Generated by <code>tools/build-diff-matrix.ts</code> from <code>test_results/diff-matrix-results.json</code> (written by <code>tools/diff-matrix.ts</code>). Re-run the driver to capture more cells, then rebuild.</footer>
</div>
</body></html>`

writeFileSync(join(TR, 'diff-matrix.html'), html)
console.log(`✓ wrote test_results/diff-matrix.html + diff-matrix.json`)
console.log(`  match ${counts.match} · diverge ${counts.diverge} · timing ${counts.timing} · web-empty ${counts.webEmpty} · desktop-empty ${counts.desktopEmpty} · error ${counts.error} · skipped ${counts.skipped} · pending ${counts.pending}`)
console.log(`  seam-cluster read: ${seamDiverge}/${seamActive} seam cells diverge (incl. timing + web-empty), ${nonSeamDiverge} non-seam diverge`)
if (diverged.length) {
  console.log(`  DIVERGENT: ${diverged.map((c) => `${der(c) === 'timing' ? '◷' : '✗'}${c.id}`).join(', ')}`)
}
