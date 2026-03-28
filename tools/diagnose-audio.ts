/**
 * Audio diagnostic tool — compares expected vs actual musical events.
 *
 * Approach:
 * 1. Transpile code → build Program via ProgramBuilder → query expected events
 * 2. Run code in real browser → capture actual SoundEvent stream
 * 3. Diff: what should have happened vs what did happen
 *
 * Output: .captures/diagnosis_<name>.md with event-by-event comparison.
 *
 * Usage:
 *   npx tsx tools/diagnose-audio.ts "live_loop :t do; play 60; sleep 1; end"
 *   npx tsx tools/diagnose-audio.ts --file path/to/code.rb
 */

import { firefox, type Browser } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { ProgramBuilder } from '../src/engine/ProgramBuilder'
import { initTreeSitter, treeSitterTranspile, isTreeSitterReady } from '../src/engine/TreeSitterTranspiler'
import { queryLoopProgram, type QueryEvent } from '../src/engine/interpreters/QueryInterpreter'
import { ring } from '../src/engine/Ring'
import { spread } from '../src/engine/EuclideanRhythm'
import { chord, scale, chord_invert, note, note_range } from '../src/engine/ChordScale'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURES_DIR = resolve(__dirname, '../.captures')
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

// ---------------------------------------------------------------------------
// Step 1: Get EXPECTED events from QueryInterpreter
// ---------------------------------------------------------------------------

interface ExpectedEvent {
  time: number
  type: 'synth' | 'sample'
  synth?: string
  note?: number
  sampleName?: string
}

async function getExpectedEvents(code: string, duration: number): Promise<{
  events: ExpectedEvent[]
  loops: string[]
  transpileErrors: string[]
}> {
  // Init tree-sitter for Node
  const tsWasm = resolve(__dirname, '../node_modules/web-tree-sitter/tree-sitter.wasm')
  const rubyWasm = resolve(__dirname, '../node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm')
  if (!isTreeSitterReady()) {
    await initTreeSitter({ treeSitterWasmUrl: tsWasm, rubyWasmUrl: rubyWasm })
  }

  const tsResult = treeSitterTranspile(code)
  if (!tsResult.ok) {
    return { events: [], loops: [], transpileErrors: tsResult.errors }
  }

  // Execute transpiled code to capture builder functions
  const loops: { name: string; builder: ProgramBuilder }[] = []
  const live_loop = (name: string, fn: (b: ProgramBuilder) => void) => {
    const b = new ProgramBuilder(42)
    try { fn(b) } catch { /* stop signals etc */ }
    loops.push({ name, builder: b })
  }
  const use_bpm = () => {}
  const use_synth = () => {}
  const use_random_seed = () => {}
  const puts = () => {}
  const stop = () => {}
  const stop_loop = () => {}
  const set = () => {}
  const get = new Proxy({}, { get: () => null })
  const in_thread = (fn: (b: ProgramBuilder) => void) => fn(new ProgramBuilder())
  const at = () => {}
  const density = () => {}
  const with_fx = (_name: string, ...args: any[]) => {
    const fn = args[args.length - 1]
    if (typeof fn === 'function') fn(null) // top-level: no builder
  }
  const sample_duration = () => 1
  const sample_names = () => []
  const sample_groups = () => []
  const sample_loaded = () => false

  try {
    const fn = new Function(
      'live_loop', 'use_bpm', 'use_synth', 'use_random_seed',
      'puts', 'stop', 'stop_loop', 'set', 'get',
      'in_thread', 'at', 'density', 'with_fx',
      'ring', 'spread', 'chord', 'scale', 'chord_invert', 'note', 'note_range',
      'sample_duration', 'sample_names', 'sample_groups', 'sample_loaded',
      tsResult.code,
    )
    fn(
      live_loop, use_bpm, use_synth, use_random_seed,
      puts, stop, stop_loop, set, get,
      in_thread, at, density, with_fx,
      ring, spread, chord, scale, chord_invert, note, note_range,
      sample_duration, sample_names, sample_groups, sample_loaded,
    )
  } catch (e: any) {
    return { events: [], loops: [], transpileErrors: [`Execution error: ${e.message}`] }
  }

  // Query each loop for events in the time range
  const bpm = 60
  const beatsInDuration = (duration / 1000) * (bpm / 60)
  const allEvents: ExpectedEvent[] = []
  const loopNames: string[] = []

  for (const loop of loops) {
    loopNames.push(loop.name)
    const program = loop.builder.build()
    // Query multiple iterations by tiling
    const events = queryLoopProgram(program, 0, beatsInDuration, bpm)
    for (const e of events) {
      allEvents.push({
        time: e.time,
        type: e.type,
        synth: e.params.synth as string | undefined,
        note: e.params.note as number | undefined,
        sampleName: e.type === 'sample' ? (e.params.name as string) : undefined,
      })
    }
  }

  allEvents.sort((a, b) => a.time - b.time)
  return { events: allEvents, loops: loopNames, transpileErrors: [] }
}

