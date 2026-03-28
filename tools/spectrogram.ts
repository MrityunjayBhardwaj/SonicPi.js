/**
 * Audio analysis tool — captures the event log from the browser,
 * maps events to frequencies, analyzes note patterns and timing.
 *
 * Since Playwright can't access the AnalyserNode (page isolation),
 * we analyze the structured event stream which IS the music:
 * every note/sample the engine plays is logged with MIDI note + synth + time.
 *
 * Usage:
 *   npx tsx tools/spectrogram.ts "live_loop :t do; play 60; sleep 1; end"
 *   npx tsx tools/spectrogram.ts --file code.rb --duration 8000
 */

import { firefox } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function midiToName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`
}

interface AudioEvent {
  time: number
  synth: string
  note: number | null
}

async function captureEvents(code: string, duration: number): Promise<{
  events: AudioEvent[]
  errors: string[]
  appConsole: string
}> {
  const browser = await firefox.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  await page.locator('.spw-btn-label:has-text("Run")').click()
  await page.waitForTimeout(duration)

  const appText = await page.locator('#app').textContent() ?? ''
  await page.keyboard.press('Escape')
  await context.close()
  await browser.close()

  // Extract console section
  let appConsole = ''
  const start = appText.indexOf('Happy live coding!')
  if (start >= 0) appConsole = appText.slice(start)

  // Parse events
  const eventPattern = /\{run:\d+, t:([\d.]+)\}(\w+)(?: note:(\d+))?/g
  const events: AudioEvent[] = []
  let match
  while ((match = eventPattern.exec(appConsole)) !== null) {
    events.push({
      time: parseFloat(match[1]),
      synth: match[2],
      note: match[3] ? parseInt(match[3]) : null,
    })
  }

  // Check for errors
  const errors: string[] = []
  const errorPatterns = ['not a function', 'not defined', 'Something went wrong', 'Error in loop', "isn't available"]
  for (const p of errorPatterns) {
    if (appConsole.includes(p)) {
      const idx = appConsole.indexOf(p)
      errors.push(appConsole.slice(Math.max(0, idx - 60), idx + 120).trim())
    }
  }

  return { events, errors, appConsole }
}

function analyze(code: string, events: AudioEvent[], errors: string[], duration: number): string {
  const lines: string[] = []

  lines.push('# Audio Analysis Report\n')
  lines.push(`**Duration:** ${duration}ms | **Events:** ${events.length} | **Errors:** ${errors.length}\n`)

  lines.push('## Code\n```ruby')
  lines.push(code)
  lines.push('```\n')

  // Errors
  if (errors.length > 0) {
    lines.push('## ✗ Errors\n')
    for (const e of errors) lines.push(`- ${e}`)
    lines.push('')
  }

  if (events.length === 0) {
    lines.push('## ✗ No events — engine produced no sound\n')
    return lines.join('\n')
  }

  // ─── Note sequence table ───
  lines.push('## Event Timeline\n')
  lines.push('| # | Time (s) | Synth/Sample | MIDI | Note | Freq (Hz) |')
  lines.push('|---|----------|-------------|------|------|-----------|')
  for (let i = 0; i < Math.min(events.length, 40); i++) {
    const e = events[i]
    const note = e.note != null ? midiToName(e.note) : '-'
    const freq = e.note != null ? midiToFreq(e.note).toFixed(1) : '-'
    lines.push(`| ${i + 1} | ${e.time.toFixed(3)} | ${e.synth} | ${e.note ?? '-'} | ${note} | ${freq} |`)
  }
  if (events.length > 40) lines.push(`\n... (${events.length - 40} more events)`)
  lines.push('')

  // ─── Per-synth analysis ───
  const synthGroups = new Map<string, AudioEvent[]>()
  for (const e of events) {
    if (!synthGroups.has(e.synth)) synthGroups.set(e.synth, [])
    synthGroups.get(e.synth)!.push(e)
  }

  for (const [synth, synthEvents] of synthGroups) {
    lines.push(`### ${synth}\n`)

    // Timing
    const times = synthEvents.map(e => e.time)
    if (times.length >= 2) {
      const gaps = times.slice(1).map((t, i) => t - times[i])
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const min = Math.min(...gaps)
      const max = Math.max(...gaps)
      const jitter = max - min
      lines.push(`**Timing:** ${times.length} events, avg interval ${avg.toFixed(3)}s (${min.toFixed(3)}–${max.toFixed(3)}s, jitter ${jitter.toFixed(3)}s)`)

      // Estimate BPM from timing
      if (avg > 0) {
        const beatsPerSec = 1 / avg
        const estimatedBPM = beatsPerSec * 60
        lines.push(`**Estimated tempo:** ~${estimatedBPM.toFixed(0)} BPM (if sleep 1) or ~${(estimatedBPM * 2).toFixed(0)} BPM (if sleep 0.5)`)
      }
    }

    // Notes
    const noteEvents = synthEvents.filter(e => e.note != null)
    if (noteEvents.length > 0) {
      const noteSeq = noteEvents.map(e => e.note!)
      const uniqueNotes = [...new Set(noteSeq)].sort((a, b) => a - b)

      lines.push(`**Notes played:** ${uniqueNotes.map(n => `${midiToName(n)} (MIDI ${n}, ${midiToFreq(n).toFixed(1)}Hz)`).join(', ')}`)
      lines.push(`**Sequence:** ${noteSeq.map(n => midiToName(n)).join(' → ')}`)

      // Detect repeating pattern
      let foundPattern = false
      for (let patLen = 1; patLen <= Math.min(8, Math.floor(noteSeq.length / 2)); patLen++) {
        const pattern = noteSeq.slice(0, patLen)
        let repeats = true
        for (let i = patLen; i < noteSeq.length; i++) {
          if (noteSeq[i] !== pattern[i % patLen]) { repeats = false; break }
        }
        if (repeats) {
          lines.push(`**Repeating pattern (period ${patLen}):** ${pattern.map(n => midiToName(n)).join(' → ')}`)
          foundPattern = true
          break
        }
      }
      if (!foundPattern && noteSeq.length >= 4) {
        lines.push('**No repeating pattern detected** — notes appear random (choose/rrand)')
      }

      // Frequency range
      const minFreq = midiToFreq(Math.min(...uniqueNotes))
      const maxFreq = midiToFreq(Math.max(...uniqueNotes))
      lines.push(`**Frequency range:** ${minFreq.toFixed(1)}Hz – ${maxFreq.toFixed(1)}Hz`)
    } else {
      lines.push('**Notes:** none (sample-only)')
    }
    lines.push('')
  }

  // ─── Overall diagnosis ───
  lines.push('## Diagnosis\n')

  const allNotes = events.filter(e => e.note != null).map(e => e.note!)
  const uniqueAllNotes = new Set(allNotes)

  if (uniqueAllNotes.size === 0) {
    lines.push('- Samples only — no pitched content to analyze')
  } else if (uniqueAllNotes.size === 1) {
    lines.push(`- ⚠ **Only one pitch detected** (${midiToName([...uniqueAllNotes][0])}). If code uses ring/tick/choose, this may indicate a bug.`)
  } else {
    lines.push(`- ✓ ${uniqueAllNotes.size} distinct pitches detected`)
  }

  // Check timing consistency
  for (const [synth, synthEvents] of synthGroups) {
    const times = synthEvents.map(e => e.time)
    if (times.length >= 3) {
      const gaps = times.slice(1).map((t, i) => t - times[i])
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const maxDev = Math.max(...gaps.map(g => Math.abs(g - avg)))
      if (maxDev > avg * 0.2) {
        lines.push(`- ⚠ **Timing jitter on ${synth}:** ${((maxDev / avg) * 100).toFixed(0)}% deviation from average interval`)
      } else {
        lines.push(`- ✓ ${synth} timing stable (${((maxDev / avg) * 100).toFixed(0)}% deviation)`)
      }
    }
  }

  if (errors.length > 0) {
    lines.push(`- ✗ ${errors.length} runtime error(s) detected`)
  } else {
    lines.push('- ✓ No runtime errors')
  }

  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  mkdirSync(CAPTURES_DIR, { recursive: true })

  let code = ''
  let duration = 8000

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') code = readFileSync(args[++i], 'utf-8')
    else if (args[i] === '--duration') duration = parseInt(args[++i])
    else if (!args[i].startsWith('--')) code = args[i]
  }

  if (!code) {
    code = `live_loop :t do\n  play 60\n  sleep 1\nend`
  }

  console.log('Capturing audio events...')
  const { events, errors, appConsole } = await captureEvents(code, duration)
  console.log(`Captured ${events.length} events, ${errors.length} errors`)

  const report = analyze(code, events, errors, duration)
  const reportPath = resolve(CAPTURES_DIR, 'spectrogram.md')
  writeFileSync(reportPath, report)
  console.log(`\nReport: ${reportPath}`)

  // Print key findings to console
  const allNotes = events.filter(e => e.note != null).map(e => e.note!)
  if (allNotes.length > 0) {
    const unique = [...new Set(allNotes)]
    console.log(`\nNotes: ${unique.map(n => `${midiToName(n)} (${midiToFreq(n).toFixed(0)}Hz)`).join(', ')}`)
    console.log(`Pattern: ${allNotes.slice(0, 16).map(n => midiToName(n)).join(' → ')}${allNotes.length > 16 ? '...' : ''}`)
  }
  if (errors.length > 0) {
    console.log(`\nErrors:`)
    for (const e of errors) console.log(`  ✗ ${e}`)
  }
}

main().catch((err) => {
  console.error('Analysis failed:', err)
  process.exit(1)
})
