/**
 * Friendly error messages matching Sonic Pi's beginner-friendly style.
 *
 * Wraps runtime errors with helpful context: what went wrong, why,
 * and what to try instead.
 */

export interface FriendlyError {
  title: string
  message: string
  line?: number
  original: Error
}

export const KNOWN_SYNTHS = [
  'beep', 'saw', 'prophet', 'tb303', 'supersaw', 'pluck',
  'pretty_bell', 'piano', 'dsaw', 'dpulse', 'dtri', 'fm',
  'mod_fm', 'mod_saw', 'mod_pulse', 'mod_tri', 'sine',
  'square', 'tri', 'pulse', 'noise', 'pnoise', 'bnoise',
  'gnoise', 'cnoise', 'chipbass', 'chiplead', 'chipnoise',
  'dark_ambience', 'hollow', 'growl', 'zawa', 'blade',
  'tech_saws', 'sound_in', 'sound_in_stereo',
]

export const KNOWN_SAMPLES = [
  'bd_haus', 'bd_zum', 'bd_808', 'bd_boom', 'bd_klub', 'bd_pure', 'bd_tek',
  'sn_dub', 'sn_dolf', 'sn_zome', 'sn_generic',
  'hat_snap', 'hat_cab', 'hat_raw',
  'loop_amen', 'loop_breakbeat', 'loop_compus', 'loop_garzul', 'loop_industrial',
  'ambi_choir', 'ambi_dark_woosh', 'ambi_drone', 'ambi_glass_hum', 'ambi_lunar_land',
  'bass_dnb_f', 'bass_hit_c', 'bass_thick_c', 'bass_voxy_c',
  'elec_beep', 'elec_bell', 'elec_blip', 'elec_chime', 'elec_ping',
  'perc_bell', 'perc_snap', 'perc_swoosh',
]

export const KNOWN_FX = [
  'reverb', 'echo', 'delay', 'distortion', 'slicer',
  'wobble', 'ixi_techno', 'compressor', 'rlpf', 'rhpf',
  'hpf', 'lpf', 'normaliser', 'pan', 'band_eq',
  'flanger', 'krush', 'bitcrusher', 'ring_mod', 'chorus',
  'octaver', 'vowel', 'tanh', 'gverb', 'pitch_shift',
  'whammy', 'tremolo', 'record', 'sound_out', 'sound_out_stereo',
  'level', 'mono', 'autotuner',
]

/** Try to extract a line number from an error stack trace. */
function extractLineFromStack(err: Error, lineOffset: number): number | undefined {
  const stack = err.stack
  if (!stack) return undefined

  // Look for "eval" or "anonymous" frames — that's where user code runs
  const match = stack.match(/<anonymous>:(\d+):\d+/) ??
                stack.match(/eval.*?:(\d+):\d+/) ??
                stack.match(/Function.*?:(\d+):\d+/)

  if (match) {
    const raw = parseInt(match[1], 10)
    // Subtract the wrapper function's lines (async IIFE adds 2)
    const adjusted = raw - 2 - lineOffset
    return adjusted > 0 ? adjusted : undefined
  }
  return undefined
}