// ---------------------------------------------------------------------------
// Step 2: Get ACTUAL events from the browser
// ---------------------------------------------------------------------------

interface ActualEvent {
  time: number
  synth: string | null
  note: number | null
  trackId: string | null
}

async function getActualEvents(browser: Browser, code: string, duration: number): Promise<{
  events: ActualEvent[]
  errors: string[]
  appConsole: string
}> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []

  page.on('pageerror', (err) => {
    if (!err.message.includes('Aborted') && !err.message.includes('h1-check'))
      errors.push(err.message)
  })

  await page.goto(BASE_URL)
  await page.waitForTimeout(2000)

  // Paste and run
  const editor = page.locator('.cm-content, textarea').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)
  await editor.fill(code)
  await page.waitForTimeout(200)

  await page.locator('.spw-btn-label:has-text("Run")').click()
  await page.waitForTimeout(duration)

  // Collect app console text and parse events from it
  const appText = await page.locator('#app').textContent() ?? ''
  let appConsole = ''
  const start = appText.indexOf('Happy live coding!')
  if (start >= 0) appConsole = appText.slice(start)

  // Parse events from console text: {run:1, t:0.0330}beep note:60 or {run:1, t:0.3}bd_haus
  const eventPattern = /\{run:\d+, t:([\d.]+)\}(\w+)(?: note:(\d+))?/g
  const capturedEvents: ActualEvent[] = []
  let match
  while ((match = eventPattern.exec(appConsole)) !== null) {
    capturedEvents.push({
      time: parseFloat(match[1]),
      synth: match[2],
      note: match[3] ? parseInt(match[3]) : null,
      trackId: null,
    })
  }

  // Check for errors in app console
  const errorPatterns = ['not a function', 'not defined', 'Something went wrong', 'Error in loop', "isn't available"]
  for (const p of errorPatterns) {
    if (appConsole.includes(p)) {
      const idx = appConsole.indexOf(p)
      errors.push(appConsole.slice(Math.max(0, idx - 60), idx + 100).trim())
    }
  }

  await page.keyboard.press('Escape')
  await context.close()

  return { events: capturedEvents, errors, appConsole }
}

// ---------------------------------------------------------------------------
// Step 3: Diff expected vs actual
// ---------------------------------------------------------------------------

interface DiagnosisResult {
  code: string
  duration: number
  expected: { events: ExpectedEvent[]; loops: string[]; transpileErrors: string[] }
  actual: { events: ActualEvent[]; errors: string[]; appConsole: string }
  diagnosis: string[]
}

