/**
 * build-event-diff.ts — the "Event Diff" dashboard viewer (issue #446).
 *
 * Consolidates the per-fixture event-parity captures (`.captures/eventparity_*.json`,
 * written by tools/event-parity.ts) into:
 *   test_results/event-diff.json   manifest (verdict counts + per-fixture summary)
 *   test_results/event-diff.html   viewer — desktop ↔ web /s_new structure diff,
 *                                   end-to-end: the count/order/onset comparison
 *                                   AND the raw event streams + source per fixture.
 *
 * This is the EVENT-LEVEL companion to the audio comparator (compare-desktop-vs-web):
 * it diffs the literal /s_new streams, not the audio. PRNG param VALUES are not
 * diffed (SV49); the verdict keys on a DROPPED significant layer + first-onset gaps.
 *
 * Latest capture per fixture name wins (by file mtime). Re-run after new captures.
 *
 * Usage: npx tsx tools/build-event-diff.ts
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { navBlock } from './lib/dashboard-nav.ts'
import { isNonGradeable, nonGradeableReason } from './lib/non-gradeable.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CAPTURES = resolve(ROOT, '.captures')
const TR = resolve(ROOT, 'test_results')

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── capture shapes (from event-parity.ts) ──────────────────────────────────
interface SynthRow {
  synthdef: string
  desktop: number
  web: number
  ratio: number | null
  significant: boolean
  status: 'match' | 'count-differs' | 'only-desktop' | 'only-web'
  desktopOnset: number | null
  webOnset: number | null
}
interface SeqRow {
  synthdef: string
  comparedLen: number
  timingMatched: boolean
  noteMatched: boolean | null
  matched: boolean
  maxDevMs: number
  firstMismatchIdx: number
}
interface SequenceParity {
  match: boolean | null // null = no judgeable shared layer; true/false = onset+note parity
  epsilonMs: number
  notesChecked: boolean
  rows: SeqRow[]
  reasons: string[]
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
  // SV61/SV69 — per-synthdef onset-sequence + per-tick NOTE parity. Optional: old
  // captures predate it. When present, a STRUCTURE-MATCH whose sequenceParity.match
  // is false is really a divergence (the random walk / timing diverges).
  sequenceParity?: SequenceParity
}

/** Effective verdict (SV61/SV69): structure alone is not the grader — a piece can
 *  STRUCTURE-MATCH the layers yet diverge on onset timing or per-tick notes (the
 *  #537 PRNG-divergence class). Fold the onset-sequence verdict in so the dashboard
 *  counts what event-parity actually decided. Old captures (no sequenceParity) keep
 *  their structure verdict. */
type EffVerdict = 'EVENT-MATCH' | 'STRUCTURE-DIVERGE' | 'SEQUENCE-DIVERGE' | 'DESKTOP-EMPTY' | 'WEB-EMPTY' | 'NON-GRADEABLE'
function effectiveVerdict(r: ParityReport, name?: string): EffVerdict {
  // #549: a fixture whose DESKTOP reference side can't be graded (desktop
  // produces ~no usable events — see tools/lib/non-gradeable.ts) is never a
  // web-engine divergence. Decided BEFORE any structure/sequence check so a
  // desktop-side fixture failure can't masquerade as a SEQUENCE-DIVERGE.
  if (name && isNonGradeable(name)) return 'NON-GRADEABLE'
  if (r.verdict === 'DESKTOP-EMPTY' || r.verdict === 'WEB-EMPTY') return r.verdict
  if (r.verdict === 'STRUCTURE-DIVERGE') return 'STRUCTURE-DIVERGE'
  // STRUCTURE-MATCH: defer to onset-sequence/notes when judged.
  if (r.sequenceParity && r.sequenceParity.match === false) return 'SEQUENCE-DIVERGE'
  return 'EVENT-MATCH'
}
const isMatchEff = (v: EffVerdict) => v === 'EVENT-MATCH'
const isDivergeEff = (v: EffVerdict) => v === 'STRUCTURE-DIVERGE' || v === 'SEQUENCE-DIVERGE'
// Inconclusive = not a pass, but NOT counted against the web engine either:
// desktop produced nothing this run (EMPTY) or the fixture is structurally
// non-gradeable on the desktop side (#549). Badged ⚠, excluded from divergers.
const isInconEff = (v: EffVerdict) => v.includes('EMPTY') || v === 'NON-GRADEABLE'
interface OscEvent {
  addr: string
  synthdef?: string
  nodeId?: number
  params: Record<string, number | string>
  tRel: number | null
}
interface Capture {
  name: string
  ts: string
  duration: number
  code: string
  report: ParityReport
  desktop: OscEvent[]
  web: OscEvent[]
}

