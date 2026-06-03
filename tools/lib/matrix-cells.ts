/**
 * matrix-cells.ts — the differential-coverage matrix enumeration (issue #459, dharana §36).
 *
 * Pure, I/O-free generation of the finite construct×context×position space of the
 * scheduling DSL, plus a deterministic minimal reproducer per cell. The driver
 * (tools/diff-matrix.ts) runs each cell's `code` through event-parity (web /s_new
 * vs desktop /s_new); desktop is the oracle. No PRNG anywhere (SV49) so the
 * /s_new structural diff is clean.
 *
 * The three axes (dharana §36 step 1):
 *   construct — the sound-producing scheduling unit under test
 *   modifier  — the preceding/contextual concern that has historically broken at
 *               the B1 hoist/fork seam (sleep→SP118, delay→SP117, sync→SP119,
 *               var→SP121, use_*→SV55, nothing→baseline)
 *   position  — top-level (depth 0) vs nested inside a user `in_thread`
 *
 * Nonsensical cells are SKIPPED with an explicit reason (no silent caps, dharana §36).
 */

export type Construct = 'live_loop' | 'in_thread' | 'bare_loop' | 'with_fx' | 'at'
export type Modifier = 'nothing' | 'preceding_sleep' | 'delay' | 'sync' | 'var_read' | 'use_synth'
export type Position = 'top_level' | 'nested'

export const CONSTRUCTS: Construct[] = ['live_loop', 'in_thread', 'bare_loop', 'with_fx', 'at']
export const MODIFIERS: Modifier[] = ['nothing', 'preceding_sleep', 'delay', 'sync', 'var_read', 'use_synth']
export const POSITIONS: Position[] = ['top_level', 'nested']

