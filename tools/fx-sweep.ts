/**
 * FX WAV-verify sweep — runs every wired FX through the A/B comparator,
 * categorizes each as PASS / FLAG / FAIL, and writes a baseline JSON for
 * regression checks.
 *
 * Why: 40 FX are wired in src/engine/SonicPiEngine.ts:462-470 but only a
 * handful have been WAV-verified end-to-end against Desktop SP. This tool
 * raises the verified count to all of them in one shot and bakes a baseline
 * so future PRs can detect regressions with `npm run fx-sweep`.
 *
 * Prereqs (BOTH must hold):
 *   1. Sonic Pi.app must be running and healthy. The tool does an SP60 gate
 *      check (:bd_haus baseline) before sweeping.
 *   2. The browser dev server must be running on :5173.
 *
 * Usage:
 *   npx tsx tools/fx-sweep.ts                  # all 40 FX
 *   npx tsx tools/fx-sweep.ts --only reverb,echo  # subset
 *   npx tsx tools/fx-sweep.ts --skip vowel,whammy # exclude
 *   npx tsx tools/fx-sweep.ts --baseline .captures/fx-baseline.json # diff against
 *
 * Output:
 *   .captures/fx-sweep/snippet-<fx>.rb       — per-FX snippet (re-runnable)
 *   .captures/fx-sweep/<fx>.json             — sidecar metrics
 *   .captures/fx-sweep/SUMMARY.md            — PASS/FLAG/FAIL table
 *   .captures/fx-baseline.json               — baseline for regression diffs
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(__dirname, '..')
const SWEEP_DIR = resolve(ROOT_DIR, '.captures/fx-sweep')
const BASELINE_PATH = resolve(ROOT_DIR, '.captures/fx-baseline.json')

// ---------------------------------------------------------------------------
// FX list — mirrors src/engine/SonicPiEngine.ts:462-470 fx_names_fn.
// Per-FX snippet flavor:
//   "rhythmic"  → percussive bd_haus + sn_dub at 120bpm (default)
//   "sustained" → continuous prophet pad — needed for FX that operate on
//                 sustained signal (slicer, tremolo, panslicer, vowel) so the
//                 modulation has signal to chop / tremolo / vowel-shape.
// ---------------------------------------------------------------------------

type SnippetFlavor = 'rhythmic' | 'sustained'

interface FxSpec {
  name: string
  flavor: SnippetFlavor
}

const FX_LIST: FxSpec[] = [
  // Time-based / spatial
  { name: 'reverb',       flavor: 'rhythmic'  },
  { name: 'echo',         flavor: 'rhythmic'  },
  { name: 'delay',        flavor: 'rhythmic'  },
  { name: 'gverb',        flavor: 'rhythmic'  },
  { name: 'ping_pong',    flavor: 'rhythmic'  },
  // Dynamics
  { name: 'compressor',   flavor: 'rhythmic'  },
  { name: 'normaliser',   flavor: 'rhythmic'  },
  { name: 'level',        flavor: 'rhythmic'  },
  // Distortion / saturation
  { name: 'distortion',   flavor: 'rhythmic'  },
  { name: 'krush',        flavor: 'rhythmic'  },
  { name: 'bitcrusher',   flavor: 'rhythmic'  },
  { name: 'tanh',         flavor: 'rhythmic'  },
  // Modulation — these need sustained signal to be audibly different
  { name: 'slicer',       flavor: 'sustained' },
  { name: 'panslicer',    flavor: 'sustained' },
  { name: 'tremolo',      flavor: 'sustained' },
  { name: 'wobble',       flavor: 'sustained' },
  { name: 'flanger',      flavor: 'rhythmic'  },
  { name: 'chorus',       flavor: 'rhythmic'  },
  { name: 'ring_mod',     flavor: 'sustained' },
  { name: 'vowel',        flavor: 'sustained' },
  { name: 'octaver',      flavor: 'rhythmic'  },
  // Pitch
  { name: 'pitch_shift',  flavor: 'rhythmic'  },
  { name: 'whammy',       flavor: 'rhythmic'  },
  // Stereo
  { name: 'pan',          flavor: 'rhythmic'  },
  { name: 'mono',         flavor: 'rhythmic'  },
  // Genre
  { name: 'ixi_techno',   flavor: 'rhythmic'  },
  // Filters
  { name: 'rlpf',         flavor: 'rhythmic'  },
  { name: 'rhpf',         flavor: 'rhythmic'  },
  { name: 'hpf',          flavor: 'rhythmic'  },
  { name: 'lpf',          flavor: 'rhythmic'  },
  { name: 'band_eq',      flavor: 'rhythmic'  },
  { name: 'bpf',          flavor: 'rhythmic'  },
  { name: 'rbpf',         flavor: 'rhythmic'  },
  { name: 'nbpf',         flavor: 'rhythmic'  },
  { name: 'nrbpf',        flavor: 'rhythmic'  },
  { name: 'nlpf',         flavor: 'rhythmic'  },
  { name: 'nrlpf',        flavor: 'rhythmic'  },
  { name: 'nhpf',         flavor: 'rhythmic'  },
  { name: 'nrhpf',        flavor: 'rhythmic'  },
  { name: 'eq',           flavor: 'rhythmic'  },
]

const RHYTHMIC_SNIPPET = (fx: string): string =>
  `use_bpm 120
use_random_seed 42
with_fx :${fx} do
  live_loop :probe do
    sample :bd_haus
    sleep 0.5
    sample :sn_dub
    sleep 0.5
  end
end
`

const SUSTAINED_SNIPPET = (fx: string): string =>
  `use_bpm 120
use_random_seed 42
with_fx :${fx} do
  live_loop :probe do
    use_synth :prophet
    play :c4, release: 1, cutoff: 80, amp: 0.5
    sleep 1
    play :e4, release: 1, cutoff: 80, amp: 0.5
    sleep 1
  end
end
`

const renderSnippet = (fx: FxSpec): string =>
  fx.flavor === 'sustained' ? SUSTAINED_SNIPPET(fx.name) : RHYTHMIC_SNIPPET(fx.name)

// Sweep parameters — kept small + fixed so baseline is meaningful across runs.
const SWEEP_DURATION_MS = 5000
const SWEEP_BPM = 120
const SWEEP_BEATS = 8
// Two leading-beat sources of asymmetry we don't want to flag as FX bugs:
//   1. Desktop scsynth's ~2-beat warm-up before audio settles (SP22).
//   2. Web's Chromium boot is slower than Sonic Pi.app's OSC dispatch, so
//      web's recording-start lags desktop's by ~0.5 beat at 120 bpm — costing
//      one extra beat of "silent on web only" at the start.
// Total: skip first 3 beats from silent-beat asymmetry detection. The
// remaining 5 (of 8) give enough signal to detect a truly silent or wrong-FX
// path. Eyeballed from comparator runs in session 2026-05-05.
const WARMUP_BEATS = 3

// ---------------------------------------------------------------------------
// SP60 desktop-health gate
// ---------------------------------------------------------------------------

function sp60Gate(): { ok: boolean; reason: string } {
  const spiderLogPath = `${process.env.HOME}/.sonic-pi/log/spider.log`
  if (!existsSync(spiderLogPath)) {
    return { ok: false, reason: 'Sonic Pi.app does not appear to be running (spider.log missing)' }
  }
  const log = readFileSync(spiderLogPath, 'utf8')
  if (/PromiseTimeoutError|buffer_alloc/.test(log.split('\n').slice(-200).join('\n'))) {
    return { ok: false, reason: 'spider.log shows recent PromiseTimeoutError / buffer_alloc — restart Sonic Pi.app' }
  }

  // Run :bd_haus baseline through capture-desktop directly.
  console.log('[sp60] running :bd_haus desktop baseline...')
  try {
    const out = execSync(
      `npx tsx tools/capture-desktop.ts "sample :bd_haus
sleep 1" --duration 4000 --name sp60-gate`,
      { cwd: ROOT_DIR, encoding: 'utf8', timeout: 30000 },
    )
    if (!/✓ WAV:/.test(out)) {
      return { ok: false, reason: 'baseline produced no WAV — see captures/desktop_*sp60-gate.md' }
    }
    return { ok: true, reason: 'baseline WAV produced' }
  } catch (err) {
    return { ok: false, reason: `baseline failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function devServerUp(): boolean {
  try {
    execSync('curl -s -o /dev/null -w "%{http_code}" http://localhost:5173', { encoding: 'utf8', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Run one FX through the comparator
// ---------------------------------------------------------------------------

interface FxMetrics {
  fx: string
  flavor: SnippetFlavor
  desktop: { rms: number; peak: number; duration: number } | null
  web: { rms: number; peak: number; duration: number } | null
  rmsRatio: number | null   // web/desktop
  peakRatio: number | null
  l2MelDb: number | null
  mfccDist: number | null
  silentDesktopBeats: number[]
  silentWebBeats: number[]
  silentBeatAsymmetry: boolean
  meanPerBeatMfcc: number | null
  reportPath: string
  jsonPath: string
  errors: string[]
}

interface FxComparisonJson {
  desktop: { wavPath: string | null; stats: { rms: number; peak: number; duration: number } | null }
  web:     { wavPath: string | null; stats: { rms: number; peak: number; duration: number } | null }
  spectrogram: {
    l2_mel_db: number
    mfcc_distance: number
    per_beat: {
      rows: { beat: number; desktop_rms: number; web_rms: number }[]
      mean_per_beat_mfcc_distance: number
    } | null
  } | null
  reportPath: string
}

async function runFx(fx: FxSpec): Promise<FxMetrics> {
  const snippetPath = resolve(SWEEP_DIR, `snippet-${fx.name}.rb`)
  writeFileSync(snippetPath, renderSnippet(fx))

  const jsonPath = resolve(SWEEP_DIR, `${fx.name}.json`)

  return new Promise<FxMetrics>((resolveP) => {
    const child = spawn(
      'npx',
      [
        'tsx', 'tools/compare-desktop-vs-web.ts',
        '--file', snippetPath,
        '--duration', String(SWEEP_DURATION_MS),
        '--bpm', String(SWEEP_BPM),
        '--beats', String(SWEEP_BEATS),
        '--name', `fx-${fx.name}`,
        '--json-out', jsonPath,
      ],
      { cwd: ROOT_DIR },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('close', () => {
      const m: FxMetrics = {
        fx: fx.name,
        flavor: fx.flavor,
        desktop: null,
        web: null,
        rmsRatio: null,
        peakRatio: null,
        l2MelDb: null,
        mfccDist: null,
        silentDesktopBeats: [],
        silentWebBeats: [],
        silentBeatAsymmetry: false,
        meanPerBeatMfcc: null,
        reportPath: '',
        jsonPath,
        errors: [],
      }
      if (!existsSync(jsonPath)) {
        m.errors.push('comparator did not write JSON sidecar')
        m.errors.push(`stdout: ${stdout.trim().slice(-300)}`)
        if (stderr.trim()) m.errors.push(`stderr: ${stderr.trim().slice(-300)}`)
        resolveP(m)
        return
      }
      try {
        const j = JSON.parse(readFileSync(jsonPath, 'utf8')) as FxComparisonJson
        m.reportPath = j.reportPath
        m.desktop = j.desktop.stats ? {
          rms: j.desktop.stats.rms, peak: j.desktop.stats.peak, duration: j.desktop.stats.duration,
        } : null
        m.web = j.web.stats ? {
          rms: j.web.stats.rms, peak: j.web.stats.peak, duration: j.web.stats.duration,
        } : null
        if (m.desktop && m.web) {
          m.rmsRatio = m.desktop.rms > 0 ? m.web.rms / m.desktop.rms : null
          m.peakRatio = m.desktop.peak > 0 ? m.web.peak / m.desktop.peak : null
        }
        if (j.spectrogram) {
          m.l2MelDb = j.spectrogram.l2_mel_db
          m.mfccDist = j.spectrogram.mfcc_distance
          if (j.spectrogram.per_beat) {
            m.meanPerBeatMfcc = j.spectrogram.per_beat.mean_per_beat_mfcc_distance
            m.silentDesktopBeats = j.spectrogram.per_beat.rows
              .filter((r) => r.desktop_rms < 0.001).map((r) => r.beat)
            m.silentWebBeats = j.spectrogram.per_beat.rows
              .filter((r) => r.web_rms < 0.001).map((r) => r.beat)
            // Asymmetry check excludes WARMUP_BEATS leading beats — desktop's
            // scsynth needs ~2 beats to settle before audio fires (SP22). Web
            // doesn't have this delay, so beats 0..WARMUP_BEATS-1 will always
            // look asymmetric without indicating an FX bug.
            const dPost = m.silentDesktopBeats.filter((b) => b >= WARMUP_BEATS)
            const wPost = m.silentWebBeats.filter((b) => b >= WARMUP_BEATS)
            m.silentBeatAsymmetry = dPost.length !== wPost.length
          }
        }
      } catch (err) {
        m.errors.push(`failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`)
      }
      resolveP(m)
    })
  })
}

// ---------------------------------------------------------------------------
// PASS / FLAG / FAIL classification
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'FLAG' | 'FAIL'

function classify(m: FxMetrics): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = []
  // FAIL: empty WAV on either side, OR silent-beat asymmetry, OR egregious metrics
  if (!m.desktop) reasons.push('desktop produced no WAV')
  if (!m.web)     reasons.push('web produced no WAV')
  if (m.silentBeatAsymmetry) {
    const dPost = m.silentDesktopBeats.filter((b) => b >= WARMUP_BEATS)
    const wPost = m.silentWebBeats.filter((b) => b >= WARMUP_BEATS)
    reasons.push(
      `silent-beat asymmetry past warm-up: desktop silent on [${dPost.join(',') || '–'}] · web silent on [${wPost.join(',') || '–'}]`,
    )
  }
  if (!m.desktop || !m.web || m.silentBeatAsymmetry) {
    return { verdict: 'FAIL', reasons }
  }
  if (m.mfccDist !== null && m.mfccDist > 200 && m.rmsRatio !== null && (m.rmsRatio < 0.3 || m.rmsRatio > 3.0)) {
    reasons.push(`mfcc=${m.mfccDist.toFixed(0)} paired with rmsRatio=${m.rmsRatio.toFixed(2)}× — likely silent or wrong-FX path`)
    return { verdict: 'FAIL', reasons }
  }

  // FLAG: one threshold breached but not catastrophic
  if (m.rmsRatio !== null && (m.rmsRatio < 0.5 || m.rmsRatio > 2.0)) {
    reasons.push(`rms ratio ${m.rmsRatio.toFixed(2)}× outside [0.5, 2.0]`)
  }
  if (m.peakRatio !== null && (m.peakRatio < 0.5 || m.peakRatio > 2.0)) {
    reasons.push(`peak ratio ${m.peakRatio.toFixed(2)}× outside [0.5, 2.0]`)
  }
  if (m.l2MelDb !== null && m.l2MelDb > 25) {
    reasons.push(`spectral L2 ${m.l2MelDb.toFixed(2)}dB > 25 (divergent shape)`)
  }
  if (reasons.length > 0) return { verdict: 'FLAG', reasons }

  reasons.push(`rms=${m.rmsRatio?.toFixed(2)}× peak=${m.peakRatio?.toFixed(2)}× L2=${m.l2MelDb?.toFixed(1)}dB MFCC=${m.mfccDist?.toFixed(0)}`)
  return { verdict: 'PASS', reasons }
}

// ---------------------------------------------------------------------------
// Summary writer
// ---------------------------------------------------------------------------

interface SweepRow {
  fx: string
  flavor: SnippetFlavor
  verdict: Verdict
  reasons: string[]
  m: FxMetrics
}

function writeSummary(rows: SweepRow[], summaryPath: string): void {
  const counts = { PASS: 0, FLAG: 0, FAIL: 0 }
  for (const r of rows) counts[r.verdict]++

  const lines: string[] = []
  lines.push('# FX WAV-verify sweep')
  lines.push('')
  lines.push(`- **Timestamp:** ${new Date().toISOString()}`)
  lines.push(`- **Total FX:** ${rows.length}`)
  lines.push(`- **PASS:** ${counts.PASS} · **FLAG:** ${counts.FLAG} · **FAIL:** ${counts.FAIL}`)
  lines.push(`- **Sweep config:** duration=${SWEEP_DURATION_MS}ms · bpm=${SWEEP_BPM} · beats=${SWEEP_BEATS}`)
  lines.push('')
  lines.push('## Verdicts')
  lines.push('')
  lines.push('| FX | Flavor | Verdict | RMS ratio | Peak ratio | L2 (mel-dB) | MFCC dist | Reasons |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const m = r.m
    const fmtRatio = (v: number | null) => v === null ? '—' : v.toFixed(2) + '×'
    const fmt = (v: number | null) => v === null ? '—' : v.toFixed(1)
    lines.push(
      `| \`${r.fx}\` | ${r.flavor} | ${r.verdict} | ${fmtRatio(m.rmsRatio)} | ${fmtRatio(m.peakRatio)} | ${fmt(m.l2MelDb)} | ${fmt(m.mfccDist)} | ${r.reasons.join('; ')} |`,
    )
  }
  lines.push('')
  lines.push('## Methodology')
  lines.push('')
  lines.push('Each FX runs through `tools/compare-desktop-vs-web.ts` with a fixed reference snippet.')
  lines.push('Rhythmic snippet: `:bd_haus + :sn_dub` at 120 bpm, 8 beats.')
  lines.push('Sustained snippet: `:prophet` pad with sustained notes (slicer / tremolo / vowel / wobble / panslicer / ring_mod need this to have signal to modulate).')
  lines.push('')
  lines.push('Categorization rules (see issue #271):')
  lines.push('- **PASS:** RMS ratio ∈ [0.5, 2.0] · spectral L2 ≤ 25 dB · no silent-beat asymmetry')
  lines.push('- **FLAG:** any single threshold breached (eyeball needed)')
  lines.push('- **FAIL:** empty WAV on either side, silent-beat asymmetry, OR MFCC > 200 + RMS ratio outside [0.3, 3.0]')
  lines.push('')
  lines.push('## Per-FX reports')
  lines.push('')
  for (const r of rows) {
    lines.push(`- \`${r.fx}\` (${r.verdict}): [${r.m.reportPath ? 'comparator report' : 'no report'}](${r.m.reportPath}) · [json](${r.m.jsonPath})`)
  }
  writeFileSync(summaryPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SweepArgs {
  only: string[] | null
  skip: string[]
  baseline: string | null
}

function parseArgs(argv: string[]): SweepArgs {
  let only: string[] | null = null
  let skip: string[] = []
  let baseline: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') only = argv[++i].split(',').map(s => s.trim())
    else if (a === '--skip') skip = argv[++i].split(',').map(s => s.trim())
    else if (a === '--baseline') baseline = argv[++i]
  }
  return { only, skip, baseline }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  mkdirSync(SWEEP_DIR, { recursive: true })

  // Preconditions
  console.log('[precondition] checking dev server on :5173...')
  if (!devServerUp()) {
    console.error('✗ dev server not responding on :5173. Run `npm run dev` and retry.')
    process.exit(1)
  }
  console.log('  ✓ dev server up')

  console.log('[precondition] SP60 desktop-health gate...')
  const gate = sp60Gate()
  if (!gate.ok) {
    console.error(`✗ SP60 gate failed: ${gate.reason}`)
    console.error('  Restart Sonic Pi.app and retry.')
    process.exit(1)
  }
  console.log(`  ✓ ${gate.reason}`)

  // Filter FX list
  let fxToRun = FX_LIST
  if (args.only) fxToRun = fxToRun.filter(f => args.only!.includes(f.name))
  if (args.skip.length) fxToRun = fxToRun.filter(f => !args.skip.includes(f.name))

  console.log(`\n▶ Sweeping ${fxToRun.length} FX (of ${FX_LIST.length} total)`)
  console.log(`  duration=${SWEEP_DURATION_MS}ms · bpm=${SWEEP_BPM} · beats=${SWEEP_BEATS}\n`)

  const rows: SweepRow[] = []
  for (let i = 0; i < fxToRun.length; i++) {
    const fx = fxToRun[i]
    process.stdout.write(`[${i + 1}/${fxToRun.length}] :${fx.name} (${fx.flavor})... `)
    const m = await runFx(fx)
    const cls = classify(m)
    rows.push({ fx: fx.name, flavor: fx.flavor, verdict: cls.verdict, reasons: cls.reasons, m })
    const tag = cls.verdict === 'PASS' ? '✓' : cls.verdict === 'FLAG' ? '⚠' : '✗'
    console.log(`${tag} ${cls.verdict}`)
    if (cls.verdict !== 'PASS') {
      for (const reason of cls.reasons) console.log(`     ${reason}`)
    }
  }

  const summaryPath = resolve(SWEEP_DIR, 'SUMMARY.md')
  writeSummary(rows, summaryPath)

  // Baseline JSON: small, programmatic shape
  const baseline: Record<string, { verdict: Verdict; rmsRatio: number | null; peakRatio: number | null; l2MelDb: number | null; mfccDist: number | null }> = {}
  for (const r of rows) {
    baseline[r.fx] = {
      verdict: r.verdict,
      rmsRatio: r.m.rmsRatio,
      peakRatio: r.m.peakRatio,
      l2MelDb: r.m.l2MelDb,
      mfccDist: r.m.mfccDist,
    }
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))

  const counts = { PASS: 0, FLAG: 0, FAIL: 0 }
  for (const r of rows) counts[r.verdict]++

  console.log(`\n✓ Summary: ${summaryPath}`)
  console.log(`✓ Baseline: ${BASELINE_PATH}`)
  console.log(`  PASS ${counts.PASS} · FLAG ${counts.FLAG} · FAIL ${counts.FAIL} (of ${rows.length})`)

  // Diff against prior baseline if requested
  if (args.baseline && existsSync(args.baseline)) {
    console.log(`\n▶ Diffing against ${args.baseline}`)
    const prior = JSON.parse(readFileSync(args.baseline, 'utf8')) as typeof baseline
    let regressed = 0
    let improved = 0
    for (const r of rows) {
      const p = prior[r.fx]
      if (!p) continue
      if (p.verdict === 'PASS' && r.verdict !== 'PASS') {
        console.log(`  ✗ regression: ${r.fx} ${p.verdict} → ${r.verdict}`)
        regressed++
      } else if (p.verdict !== 'PASS' && r.verdict === 'PASS') {
        console.log(`  ✓ improvement: ${r.fx} ${p.verdict} → ${r.verdict}`)
        improved++
      }
    }
    console.log(`  ${regressed} regressed · ${improved} improved`)
    if (regressed > 0) process.exitCode = 1
  }

  if (counts.FAIL > 0) process.exitCode = process.exitCode ?? 1
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