/** Find the closest match from a list using edit distance. */
function closestMatch(input: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestDist = Infinity

  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }

  // Only suggest if reasonably close (within 3 edits)
  return bestDist <= 3 ? best : null
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** Pattern matchers for common runtime errors. */
const ERROR_PATTERNS: Array<{
  test: (msg: string) => boolean
  transform: (msg: string, err: Error) => { title: string; message: string }
}> = [
  // Unknown synth
  {
    test: (msg) => /unknown synth|synthdef.*not found|loadSynthDef/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sonic-pi-(\w+)/i) ??
                         msg.match(/synth[:\s]+["']?(\w+)["']?/i)
      const name = nameMatch?.[1]?.replace('sonic-pi-', '') ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_SYNTHS)
      return {
        title: `Synth :${name} not found`,
        message: `I don't know a synth called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nAvailable synths include: ${KNOWN_SYNTHS.slice(0, 8).map(s => ':' + s).join(', ')}...` +
          `\n\nTry: use_synth("${suggestion ?? 'beep'}")`,
      }
    },
  },
  // Unknown sample
  {
    test: (msg) => /sample.*not found|loadSample.*failed|sample.*flac/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sample[:\s]*["']?(\w+)["']?/i) ??
                         msg.match(/(\w+)\.flac/i)
      const name = nameMatch?.[1] ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_SAMPLES)
      return {
        title: `Sample :${name} not found`,
        message: `I couldn't find a sample called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nSome built-in samples: ${KNOWN_SAMPLES.slice(0, 6).map(s => ':' + s).join(', ')}...`,
      }
    },
  },
  // Unknown FX
  {
    test: (msg) => /unknown fx|fx.*not found|loadSynthDef.*fx/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/sonic-pi-fx_(\w+)/i) ??
                         msg.match(/fx[:\s]+["']?(\w+)["']?/i)
      const name = nameMatch?.[1]?.replace('sonic-pi-fx_', '') ?? 'unknown'
      const suggestion = closestMatch(name, KNOWN_FX)
      return {
        title: `FX :${name} not found`,
        message: `I don't know an FX called :${name}.` +
          (suggestion ? ` Did you mean :${suggestion}?` : '') +
          `\n\nAvailable FX include: ${KNOWN_FX.slice(0, 8).map(f => ':' + f).join(', ')}...`,
      }
    },
  },
  // Note out of range or invalid
  {
    test: (msg) => /invalid note|note.*range|unknown note|cannot convert.*note/i.test(msg),
    transform: (msg) => ({
      title: 'Invalid note',
      message: `That doesn't look like a valid note.\n\n` +
        `Notes can be:\n` +
        `  - MIDI numbers: play(60)  (middle C)\n` +
        `  - Note names:   play("c4"), play("fs3"), play("eb5")\n` +
        `  - Symbols:      play("c4")  (use strings in JS, not Ruby symbols)`,
    }),
  },
  // sleep with bad value
  {
    test: (msg) => /sleep.*NaN|sleep.*undefined|sleep.*negative/i.test(msg),
    transform: (msg) => ({
      title: 'Invalid sleep value',
      message: `sleep() needs a positive number of beats.\n\n` +
        `Examples:\n` +
        `  sleep(1)     → wait 1 beat\n` +
        `  sleep(0.5)   → wait half a beat\n` +
        `  sleep(0.25)  → wait a quarter beat`,
    }),
  },
  // Not initialized
  {
    test: (msg) => /not initialized|call init/i.test(msg),
    transform: () => ({
      title: 'Engine not ready',
      message: `The sound engine hasn't started yet.\n\n` +
        `Make sure to call init() before evaluating code:\n` +
        `  const engine = new SonicPiEngine()\n` +
        `  await engine.init()\n` +
        `  await engine.evaluate(code)`,
    }),
  },
  // Unknown task
  {
    test: (msg) => /unknown task/i.test(msg),
    transform: (msg) => {
      const nameMatch = msg.match(/task[:\s]*["']?(\w+)["']?/i)
      const name = nameMatch?.[1] ?? 'unknown'
      return {
        title: `Unknown loop: ${name}`,
        message: `There's no live_loop called "${name}" running.\n\n` +
          `Make sure your code defines the loop:\n` +
          `  live_loop("${name}", async ({play, sleep}) => {\n` +
          `    await play(60)\n` +
          `    await sleep(1)\n` +
          `  })`,
      }
    },
  },
  // Type errors (common JS mistakes)
  {
    test: (msg) => /is not a function/i.test(msg),
    transform: (msg) => {
      const fnMatch = msg.match(/(\w+) is not a function/i)
      const fn = fnMatch?.[1] ?? 'unknown'
      return {
        title: `${fn} is not a function`,
        message: `Hmm, "${fn}" isn't available as a function here.\n\n` +
          `Common causes:\n` +
          `  - Typo in function name\n` +
          `  - Using a Ruby method that hasn't been implemented yet\n` +
          `  - Calling a DSL function outside a live_loop`,
      }
    },
  },
  // ReferenceError (undefined variable)
  {
    test: (msg) => /is not defined/i.test(msg),
    transform: (msg) => {
      const varMatch = msg.match(/(\w+) is not defined/i)
      const name = varMatch?.[1] ?? 'unknown'
      return {
        title: `${name} is not defined`,
        message: `I don't know what "${name}" means.\n\n` +
          `If this is a Sonic Pi symbol like :${name}, use a string instead: "${name}"\n` +
          `If this is a variable, make sure to define it with let or const first.`,
      }
    },
  },
  // Syntax errors
  {
    test: (msg) => /syntaxerror|unexpected token|unexpected end/i.test(msg),
    transform: (msg) => ({
      title: 'Syntax error',
      message: `There's a syntax problem in your code.\n\n` +
        `Common causes:\n` +
        `  - Missing closing bracket ) or }\n` +
        `  - Using Ruby do/end instead of JS { }\n` +
        `  - Missing comma between arguments\n\n` +
        `Tip: If you're writing Sonic Pi syntax, the transpiler handles most Ruby → JS conversion automatically.`,
    }),
  },
]

/**
 * Transform a raw runtime error into a friendly, Sonic Pi-style error.
 */
export function friendlyError(err: Error, lineOffset = 0): FriendlyError {
  const msg = err.message

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      const { title, message } = pattern.transform(msg, err)
      return {
        title,
        message,
        line: extractLineFromStack(err, lineOffset),
        original: err,
      }
    }
  }

  // Fallback: unknown error, still wrap it nicely
  return {
    title: 'Something went wrong',
    message: `${msg}\n\nIf this keeps happening, try simplifying your code and adding things back one at a time.`,
    line: extractLineFromStack(err, lineOffset),
    original: err,
  }
}

/**
 * Format a FriendlyError for display (log pane or console).
 */
export function formatFriendlyError(fe: FriendlyError): string {
  const lineInfo = fe.line ? ` (line ${fe.line})` : ''
  return `── ${fe.title}${lineInfo} ──\n\n${fe.message}`
}