export interface Cell {
  id: string // stable: `${construct}__${modifier}__${position}`
  construct: Construct
  modifier: Modifier
  position: Position
  /** which B1 hoist/fork seam concern this cell probes (the §36 column) */
  seam: boolean // true if construct goes through the hoist/fork split
  /** null = a real reproducer; string = SKIPPED, value is the human reason */
  skip: string | null
  /** the generated Ruby reproducer (empty string when skipped) */
  code: string
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const PRECEDING_BEATS = 4 // sleep / delay magnitude — large enough to expose a vt-0 fork (>= ONSET_GAP_SEC=3)
const CADENCE = 0.5 // beats between sound onsets
const REPS = 8 // one-shot constructs (in_thread/with_fx/at) fire this many times → significance (>=3)

/** The driver cuer for `sync` cells — a silent top-level live_loop firing :tick. */
const DRIVER = `live_loop :driver do\n  cue :tick\n  sleep ${CADENCE}\nend`

/**
 * The sound line, chosen so each modifier's effect is OBSERVABLE in the /s_new
 * structure (which diffs synthdef identity + count, NOT param values, SV49):
 *  - use_synth: bare `play 60` → the voice synthdef reveals the inherited synth
 *               (tb303 if SV55 holds, beep if the use_synth was stranded).
 *  - var_read:  `play 60 + n` → if the hoist races the var write (SP121), the note
 *               is NaN → SV51 refuses dispatch → web fires fewer voices than desktop.
 *  - else:      `synth :saw` → a single, distinct, identifiable voice (sonic-pi-saw).
 */
function soundLine(modifier: Modifier): string {
  if (modifier === 'use_synth') return 'play 60'
  if (modifier === 'var_read') return 'play 60 + n'
  return 'synth :saw, note: 60, release: 0.2'
}

/** The body a looping/repeating construct runs each pass. */
function bodyLine(modifier: Modifier): string {
  const sound = soundLine(modifier)
  if (modifier === 'sync') return `  sync :tick\n  ${sound}`
  return `  ${sound}\n  sleep ${CADENCE}`
}

/** Lines emitted at the construct's own level, BEFORE the construct. */
function preludeLines(modifier: Modifier): string[] {
  switch (modifier) {
    case 'preceding_sleep':
      return [`sleep ${PRECEDING_BEATS}`]
    case 'var_read':
      return ['n = 7']
    case 'use_synth':
      return ['use_synth :tb303']
    default:
      return []
  }
}

/** The construct itself, given its (already modifier-aware) body + opts. */
function constructCode(construct: Construct, modifier: Modifier): string {
  const sound = soundLine(modifier)
  const sync = modifier === 'sync'
  const delayOpt = modifier === 'delay' ? `, delay: ${PRECEDING_BEATS}` : ''

  switch (construct) {
    case 'live_loop':
      return `live_loop :test${delayOpt} do\n${bodyLine(modifier)}\nend`
    case 'bare_loop':
      // sleepless+syncless loops free-run; sync (cue) or sleep supplies the brake.
      return sync
        ? `loop do\n  sync :tick\n  ${sound}\nend`
        : `loop do\n  ${sound}\n  sleep ${CADENCE}\nend`
    case 'in_thread': {
      const inner = sync ? `  sync :tick\n  ${sound}` : `  ${sound}\n  sleep ${CADENCE}`
      return `in_thread${delayOpt ? ` ${delayOpt.replace(/^,\s*/, '')}` : ''} do\n  ${REPS}.times do\n  ${inner.replace(/\n/g, '\n  ')}\n  end\nend`
    }
    case 'with_fx': {
      const inner = sync ? `  sync :tick\n  ${sound}` : `  ${sound}\n  sleep ${CADENCE}`
      return `with_fx :reverb do\n  ${REPS}.times do\n  ${inner.replace(/\n/g, '\n  ')}\n  end\nend`
    }
    case 'at': {
      const times = Array.from({ length: REPS }, (_, i) => i * CADENCE).join(', ')
      return `at [${times}] do\n  ${sound}\nend`
    }
  }
}

/** Wrap the construct (+ its same-level prelude) for the position dimension. */
function positioned(construct: Construct, modifier: Modifier, position: Position): string {
  const prelude = preludeLines(modifier)
  const body = constructCode(construct, modifier)
  const block = [...prelude, body].join('\n')
  if (position === 'top_level') return block
  // nested: the construct (and its prelude) live inside a user-written in_thread,
  // so the prelude's sleep/var/use_synth are sequential WITHIN that thread.
  return `in_thread do\n${block.split('\n').map((l) => '  ' + l).join('\n')}\nend`
}

// ---------------------------------------------------------------------------
// Skip rules (logged, never silent — dharana §36)
// ---------------------------------------------------------------------------

function skipReason(construct: Construct, modifier: Modifier): string | null {
  if (modifier === 'delay' && construct !== 'live_loop' && construct !== 'in_thread')
    return `delay: is not a valid opt for ${construct} (only live_loop / in_thread accept delay:)`
  if (modifier === 'sync' && construct === 'at')
    return 'at is pre-scheduled at fixed offsets; gating on a cue (sync) is nonsensical'
  return null
}

/** Constructs that go through the transpiler's hoist/fork split (the §36 seam column). */
function isSeam(construct: Construct, position: Position): boolean {
  // bare_loop is ALWAYS hoisted (top-level → live_loop; in in_thread → sibling live_loop).
  if (construct === 'bare_loop') return true
  // in_thread forks a thread; top-level in_thread is start-gate-hoisted (SP118).
  if (construct === 'in_thread') return true
  // top-level live_loop / with_fx-wrapped loop are start-gate-hoisted (SP118 fix b).
  if ((construct === 'live_loop' || construct === 'with_fx') && position === 'top_level') return true
  return false
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export function enumerateCells(): Cell[] {
  const cells: Cell[] = []
  for (const construct of CONSTRUCTS) {
    for (const modifier of MODIFIERS) {
      for (const position of POSITIONS) {
        const skip = skipReason(construct, modifier)
        const id = `${construct}__${modifier}__${position}`
        const seam = isSeam(construct, position)
        if (skip) {
          cells.push({ id, construct, modifier, position, seam, skip, code: '' })
          continue
        }
        let code = positioned(construct, modifier, position)
        // sync cells need the driver cuer; emit it first (always top-level).
        if (modifier === 'sync') code = `${DRIVER}\n\n${code}`
        cells.push({ id, construct, modifier, position, seam, skip: null, code })
      }
    }
  }
  return cells
}

/** Summary counts for logging (no silent caps). */
export function summarizeCells(cells: Cell[]) {
  const active = cells.filter((c) => !c.skip)
  const skipped = cells.filter((c) => c.skip)
  return { total: cells.length, active: active.length, skipped: skipped.length, skippedCells: skipped }
}