// ── load latest capture per fixture ─────────────────────────────────────────
function loadCaptures(): Capture[] {
  if (!existsSync(CAPTURES)) return []
  const files = readdirSync(CAPTURES)
    .filter((f) => f.startsWith('eventparity_') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(CAPTURES, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime) // newest first
  const seen = new Set<string>()
  const out: Capture[] = []
  for (const { f } of files) {
    try {
      const c = JSON.parse(readFileSync(join(CAPTURES, f), 'utf8')) as Capture
      if (!c.report || seen.has(c.name)) continue
      seen.add(c.name)
      out.push(c)
    } catch {
      /* skip malformed */
    }
  }
  // stable display order: diverge first, then inconclusive (empty/non-gradeable),
  // then match; alpha within.
  const rank = (v: EffVerdict) =>
    isDivergeEff(v) ? 0 : isInconEff(v) ? 1 : 2
  out.sort((a, b) => rank(effectiveVerdict(a.report, a.name)) - rank(effectiveVerdict(b.report, b.name)) || a.name.localeCompare(b.name))
  return out
}

const short = (s: string) => s.replace(/^sonic-pi-/, '').replace(/^sonic_pi_/, '')

/** event-parity.ts stores `ts` as a filename-safe ISO (colons→dashes), e.g.
 *  2026-06-02T19-35-49-249Z — restore the time separators before parsing. */
function fmtStamp(ts: string): string {
  if (!ts) return ''
  const iso = ts.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? esc(ts) : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

// ── HTML fragments ───────────────────────────────────────────────────────────
function verdictBadge(v: EffVerdict): string {
  const cls = isMatchEff(v) ? 'pass' : isInconEff(v) ? 'incon' : 'fail'
  const icon = isMatchEff(v) ? '✓' : isInconEff(v) ? '⚠' : '✗'
  return `<span class="verdict ${cls}">${icon} ${esc(v)}</span>`
}

function rowCells(r: SynthRow): string {
  const flag =
    r.status === 'only-desktop'
      ? r.significant ? '<span class="st fail">✗ DROPPED on web</span>' : '<span class="st mute">· rare (web 0)</span>'
      : r.status === 'only-web'
        ? r.significant ? '<span class="st accent">+ extra on web</span>' : '<span class="st mute">· rare (desktop 0)</span>'
        : r.status === 'count-differs'
          ? '<span class="st flag">~ count differs</span>'
          : '<span class="st pass">✓</span>'
  // `== null` also catches `undefined` from captures made before onset fields
  // existed — an older JSON must never render "undefineds".
  const onset = (v: number | null | undefined) => (v == null ? '—' : `${v}s`)
  // highlight a first-onset gap (gating signal) — single merged class attr
  const gap =
    Number.isFinite(r.desktopOnset as number) &&
    Number.isFinite(r.webOnset as number) &&
    Math.abs((r.desktopOnset as number) - (r.webOnset as number)) >= 3
      ? ' gap'
      : ''
  return `<tr>
    <td class="syn">${esc(short(r.synthdef))}</td>
    <td class="num">${r.desktop}</td>
    <td class="num">${r.web}</td>
    <td class="num">${r.ratio !== null ? r.ratio.toFixed(2) : '—'}</td>
    <td class="num${gap}">${onset(r.desktopOnset)}</td>
    <td class="num${gap}">${onset(r.webOnset)}</td>
    <td>${flag}</td>
  </tr>`
}

function streamRows(evs: OscEvent[]): string {
  return evs
    .filter((e) => e.addr === '/s_new')
    .map((e) => {
      const params = Object.entries(e.params)
        .map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'number' ? Number(v.toFixed(4)) : v)}`)
        .join(', ')
      return `<div class="ev"><span class="evt">${e.tRel === null ? '—' : e.tRel + 's'}</span><span class="evn">${esc(short(e.synthdef ?? e.addr))}</span><span class="evp">${params}</span></div>`
    })
    .join('')
}

function fixtureCard(c: Capture): string {
  const r = c.report
  const eff = effectiveVerdict(r, c.name)
  // #549: lead with the non-gradeable reason and suppress the structure/onset
  // reasons + sequence line below — for these fixtures the desktop side is the
  // limit, so those signals describe a desktop fixture failure, not the engine.
  const ngReason = eff === 'NON-GRADEABLE' ? nonGradeableReason(c.name) : null
  const reasons = ngReason
    ? `<li>Not gradeable against desktop — ${esc(ngReason)}</li>`
    : r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')
  const voiceRows = r.rows.map(rowCells).join('')
  const fxRows = r.fxRows.length
    ? `<div class="tbl-h">FX</div><table class="diff"><thead><tr><th>synthdef</th><th>desktop</th><th>web</th><th>ratio</th><th>d@onset</th><th>w@onset</th><th>status</th></tr></thead><tbody>${r.fxRows.map(rowCells).join('')}</tbody></table>`
    : ''
  const stamp = fmtStamp(c.ts)
  // SV61/SV69 onset-sequence + per-tick NOTE parity line (when judged).
  const sp = r.sequenceParity
  const seqLine = ngReason ? '' : sp && sp.match !== null
    ? `<div class="totals">Onset-sequence + note parity (SV61/SV69, ε=${sp.epsilonMs}ms): <b style="color:${sp.match ? 'var(--pass)' : 'var(--fail)'}">${sp.match ? '✓ MATCH' : '✗ DIVERGE'}</b>${sp.match === false ? ` — ${esc(sp.reasons.find(x => /mis-timed|NOTE multiset|wrong notes/.test(x)) ?? sp.reasons[0] ?? 'onset/notes diverge')}` : ''}</div>`
    : ''
  return `<section class="fx-card" id="${esc(c.name)}">
  <div class="fx-head">
    <div class="fx-title">${esc(c.name)} ${verdictBadge(eff)}</div>
    <div class="fx-meta">${r.isPrng ? '<span class="tag prng">PRNG · event-parity graded (SV69)</span>' : '<span class="tag det">deterministic</span>'}
      <span class="tag">window ${c.duration / 1000}s</span>
      <span class="stamp">${esc(stamp)}</span></div>
  </div>
  <ul class="reasons">${reasons}</ul>
  ${seqLine}
  <div class="totals">Voice /s_new — desktop <b>${r.desktopTotal}</b>, web <b>${r.webTotal}</b>${r.totalRatio !== null ? ` · web <b>${r.totalRatio}×</b> desktop` : ''}</div>
  <table class="diff"><thead><tr><th>synthdef</th><th>desktop</th><th>web</th><th>ratio</th><th>d@onset</th><th>w@onset</th><th>status</th></tr></thead><tbody>${voiceRows}</tbody></table>
  ${fxRows}
  <details class="raw"><summary>raw /s_new streams + source (${c.desktop.filter((e) => e.addr === '/s_new').length} desktop · ${c.web.filter((e) => e.addr === '/s_new').length} web)</summary>
    <div class="streams">
      <div class="stream"><div class="stream-h">desktop /s_new</div>${streamRows(c.desktop) || '<div class="ev mute">none</div>'}</div>
      <div class="stream"><div class="stream-h">web /s_new</div>${streamRows(c.web) || '<div class="ev mute">none</div>'}</div>
    </div>
    <div class="src-h">source</div><pre class="src">${esc(c.code)}</pre>
  </details>
</section>`
}

// ── manifest + page ──────────────────────────────────────────────────────────
const captures = loadCaptures()
// Counts key on the EFFECTIVE verdict (SV61/SV69): structure-match + onset/note
// match = EVENT-MATCH; structure-match but onset/notes diverge = SEQUENCE-DIVERGE
// (a real divergence, the #537 PRNG class) — folded into `diverge`, not `match`.
const counts = {
  match: captures.filter((c) => isMatchEff(effectiveVerdict(c.report, c.name))).length,
  diverge: captures.filter((c) => isDivergeEff(effectiveVerdict(c.report, c.name))).length,
  empty: captures.filter((c) => effectiveVerdict(c.report, c.name).includes('EMPTY')).length,
  // #549: desktop-side non-gradeable fixtures — reported, never counted as divergers.
  nonGradeable: captures.filter((c) => effectiveVerdict(c.report, c.name) === 'NON-GRADEABLE').length,
  total: captures.length,
}
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

writeFileSync(
  join(TR, 'event-diff.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      counts,
      fixtures: captures.map((c) => ({
        name: c.name,
        verdict: effectiveVerdict(c.report, c.name), // SV61/SV69 effective (folds onset/note parity; #549 non-gradeable)
        structureVerdict: c.report.verdict,         // raw multiset verdict (pre-sequence)
        sequenceMatch: c.report.sequenceParity?.match ?? null,
        isPrng: c.report.isPrng,
        desktopTotal: c.report.desktopTotal,
        webTotal: c.report.webTotal,
        totalRatio: c.report.totalRatio,
      })),
    },
    null,
    2,
  ),
)

const cards = captures.length
  ? captures.map(fixtureCard).join('\n')
  : `<div class="empty">No event-parity captures yet. Run <code>npx tsx tools/event-parity.ts --file path/to/fixture.rb --name NAME</code> (Sonic Pi + vite must be up), then re-run this builder.</div>`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SonicPi.js — Event Diff (/s_new)</title>
<style>
  :root{
    --bg:#1a1b26;--bg-elev:#1f2335;--bg-card:#16161e;--border:#2a2e46;
    --text:#c0caf5;--text-dim:#7a85b3;--text-mute:#565f89;
    --accent:#7aa2f7;--accent2:#ff1493;
    --pass:#9ece6a;--flag:#e0af68;--fail:#f7768e;--incon:#565f89;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-size:13px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  a{color:inherit;text-decoration:none}
  .tab-bar{height:38px;display:flex;align-items:stretch;background:var(--bg-elev);
    border-bottom:1px solid var(--border);padding:0 16px;gap:2px}
  .tab-bar a{display:inline-flex;align-items:center;gap:6px;padding:0 14px;font-size:12px;
    color:var(--text-dim);border-bottom:2px solid transparent;font-family:var(--mono);
    text-transform:lowercase;letter-spacing:.04em}
  .tab-bar a:hover{color:var(--text)}
  .tab-bar a[data-active]{color:var(--accent2);border-bottom-color:var(--accent2)}
  .tab-bar .count{font-size:10px;background:var(--bg-card);color:var(--text-mute);padding:1px 6px;border-radius:8px}
  .tab-bar .spacer{flex:1}
  .tab-bar .meta{align-self:center;font-size:11px;color:var(--text-mute);font-family:var(--mono)}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 24px 60px}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .sub{color:var(--text-dim);font-size:12.5px;margin:0 0 18px;font-family:var(--mono)}
  .sub b{color:var(--text)}
  .hero{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .stat{font-family:var(--mono);font-size:12px;padding:4px 12px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border)}
  .stat b{font-size:16px}
  .stat.pass b{color:var(--pass)} .stat.fail b{color:var(--fail)} .stat.incon b{color:var(--text-mute)}
  .caveat{background:#1d1a13;border:1px solid #3a3017;border-radius:10px;padding:13px 16px;margin:14px 0 24px;font-size:12px;color:var(--text-dim);line-height:1.55}
  .caveat b{color:var(--flag)}
  .fx-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  .fx-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
  .fx-title{font-size:15px;font-weight:700;display:flex;align-items:center;gap:10px}
  .fx-meta{display:flex;gap:8px;align-items:center;font-family:var(--mono);font-size:11px;color:var(--text-mute)}
  .verdict{font-family:var(--mono);font-size:11px;padding:2px 9px;border-radius:20px}
  .verdict.pass{background:#1f2a16;color:var(--pass)}
  .verdict.fail{background:#2a151b;color:var(--fail)}
  .verdict.incon{background:#1a1c26;color:var(--text-mute)}
  .tag{font-family:var(--mono);font-size:10.5px;padding:1px 8px;border-radius:20px;background:var(--bg-elev);color:var(--text-dim)}
  .tag.prng{background:#16213a;color:var(--accent)} .tag.det{background:#1f2a16;color:var(--pass)}
  .reasons{margin:10px 0;padding-left:18px;color:var(--text-dim);font-size:12px;line-height:1.5}
  .reasons li{margin:2px 0}
  .totals{font-family:var(--mono);font-size:12px;color:var(--text-dim);margin:6px 0 10px}
  .totals b{color:var(--text)}
  table.diff{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px;margin-bottom:6px}
  table.diff th{text-align:left;color:var(--text-mute);font-weight:400;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-bottom:1px solid var(--border)}
  table.diff td{padding:3px 8px;border-bottom:1px solid #20232f}
  table.diff td.syn{color:var(--text)}
  table.diff td.num{text-align:right;color:var(--text-dim)}
  table.diff td.num.gap{color:var(--flag);font-weight:700}
  .st.pass{color:var(--pass)} .st.fail{color:var(--fail)} .st.flag{color:var(--flag)} .st.accent{color:var(--accent)} .st.mute{color:var(--text-mute)}
  .tbl-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin:8px 0 2px}
  details.raw{margin-top:8px;border-top:1px solid var(--border);padding-top:8px}
  details.raw summary{cursor:pointer;font-family:var(--mono);font-size:11.5px;color:var(--text-dim)}
  details.raw summary:hover{color:var(--text)}
  .streams{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}
  .stream-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
  .ev{display:flex;gap:8px;font-family:var(--mono);font-size:11px;padding:1px 0;border-bottom:1px solid #1c1f2b}
  .ev .evt{color:var(--text-mute);min-width:48px;text-align:right}
  .ev .evn{color:var(--accent);min-width:120px}
  .ev .evp{color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ev.mute{color:var(--text-mute)}
  .src-h{font-family:var(--mono);font-size:10.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 4px}
  pre.src{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow:auto;font-family:var(--mono);font-size:11px;color:var(--text-dim);max-height:280px;margin:0}
  .empty{font-family:var(--mono);font-size:12.5px;color:var(--text-mute);background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px}
  .empty code{color:var(--text-dim)}
  footer{margin-top:30px;color:var(--text-mute);font-family:var(--mono);font-size:11px;border-top:1px solid var(--border);padding-top:14px}
</style>
</head>
<body>
${navBlock('event-level /s_new parity · #446')}
<div class="wrap">
  <h1>Event Diff — /s_new structure: count · order · onset</h1>
  <p class="sub">Desktop Sonic Pi ↔ browser engine, the literal <b>/s_new</b> event streams (not audio). Built <b>${esc(now)}</b>. Desktop via scsynth <code>/dumpOSC</code>; web via the engine's OSC trace.</p>
  <div class="hero">
    <span class="stat pass">EVENT-MATCH <b>${counts.match}</b></span>
    <span class="stat fail">DIVERGE <b>${counts.diverge}</b></span>
    <span class="stat incon">EMPTY <b>${counts.empty}</b></span>
    <span class="stat incon">NON-GRADEABLE <b>${counts.nonGradeable}</b></span>
    <span class="stat">fixtures <b>${counts.total}</b></span>
  </div>
  <div class="caveat">
    <b>How to read this.</b> This diffs the literal /s_new streams desktop and web send to scsynth — it is the event-level companion to the audio comparator (which is opaque past desktop's audio). The verdict folds three axes: synthdef <b>structure</b> (a DROPPED significant layer is the robust divergence signal), per-synthdef <b>onset timing</b>, and per-tick <b>NOTE values</b>. <b>PRNG pieces are now fully graded</b> — post-EPIC-#531 the engine's random walk matches desktop's frozen rand-stream note-for-note (SV69, superseding the old SV49 "values not diffed" non-goal); a PRNG piece whose onset-sequence or notes diverge is a real divergence (tracked in #537). A fixed wall-clock window counts more events on the faster-progressing engine, so raw counts are prefix-compared.
  </div>
  ${cards}
  <footer>Generated by <code>tools/build-event-diff.ts</code> from <code>.captures/eventparity_*.json</code> (latest per fixture). Captures from <code>tools/event-parity.ts</code>. Re-run after new captures to refresh.</footer>
</div>
</body>
</html>
`

writeFileSync(join(TR, 'event-diff.html'), html)
console.log(`✓ wrote test_results/event-diff.html + event-diff.json`)
console.log(
  `  ${counts.total} fixtures · MATCH ${counts.match} · DIVERGE ${counts.diverge} · EMPTY ${counts.empty} · NON-GRADEABLE ${counts.nonGradeable}`,
)
