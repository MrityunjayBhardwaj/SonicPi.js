/**
 * A/B comparator — runs the same Sonic Pi snippet through BOTH desktop
 * Sonic Pi.app (via tools/capture-desktop.ts) and the SonicPi.js browser app
 * (via tools/capture.ts), then writes a side-by-side stats report.
 *
 * Useful for parity verification: "does our engine produce the same audio
 * shape as Desktop SP for this snippet?" — the desktop side is the canonical
 * reference (audio WAV is the gold standard for observation; the event log
 * is inference about what should happen, not observation of what did).
 *
 * Prereqs (BOTH must hold):
 *   1. Sonic Pi.app must be running (`open -a "Sonic Pi"` and wait ~10s).
 *   2. The browser dev server must be running (`npm run dev` on :5173).
 *
 * Usage:
 *   npx tsx tools/compare-desktop-vs-web.ts                          # default snippet
 *   npx tsx tools/compare-desktop-vs-web.ts "play 60; sleep 1"        # inline
 *   npx tsx tools/compare-desktop-vs-web.ts --file path/to/code.rb    # from file
 *   npx tsx tools/compare-desktop-vs-web.ts --file foo.rb --duration 12000
 *
 * Per-beat windowed analysis (opt-in for rhythmic content):
 *   npx tsx tools/compare-desktop-vs-web.ts --file beat.rb --bpm 120 --beats 16
 *   # → slices both WAVs into 16 windows of 0.5s each, computes per-beat
 *   #   RMS / peak / MFCC distance, identifies most-divergent beats, and
 *   #   emits a per-beat bar-chart PNG alongside the spectrogram.
 *
 * Output:
 *   .captures/compare_<ts>_<name>.md  — side-by-side stats + verdict
 *   .captures/desktop-recordings/...wav and .captures/...wav (the source WAVs)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const DEFAULT_DURATION = 8000

// ---------------------------------------------------------------------------
// Spawn helper — collect stdout, return when child exits
// ---------------------------------------------------------------------------

interface ChildResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runChild(cmd: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd: resolve(__dirname, '..') })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('error', rejectP)
    child.on('close', (code) => {
      resolveP({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// WAV stats — same impl as capture.ts and capture-desktop.ts
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
// WAV path discovery — parse the child tools' stdout
// ---------------------------------------------------------------------------

function findWavPath(stdout: string, regex: RegExp): string | null {
  const m = stdout.match(regex)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Comparison report
// ---------------------------------------------------------------------------

interface PerBeatRow {
  beat: number
  desktop_rms: number
  web_rms: number
  desktop_peak: number
  web_peak: number
  mfcc_distance: number | null
}

interface PerBeatMetrics {
  bpm: number
  beats: number
  rows: PerBeatRow[]
  most_divergent_beats: number[]
  mean_per_beat_mfcc_distance: number
  per_beat_png: string
}

interface SpectrogramMetrics {
  l2_mel_db: number
  mfcc_distance: number
  frames_compared: number
  spectrogram_png: string
  desktop_peak_freq_hz: number
  web_peak_freq_hz: number
  per_beat: PerBeatMetrics | null
}

interface ComparisonResult {
  timestamp: string
  code: string
  duration: number
  name: string
  desktop: { wavPath: string | null; stats: AudioStats | null; rawStdout: string; ok: boolean }
  web:     { wavPath: string | null; stats: AudioStats | null; rawStdout: string; ok: boolean }
  spectrogram: SpectrogramMetrics | null
  spectrogramError: string | null
  reportPath: string
}

function writeComparisonReport(r: ComparisonResult): void {
  const lines: string[] = []
  lines.push(`# Desktop ↔ Web Comparison: ${r.name}`)
  lines.push('')
  lines.push(`- **Timestamp:** ${r.timestamp}`)
  lines.push(`- **Capture window:** ${r.duration} ms`)
  lines.push('')

  lines.push('## Code')
  lines.push('```ruby')
  lines.push(r.code.trim())
  lines.push('```')
  lines.push('')

  lines.push('## Stats (Level 3 — observation, not inference)')
  lines.push('')
  lines.push('| Metric        | Desktop SP             | SonicPi.js (web)        | Δ (desk − web) |')
  lines.push('|---------------|------------------------|-------------------------|----------------|')

  const fmt = (v: number | undefined, digits = 4) =>
    v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits)

  const dStats = r.desktop.stats
  const wStats = r.web.stats

  const row = (
    label: string,
    pickD: (s: AudioStats) => number,
    pickW: (s: AudioStats) => number,
    digits = 4,
  ) => {
    const dv = dStats ? pickD(dStats) : undefined
    const wv = wStats ? pickW(wStats) : undefined
    const delta = dv !== undefined && wv !== undefined ? dv - wv : undefined
    lines.push(`| ${label} | ${fmt(dv, digits)} | ${fmt(wv, digits)} | ${fmt(delta, digits)} |`)
  }

  row('Duration (s)', s => s.duration, s => s.duration, 3)
  row('Peak',         s => s.peak,     s => s.peak)
  row('RMS',          s => s.rms,      s => s.rms)
  row('Clipping (%)', s => s.clipping, s => s.clipping, 2)
  lines.push(`| Sample rate (Hz) | ${dStats?.sampleRate ?? '—'} | ${wStats?.sampleRate ?? '—'} | ${
    dStats && wStats ? dStats.sampleRate - wStats.sampleRate : '—'
  } |`)
  lines.push(`| Channels | ${dStats?.channels ?? '—'} | ${wStats?.channels ?? '—'} | — |`)
  lines.push('')

  // Verdict — compare key metrics with simple thresholds
  lines.push('## Verdict')
  const verdicts: string[] = []
  if (!dStats) verdicts.push(`✗ Desktop produced no WAV — see desktop tool stdout in this report`)
  if (!wStats) verdicts.push(`✗ Web produced no WAV — see web tool stdout in this report`)
  if (dStats && wStats) {
    if (dStats.sampleRate !== wStats.sampleRate) {
      verdicts.push(`⚠ Sample-rate mismatch (${dStats.sampleRate} vs ${wStats.sampleRate} Hz) — RMS / peak / spectrum comparisons are at-source only, not resampled`)
    }
    const rmsRatio = dStats.rms > 0 ? wStats.rms / dStats.rms : 0
    if (rmsRatio < 0.5 || rmsRatio > 2.0) {
      verdicts.push(`⚠ RMS ratio web/desktop = ${rmsRatio.toFixed(2)}× — significant level divergence`)
    } else {
      verdicts.push(`✓ RMS ratio web/desktop = ${rmsRatio.toFixed(2)}× (within 0.5×–2× tolerance)`)
    }
    const peakRatio = dStats.peak > 0 ? wStats.peak / dStats.peak : 0
    if (peakRatio < 0.5 || peakRatio > 2.0) {
      verdicts.push(`⚠ Peak ratio web/desktop = ${peakRatio.toFixed(2)}× — significant peak divergence`)
    } else {
      verdicts.push(`✓ Peak ratio web/desktop = ${peakRatio.toFixed(2)}× (within 0.5×–2× tolerance)`)
    }
    if (dStats.clipping > 1 || wStats.clipping > 1) {
      verdicts.push(`⚠ Clipping detected (desktop ${dStats.clipping}%, web ${wStats.clipping}%)`)
    }
    const durDelta = Math.abs(dStats.duration - wStats.duration)
    if (durDelta > 1.0) {
      verdicts.push(`⚠ Duration delta ${durDelta.toFixed(2)}s — captures may not have aligned windows`)
    }
  }
  for (const v of verdicts) lines.push(`- ${v}`)
  lines.push('')

  lines.push('## Source WAVs')
  lines.push(`- **Desktop:** ${r.desktop.wavPath ?? '_(not produced)_'}`)
  lines.push(`- **Web:** ${r.web.wavPath ?? '_(not produced)_'}`)
  lines.push('')

  lines.push('## Spectrogram comparison')
  if (r.spectrogram) {
    const sp = r.spectrogram
    lines.push(`![spectrogram comparison](${sp.spectrogram_png})`)
    lines.push('')
    lines.push('| Metric | Value | Reading |')
    lines.push('|---|---|---|')
    lines.push(`| L2 distance (mel-dB) | ${sp.l2_mel_db.toFixed(2)} | < 10 = very close · 10–25 = similar shape · > 25 = divergent |`)
    lines.push(`| MFCC distance (timbre) | ${sp.mfcc_distance.toFixed(2)} | < 30 = similar · 30–80 = noticeably different · > 80 = unrelated |`)
    lines.push(`| Frames compared | ${sp.frames_compared} | overlapping window after length-aligning |`)
    lines.push(`| Peak freq desktop | ${sp.desktop_peak_freq_hz.toFixed(1)} Hz | dominant frequency |`)
    lines.push(`| Peak freq web | ${sp.web_peak_freq_hz.toFixed(1)} Hz | dominant frequency |`)
    if (sp.l2_mel_db > 25) {
      lines.push('')
      lines.push(`⚠ Spectral L2 ${sp.l2_mel_db.toFixed(2)} indicates divergent spectral content — inspect the diff panel of the PNG above.`)
    }
    if (sp.mfcc_distance > 80) {
      lines.push(`⚠ MFCC distance ${sp.mfcc_distance.toFixed(2)} indicates unrelated timbre — likely different synth or sample chain firing.`)
    }

    if (sp.per_beat) {
      const pb = sp.per_beat
      lines.push('')
      lines.push(`### Per-beat (bpm=${pb.bpm}, ${pb.beats} beats)`)
      lines.push('')
      lines.push(`![per-beat comparison](${pb.per_beat_png})`)
      lines.push('')
      lines.push('| Beat | Desktop RMS | Web RMS | RMS Δ | MFCC dist |')
      lines.push('|---|---|---|---|---|')
      for (const row of pb.rows) {
        const delta = row.desktop_rms - row.web_rms
        const mfcc = row.mfcc_distance === null ? '—' : row.mfcc_distance.toFixed(1)
        lines.push(`| ${row.beat} | ${row.desktop_rms.toFixed(4)} | ${row.web_rms.toFixed(4)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} | ${mfcc} |`)
      }
      lines.push('')
      lines.push(`- **Mean per-beat MFCC distance:** ${pb.mean_per_beat_mfcc_distance.toFixed(2)}`)
      lines.push(`- **Most divergent beats (top 3):** ${pb.most_divergent_beats.join(', ') || '—'}`)
      const silentDesktop = pb.rows.filter(r => r.desktop_rms < 0.001).map(r => r.beat)
      const silentWeb = pb.rows.filter(r => r.web_rms < 0.001).map(r => r.beat)
      if (silentDesktop.length !== silentWeb.length) {
        lines.push(`- ⚠ **Silent-beat asymmetry:** desktop silent on beats ${silentDesktop.join(',') || '(none)'} · web silent on beats ${silentWeb.join(',') || '(none)'} — likely a missed trigger on one side`)
      }
    }
  } else if (r.spectrogramError) {
    lines.push(`_Spectrogram analysis failed: ${r.spectrogramError}_`)
  } else {
    lines.push('_Spectrogram analysis skipped — both WAVs required._')
  }
  lines.push('')

  lines.push('## Tool stdout (debug)')
  lines.push('### Desktop')
  lines.push('```')
  lines.push(r.desktop.rawStdout.trim())
  lines.push('```')
  lines.push('### Web')
  lines.push('```')
  lines.push(r.web.rawStdout.trim())
  lines.push('```')

  writeFileSync(r.reportPath, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

interface CliArgs {
  code: string
  duration: number
  name: string
  bpm: number | null   // null → no per-beat analysis
  beats: number | null
}

function parseArgs(argv: string[]): CliArgs {
  let duration = DEFAULT_DURATION
  let name = 'inline'
  let code = `play 60\nsleep 1\nplay 67\nsleep 1\nplay 72\nsleep 1`
  let bpm: number | null = null
  let beats: number | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--duration') duration = parseInt(argv[++i], 10)
    else if (a === '--name') name = argv[++i]
    else if (a === '--bpm') bpm = parseFloat(argv[++i])
    else if (a === '--beats') beats = parseInt(argv[++i], 10)
    else if (a === '--file') {
      const path = argv[++i]
      code = readFileSync(path, 'utf8')
      name = basename(path).replace(/\.[^.]+$/, '')
    } else if (!a.startsWith('--')) {
      code = a
    }
  }
  // Per-beat fires only when --beats is given. If --bpm omitted, default to 60
  // (Sonic Pi default; matches the Python script's default).
  if (beats !== null && bpm === null) bpm = 60
  return { code, duration, name, bpm, beats }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`▶ A/B comparison (${args.duration}ms): ${args.name}`)
  console.log(`  Running desktop + web in parallel...`)

  mkdirSync(CAPTURES_DIR, { recursive: true })

  // Desktop tool accepts --name; web tool (capture.ts) does not — it picks the
  // name from --file basename or defaults to "inline" for raw code. So we
  // pass --name only to the desktop side and locate the web report via the
  // "Capture saved: <path>" line printed by capture.ts.
  const desktopArgs = [args.code, '--duration', String(args.duration), '--name', args.name]
  const webArgs     = [args.code, '--duration', String(args.duration)]

  const [desktop, web] = await Promise.all([
    runChild('npx', ['tsx', 'tools/capture-desktop.ts', ...desktopArgs]),
    runChild('npx', ['tsx', 'tools/capture.ts', ...webArgs]),
  ])

  // capture-desktop.ts prints: "✓ WAV:    <abs-path>"
  const desktopWav = findWavPath(desktop.stdout, /✓ WAV:\s+(\S+\.wav)/)
  // capture.ts prints: "Capture saved: <abs-path-to-md>". Read that md and
  // grep for the **File:** line (the audio path inside the report).
  let webWav: string | null = null
  const webReportMatch = web.stdout.match(/Capture saved:\s+(\S+\.md)/)
  if (webReportMatch && existsSync(webReportMatch[1])) {
    const md = readFileSync(webReportMatch[1], 'utf8')
    const m = md.match(/\*\*File:\*\*\s+`([^`]+\.wav)`/)
    if (m) webWav = m[1]
  }

  const desktopStats = desktopWav ? analyzeWav(desktopWav) : null
  const webStats = webWav ? analyzeWav(webWav) : null

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = resolve(CAPTURES_DIR, `compare_${ts}_${args.name}.md`)

  // Spectrogram + MFCC analysis via Python (librosa). Only if both WAVs exist.
  let spectrogram: SpectrogramMetrics | null = null
  let spectrogramError: string | null = null
  if (desktopWav && webWav) {
    const specOutPrefix = resolve(CAPTURES_DIR, `compare_${ts}_${args.name}_spectrogram`)
    const pyArgs = ['tools/spectrogram-compare.py', desktopWav, webWav, specOutPrefix]
    if (args.beats !== null && args.bpm !== null) {
      pyArgs.push('--bpm', String(args.bpm), '--beats', String(args.beats))
    }
    try {
      const py = await runChild('python3', pyArgs)
      if (py.exitCode === 0) {
        const jsonPath = `${specOutPrefix}.json`
        if (existsSync(jsonPath)) {
          const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
          spectrogram = {
            l2_mel_db: data.comparison.l2_mel_db,
            mfcc_distance: data.comparison.mfcc_distance,
            frames_compared: data.comparison.frames_compared,
            spectrogram_png: data.comparison.spectrogram_png,
            desktop_peak_freq_hz: data.desktop.peak_freq_hz,
            web_peak_freq_hz: data.web.peak_freq_hz,
            per_beat: data.per_beat ?? null,
          }
        }
      } else {
        spectrogramError = py.stderr.trim() || `python3 exited ${py.exitCode}`
      }
    } catch (err) {
      spectrogramError = err instanceof Error ? err.message : String(err)
    }
  }

  writeComparisonReport({
    timestamp: new Date().toISOString(),
    code: args.code,
    duration: args.duration,
    name: args.name,
    desktop: { wavPath: desktopWav, stats: desktopStats, rawStdout: desktop.stdout, ok: desktop.exitCode === 0 },
    web:     { wavPath: webWav,     stats: webStats,     rawStdout: web.stdout,     ok: web.exitCode === 0 },
    spectrogram,
    spectrogramError,
    reportPath,
  })

  console.log(`\n✓ Comparison report: ${reportPath}`)
  if (desktopStats && webStats) {
    const rmsRatio = desktopStats.rms > 0 ? webStats.rms / desktopStats.rms : 0
    const peakRatio = desktopStats.peak > 0 ? webStats.peak / desktopStats.peak : 0
    console.log(`  Desktop: peak ${desktopStats.peak} · RMS ${desktopStats.rms} · ${desktopStats.duration.toFixed(2)}s @ ${desktopStats.sampleRate}Hz`)
    console.log(`  Web:     peak ${webStats.peak} · RMS ${webStats.rms} · ${webStats.duration.toFixed(2)}s @ ${webStats.sampleRate}Hz`)
    console.log(`  Ratios:  peak ${peakRatio.toFixed(2)}× · RMS ${rmsRatio.toFixed(2)}× (web/desktop)`)
    if (spectrogram) {
      console.log(`  Spec:    L2(mel-dB)=${spectrogram.l2_mel_db.toFixed(2)} · MFCC dist=${spectrogram.mfcc_distance.toFixed(2)}`)
      console.log(`  PNG:     ${spectrogram.spectrogram_png}`)
      if (spectrogram.per_beat) {
        const pb = spectrogram.per_beat
        console.log(`  Per-beat: mean MFCC ${pb.mean_per_beat_mfcc_distance.toFixed(2)} · most divergent beats: ${pb.most_divergent_beats.join(', ')}`)
        console.log(`  PNG:      ${pb.per_beat_png}`)
      }
    } else if (spectrogramError) {
      console.log(`  ⚠ Spectrogram analysis failed: ${spectrogramError}`)
    }
  } else {
    console.log(`  ⚠ One or both sides produced no WAV — see report for stdout`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