function diagnose(expected: DiagnosisResult['expected'], actual: DiagnosisResult['actual']): string[] {
  const findings: string[] = []

  // Transpile errors
  if (expected.transpileErrors.length > 0) {
    findings.push(`TRANSPILE FAILED: ${expected.transpileErrors.join('; ')}`)
    return findings
  }

  // Runtime errors
  if (actual.errors.length > 0) {
    for (const e of actual.errors) findings.push(`RUNTIME ERROR: ${e}`)
  }

  // No loops captured
  if (expected.loops.length === 0) {
    findings.push('NO LOOPS: transpiled code produced no live_loop registrations')
  }

  // No expected events
  if (expected.events.length === 0 && expected.loops.length > 0) {
    findings.push('NO EXPECTED EVENTS: loops exist but QueryInterpreter found no events (possible sync deadlock or empty program)')
  }

  // No actual events
  if (actual.events.length === 0 && expected.events.length > 0) {
    findings.push(`SILENT OUTPUT: expected ${expected.events.length} events but browser produced 0 (audio engine may not have started, or loops are blocked)`)
  }

  // Event count comparison
  if (expected.events.length > 0 && actual.events.length > 0) {
    const ratio = actual.events.length / expected.events.length
    if (ratio < 0.5) {
      findings.push(`EVENT DEFICIT: expected ~${expected.events.length} events, got ${actual.events.length} (${(ratio * 100).toFixed(0)}%) — some loops may not be firing`)
    } else if (ratio > 2) {
      findings.push(`EVENT EXCESS: expected ~${expected.events.length} events, got ${actual.events.length} — possible double-triggering`)
    }
  }

  // Check which synths/samples appear
  const expectedSounds = new Set(expected.events.map(e => e.sampleName ?? e.synth).filter(Boolean))
  const actualSounds = new Set(actual.events.map(e => e.synth).filter(Boolean))
  const missingSounds = [...expectedSounds].filter(s => !actualSounds.has(s))
  const extraSounds = [...actualSounds].filter(s => !expectedSounds.has(s))
  if (missingSounds.length > 0) findings.push(`MISSING SOUNDS: expected [${missingSounds.join(', ')}] but not heard`)
  if (extraSounds.length > 0) findings.push(`UNEXPECTED SOUNDS: heard [${extraSounds.join(', ')}] not in expected`)

  // Check note values
  const expectedNotes = new Set(expected.events.map(e => e.note).filter(n => n != null))
  const actualNotes = new Set(actual.events.map(e => e.note).filter(n => n != null))
  const missingNotes = [...expectedNotes].filter(n => !actualNotes.has(n))
  if (missingNotes.length > 0) {
    findings.push(`MISSING NOTES: expected notes [${missingNotes.join(', ')}] but not produced`)
  }

  // Check timing regularity (are events evenly spaced as code implies?)
  if (actual.events.length >= 4) {
    const times = actual.events.map(e => e.time)
    const gaps: number[] = []
    // Group by synth to check per-loop timing
    const bySynth = new Map<string, number[]>()
    for (const e of actual.events) {
      const key = e.synth ?? 'unknown'
      if (!bySynth.has(key)) bySynth.set(key, [])
      bySynth.get(key)!.push(e.time)
    }
    for (const [synth, synthTimes] of bySynth) {
      if (synthTimes.length < 3) continue
      const synthGaps = []
      for (let i = 1; i < synthTimes.length; i++) {
        synthGaps.push(synthTimes[i] - synthTimes[i - 1])
      }
      const avgGap = synthGaps.reduce((a, b) => a + b, 0) / synthGaps.length
      const maxDeviation = Math.max(...synthGaps.map(g => Math.abs(g - avgGap)))
      if (maxDeviation > avgGap * 0.3) {
        findings.push(`TIMING JITTER on '${synth}': avg gap ${avgGap.toFixed(3)}s, max deviation ${maxDeviation.toFixed(3)}s (${((maxDeviation / avgGap) * 100).toFixed(0)}%)`)
      }
    }
  }

  // Note about tick-based code
  if (expected.events.length > 0) {
    const uniqueExpectedNotes = new Set(expected.events.map(e => e.note).filter(n => n != null))
    const uniqueActualNotes = new Set(actual.events.map(e => e.note).filter(n => n != null))
    if (uniqueExpectedNotes.size === 1 && uniqueActualNotes.size > 1) {
      findings.push(`NOTE: expected events show only one note value (tick resolves at build time, first iteration only). Actual events show ${uniqueActualNotes.size} distinct notes — this is correct for tick-cycling code.`)
    }
  }

  // If everything checks out
  if (findings.filter(f => !f.startsWith('NOTE:')).length === 0) {
    findings.push('OK: actual output matches expected events')
  }

  return findings
}

