/**
 * build-gate-detail.ts — a single self-contained detail page for the 7
 * PRNG-free non-heavy official rows that make up the launch gate
 * (gate-report.ts denominator). For each row it embeds:
 *   - the verdict + how it was graded (projection / raw-refreshed / raw-sweep)
 *   - the .rb snippet (the reproducer or the example source)
 *   - playable desktop.wav + web.wav (end-to-end audio, both sides)
 *   - the A/B spectrogram image
 *   - the FULL comparison report (all 6 tiers) rendered from markdown
 *
 * Why: the 7 gate reports are scattered .md files in .captures/ and
 * test_results/examples-sweep/<slug>/. This mirrors each row's artifacts into
 * test_results/gate-detail/<example>/ and renders one page so the gate's
 * evidence is browsable + audible in one place.
 *
 * Artifacts are resolved by parsing each report's "## Source WAVs" section
 * (**Desktop:** / **Web:** absolute paths) and its "![spectrogram comparison]"
 * image — uniform across both report locations.
 *
 * Usage: npx tsx tools/build-gate-detail.ts
 *   Writes test_results/gate-detail.html + test_results/gate-detail/<ex>/*.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import { navBlock } from './lib/dashboard-nav.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TR = join(ROOT, 'test_results')
const OUT_DIR = join(TR, 'gate-detail')

// --public (or DASHBOARD_PUBLIC=1) → user-facing HTML: scrub internal catalogue
// codes, PRNG framing and file:line citations from the embedded reports + notes,
// and drop the methodology header prose. Verdict badges, audio, snippet,
// spectrogram and the 6-tier stats stay.
const PUBLIC = process.argv.includes('--public') || process.env.DASHBOARD_PUBLIC === '1'

// Scrub free-text (report markdown + row notes) for public mode: catalogue codes,
// PRNG framing, EPIC refs, and file:line code citations. Markdown-safe.
function scrub(s: string): string {
  if (!PUBLIC) return s
  return s
    // file:line citations, e.g. server.rb:345,672 or SoundLayer.ts:380-387
    .replace(/\b[\w./-]+\.(?:rb|ts|js|tsx|mjs):\d+(?:[-,]\d+)*\b/g, '')
    // EPIC #531 / Post-EPIC-#531
    .replace(/[-,]?\s*\bEPIC[-\s]*#?\d+/gi, '')
    // code parentheticals
    .replace(/\(\s*(?:SV|SP|SK)\d+(?:\s*[\/,]\s*(?:SV|SP|SK)?\d+)*\s*\)/g, '')
    .replace(/\b(?:SV|SP|SK)\d+\b/g, '')
    .replace(/\bPRNG[- ]?(?:variant|driven|free|values?)?\b/gi, 'randomness')
    .replace(/\brandom[- ]?walk\b/gi, 'randomness')
    .replace(/\brand-stream\b/gi, 'randomness')
    .replace(/\bConfounded\b/g, 'Affected')
    .replace(/\bConfound\b/g, 'Caveat')
    // cleanup
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/[ \t]{2,}/g, ' ')
}

interface Row {
  ex: string
  via: 'projection' | 'raw-refreshed' | 'raw-sweep'
  verdict: string
  report: string          // path relative to ROOT
  snippet: string         // path relative to ROOT
  note: string
}

// The 7 = gate-report.ts denominator (PRNG-free, non-heavy official rows).
const ROWS: Row[] = [
  { ex: 'chord_inversions', via: 'projection',    verdict: 'event-match', report: '.captures/compare_2026-05-29T16-00-01-355Z_chord_inversions.md', snippet: 'tools/gate-reproducers/chord_inversions.rb', note: 'Instrument-friendly projection of the chord-inversion logic; PITCH/onset parity over the shared layer.' },
  { ex: 'reich_phase',      via: 'projection',    verdict: 'event-match', report: '.captures/compare_2026-06-01T07-49-58-016Z_reich_phase_proj.md',   snippet: 'tools/gate-reproducers/reich_phase.rb',      note: 'Projection of the phasing live_loops; first-12-note prefix identical desktop↔web.' },
  { ex: 'driving_pulse',    via: 'projection',    verdict: 'event-match', report: '.captures/compare_2026-06-01T07-48-15-226Z_driving_pulse_proj.md', snippet: 'tools/gate-reproducers/driving_pulse.rb',    note: 'Projection of the driving-pulse sequence.' },
  { ex: 'monday_blues',     via: 'projection',    verdict: 'event-match', report: '.captures/compare_2026-05-29T15-58-36-335Z_monday_blues.md',      snippet: 'tools/gate-reproducers/monday_blues.rb',     note: 'Projection of the monday_blues melody.' },
  { ex: 'mod_303_phade',    via: 'raw-refreshed', verdict: 'match',       report: '.captures/compare_2026-05-30T19-32-34-562Z_mod_303_phade.md',      snippet: 'test_results/examples-sweep/incubation__mod_303_phade/snippet.rb', note: 'Re-measured on the fixed engine (SV55 #419/#420 + FX-ordering fix 30d2d4a). Raw Tier-1 PITCH-MATCH (note 45 = correct tb303). ~3% residual silent-run flake tracked in #424.' },
  { ex: 'bach',             via: 'raw-sweep',     verdict: 'event-match', report: 'test_results/examples-sweep/sorcerer__bach/report.md',           snippet: 'test_results/examples-sweep/sorcerer__bach/snippet.rb',  note: 'Gradeable for the first time post-#502 (window bounded 103.68s → 7.68s). STRUCTURE + onset-sequence parity = EVENT-MATCH.' },
  { ex: 'dark_neon',        via: 'raw-sweep',     verdict: 'event-match', report: 'test_results/examples-sweep/incubation__dark_neon/report.md',    snippet: 'test_results/examples-sweep/incubation__dark_neon/snippet.rb', note: 'Sustained note + sample texture; SV61 onset-sequence parity grades it without a pitch-melody axis = EVENT-MATCH.' },
]

function parseArtifacts(md: string) {
  const dm = md.match(/\*\*Desktop:\*\*\s*(\S+)/)
  const wm = md.match(/\*\*Web:\*\*\s*(\S+)/)
  const sm = md.match(/!\[spectrogram comparison\]\((\S+?)\)/)
  return { desktop: dm?.[1], web: wm?.[1], spectro: sm?.[1] }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const verdictClass = (v: string) => v.includes('match') ? 'ok' : (v === 'inconcl' ? 'warn' : 'bad')

mkdirSync(OUT_DIR, { recursive: true })

const sections: string[] = []
const toc: string[] = []
let copiedWav = 0, copiedPng = 0, missing: string[] = []

for (const row of ROWS) {
  const reportAbs = join(ROOT, row.report)
  if (!existsSync(reportAbs)) { missing.push(`${row.ex}: report ${row.report}`); continue }
  let md = readFileSync(reportAbs, 'utf8')
  const art = parseArtifacts(md)
  const rowDir = join(OUT_DIR, row.ex)
  mkdirSync(rowDir, { recursive: true })

  // Resolve + copy artifacts. Prefer parsed Source-WAVs; fall back to slug-dir local copies.
  const slugLocal = (name: string) => join(dirname(reportAbs), name)
  function place(srcAbs: string | undefined, fallbackName: string, destName: string): string | null {
    let src = srcAbs && existsSync(srcAbs) ? srcAbs : (existsSync(slugLocal(fallbackName)) ? slugLocal(fallbackName) : null)
    if (!src) return null
    copyFileSync(src, join(rowDir, destName))
    return `gate-detail/${row.ex}/${destName}`
  }
  const desktopRel = place(art.desktop, 'desktop.wav', 'desktop.wav')
  const webRel     = place(art.web,     'web.wav',     'web.wav')
  const spectroRel = place(art.spectro, 'spectrogram.png', 'spectrogram.png')
  if (desktopRel) copiedWav++; else missing.push(`${row.ex}: desktop.wav`)
  if (webRel) copiedWav++; else missing.push(`${row.ex}: web.wav`)
  if (spectroRel) copiedPng++; else missing.push(`${row.ex}: spectrogram.png`)

  // Rewrite absolute artifact paths inside the md → the local copies, so the
  // rendered report's links/images resolve relative to this page.
  if (art.spectro) md = md.split(art.spectro).join(spectroRel ?? art.spectro)
  if (art.desktop && desktopRel) md = md.split(art.desktop).join(desktopRel)
  if (art.web && webRel) md = md.split(art.web).join(webRel)

  const snippetAbs = join(ROOT, row.snippet)
  const snippet = existsSync(snippetAbs) ? readFileSync(snippetAbs, 'utf8') : '(snippet not found)'

  // Public mode: scrub the report markdown BEFORE rendering so codes / PRNG /
  // file:line citations never reach the HTML. Dev mode renders it verbatim.
  const reportHtml = marked.parse(scrub(md)) as string
  const anchor = row.ex
  toc.push(`<a href="#${anchor}" class="toc-chip ${verdictClass(row.verdict)}">${esc(row.ex)} <span>${esc(row.verdict)}</span></a>`)

  sections.push(`
  <section id="${anchor}" class="row">
    <div class="row-head">
      <h2>${esc(row.ex)}</h2>
      <span class="badge ${verdictClass(row.verdict)}">${esc(row.verdict)}</span>
      <span class="via">graded via ${esc(row.via)}</span>
      <a class="top" href="#top">↑ top</a>
    </div>
    <p class="note">${esc(scrub(row.note))}</p>
    <div class="players">
      <figure><figcaption>🖥️ Desktop Sonic Pi</figcaption>${desktopRel ? `<audio controls preload="none" src="${desktopRel}"></audio>` : '<em>audio unavailable</em>'}</figure>
      <figure><figcaption>🌐 SonicWeb (web)</figcaption>${webRel ? `<audio controls preload="none" src="${webRel}"></audio>` : '<em>audio unavailable</em>'}</figure>
    </div>
    <details class="snippet"><summary>📄 ${esc(row.snippet.split('/').pop() ?? 'snippet')}</summary><pre><code>${esc(snippet)}</code></pre></details>
    ${spectroRel ? `<details open class="spectro"><summary>🎛️ A/B spectrogram</summary><img loading="lazy" src="${spectroRel}" alt="${esc(row.ex)} spectrogram"></details>` : ''}
    <details open class="report"><summary>📊 Full comparison report (6 tiers)</summary><div class="md">${reportHtml}</div></details>
  </section>`)
}

const generatedNote = missing.length ? `<p class="missing">⚠ missing artifacts: ${esc(missing.join(' · '))}</p>` : ''

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SonicWeb — Launch-Gate Detail (7 rows)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.6 -apple-system, system-ui, sans-serif; margin: 0; background: #0e1014; color: #e6e6e6; }
  a { color: #6cb6ff; }
  header { padding: 20px 24px; background: #15181f; border-bottom: 1px solid #262b36; }
  header h1 { margin: 0 0 6px; font-size: 20px; }
  header p { margin: 4px 0; color: #9aa4b2; max-width: 80ch; }
  .hero { display: inline-block; margin-top: 8px; padding: 6px 12px; border-radius: 8px; background: #133a1f; color: #7ee787; font-weight: 600; border: 1px solid #2ea04326; }
  .links { margin-top: 10px; }
  .links a { margin-right: 16px; }
  .toc { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 24px; background: #11141a; border-bottom: 1px solid #262b36; position: sticky; top: 0; z-index: 10; }
  .toc-chip { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 999px; background: #1b2029; text-decoration: none; color: #cfd6e0; font-size: 12px; border: 1px solid #2a313d; }
  .toc-chip span { opacity: .7; font-size: 11px; }
  .toc-chip.ok { border-color: #2ea04355; } .toc-chip.warn { border-color: #9e6a0355; } .toc-chip.bad { border-color: #b6232355; }
  main { padding: 8px 24px 64px; max-width: 1100px; margin: 0 auto; }
  .row { margin: 28px 0; padding: 18px 20px; background: #12151c; border: 1px solid #232a36; border-radius: 12px; }
  .row-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .row-head h2 { margin: 0; font-size: 18px; }
  .badge { padding: 3px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: #133a1f; color: #7ee787; } .badge.warn { background: #3a2f13; color: #e7c87e; } .badge.bad { background: #3a1313; color: #e77e7e; }
  .via { color: #9aa4b2; font-size: 12px; }
  .top { margin-left: auto; font-size: 12px; color: #6b7280; text-decoration: none; }
  .note { color: #aab3c0; margin: 8px 0 14px; }
  .players { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0 14px; }
  .players figure { margin: 0; flex: 1 1 320px; }
  .players figcaption { font-size: 12px; color: #9aa4b2; margin-bottom: 4px; }
  .players audio { width: 100%; }
  details { margin: 10px 0; border: 1px solid #232a36; border-radius: 8px; background: #0f1218; }
  summary { cursor: pointer; padding: 8px 12px; font-weight: 600; color: #cfd6e0; user-select: none; }
  details > *:not(summary) { padding: 0 14px 12px; }
  pre { overflow-x: auto; background: #0a0c10; padding: 12px !important; border-radius: 6px; margin: 0 14px 12px; }
  code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .spectro img { max-width: 100%; border-radius: 6px; display: block; }
  .md { color: #d6dce4; }
  .md h1, .md h2, .md h3 { color: #e6e6e6; border-bottom: 1px solid #232a36; padding-bottom: 4px; margin-top: 18px; }
  .md table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12.5px; }
  .md th, .md td { border: 1px solid #2a313d; padding: 5px 9px; text-align: left; }
  .md th { background: #1b2029; }
  .md code { background: #0a0c10; padding: 1px 5px; border-radius: 4px; }
  .md pre code { background: none; padding: 0; }
  .md img { max-width: 100%; }
  .missing { color: #e7c87e; }
</style></head>
<body>
<a id="top"></a>
${navBlock('desktop ↔ web parity · launch-gate evidence')}
<header>
  <h1>Launch-Gate Detail — the deterministic core rows</h1>
  <p>${PUBLIC
    ? 'These are the deterministic, non-heavy official rows — the ones held to exact desktop parity (the right notes at the right times). See the <a href="launch-gate.html">launch-gate page</a> for the full roster and the live pass percentage.'
    : 'These are the PRNG-free, non-heavy official rows — the instrument-blind ones graded via projection plus the deterministic raw-sweep rows. On them the engine is held to exact desktop parity. <strong>Post-EPIC-#531 the gate denominator also includes the PRNG-driven rows</strong>, now graded by <code>/s_new</code> event-parity (the random walk matches desktop note-for-note, SV69 — the SV49 non-goal is retired); see the <a href="launch-gate.html">launch-gate page</a> for the full roster and the live pass percentage.'}</p>
  <div class="hero">Deterministic core &middot; all EVENT-MATCH / MATCH</div>
  ${generatedNote}
  <div class="links">
    <a href="index.html">← aggregate index</a>
    <a href="launch-gate.html">launch-gate page</a>
    <a href="examples-sweep.html">official sweep (all 34)</a>
  </div>
</header>
<nav class="toc">${toc.join('')}</nav>
<main>
${sections.join('\n')}
</main>
</body></html>`

writeFileSync(join(TR, 'gate-detail.html'), html)
console.log(`✓ wrote test_results/gate-detail.html — ${ROWS.length - 0} rows, ${copiedWav} WAVs + ${copiedPng} spectrograms copied to test_results/gate-detail/`)
if (missing.length) console.log(`  ⚠ missing: ${missing.join(' · ')}`)