// ---------------------------------------------------------------------------
// Write diagnosis report
// ---------------------------------------------------------------------------

function writeReport(result: DiagnosisResult, path: string): void {
  const lines: string[] = []
  lines.push('# Audio Diagnosis Report\n')
  lines.push(`**Duration:** ${result.duration}ms\n`)

  lines.push('## Code\n```ruby')
  lines.push(result.code)
  lines.push('```\n')

  lines.push('## Diagnosis\n')
  for (const d of result.diagnosis) {
    const icon = d.startsWith('OK') ? '✓' : '✗'
    lines.push(`${icon} ${d}`)
  }
  lines.push('')

  lines.push('## Expected Events (from QueryInterpreter)\n')
  lines.push(`Loops: ${result.expected.loops.join(', ') || '(none)'}\n`)
  if (result.expected.events.length > 0) {
    lines.push('| Time | Type | Synth/Sample | Note |')
    lines.push('|------|------|-------------|------|')
    for (const e of result.expected.events.slice(0, 50)) {
      const name = e.sampleName ?? e.synth ?? '?'
      lines.push(`| ${e.time.toFixed(2)} | ${e.type} | ${name} | ${e.note ?? '-'} |`)
    }
    if (result.expected.events.length > 50) lines.push(`... (${result.expected.events.length - 50} more)`)
  } else {
    lines.push('(no events)')
  }
  lines.push('')

  lines.push('## Actual Events (from Browser)\n')
  if (result.actual.events.length > 0) {
    lines.push('| Time | Synth | Note | Track |')
    lines.push('|------|-------|------|-------|')
    for (const e of result.actual.events.slice(0, 50)) {
      lines.push(`| ${e.time.toFixed(2)} | ${e.synth ?? '?'} | ${e.note ?? '-'} | ${e.trackId ?? '-'} |`)
    }
    if (result.actual.events.length > 50) lines.push(`... (${result.actual.events.length - 50} more)`)
  } else {
    lines.push('(no events captured)')
  }
  lines.push('')

  if (result.actual.errors.length > 0) {
    lines.push('## Errors\n')
    for (const e of result.actual.errors) lines.push(`- ${e}`)
    lines.push('')
  }

  lines.push('## App Console\n```')
  lines.push(result.actual.appConsole.slice(0, 2000) || '(empty)')
  lines.push('```')

  writeFileSync(path, lines.join('\n'))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  mkdirSync(CAPTURES_DIR, { recursive: true })

  let code = ''
  let duration = 8000

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') {
      code = readFileSync(args[++i], 'utf-8')
    } else if (args[i] === '--duration') {
      duration = parseInt(args[++i])
    } else if (!args[i].startsWith('--')) {
      code = args[i]
    }
  }

  if (!code) {
    code = `live_loop :test do
  play scale(:c4, :minor_pentatonic).choose, release: 0.3
  sleep 0.25
end`
  }

  console.log('Step 1: Computing expected events (QueryInterpreter)...')
  const expected = await getExpectedEvents(code, duration)
  console.log(`  ${expected.loops.length} loops, ${expected.events.length} expected events`)

  console.log('Step 2: Capturing actual events (browser)...')
  const browser = await firefox.launch({ headless: true })
  const actual = await getActualEvents(browser, code, duration)
  await browser.close()
  console.log(`  ${actual.events.length} actual events, ${actual.errors.length} errors`)

  console.log('Step 3: Diagnosing...')
  const diagnosis = diagnose(expected, actual)

  const result: DiagnosisResult = { code, duration, expected, actual, diagnosis }
  const reportPath = resolve(CAPTURES_DIR, `diagnosis.md`)
  writeReport(result, reportPath)

  console.log(`\nDiagnosis: ${reportPath}`)
  for (const d of diagnosis) {
    const icon = d.startsWith('OK') ? '✓' : '✗'
    console.log(`  ${icon} ${d}`)
  }
}

main().catch((err) => {
  console.error('Diagnosis failed:', err)
  process.exit(1)
})
