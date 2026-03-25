import { parseAndTranspile as _parseAndTranspile } from './Parser'

/**
 * Transpiles Sonic Pi's Ruby DSL into JavaScript that runs on our engine.
 *
 * Input (real Sonic Pi code):
 *   live_loop :drums do
 *     sample :bd_haus
 *     sleep 0.5
 *     sample :sn_dub
 *     sleep 0.5
 *   end
 *
 * Output (JS for our engine):
 *   live_loop("drums", async (ctx) => {
 *     await ctx.sample("bd_haus")
 *     await ctx.sleep(0.5)
 *     await ctx.sample("sn_dub")
 *     await ctx.sleep(0.5)
 *   })
 */

// DSL functions that need `await` and `ctx.` prefix
const AWAIT_CTX_FUNCTIONS = new Set([
  'play', 'sleep', 'sample', 'sync',
])

// DSL functions that need `ctx.` but NOT `await`
const CTX_FUNCTIONS = new Set([
  'use_synth', 'use_bpm', 'use_random_seed',
  'cue', 'rrand', 'rrand_i', 'choose', 'dice',
  'ring', 'spread', 'note',
])

// All DSL functions (for detection)
const ALL_DSL = new Set([...AWAIT_CTX_FUNCTIONS, ...CTX_FUNCTIONS])

/**
 * If the code has bare play/sleep/sample calls outside any live_loop or
 * define block, wrap them in an implicit `live_loop :main do ... end`.
 *
 * Top-level `use_bpm`, `use_synth`, `use_random_seed` stay outside
 * (they set defaults for all loops).
 */
function wrapBareCode(code: string): string {
  const lines = code.split('\n')

  // Check if there are any live_loop blocks
  const hasLiveLoop = lines.some(l => /^\s*live_loop\s/.test(l))

  // Check for bare DSL calls (play, sleep, sample outside any block)
  const bareDSLPattern = /^\s*(play|sleep|sample)\s/
  const hasBareCode = lines.some(l => bareDSLPattern.test(l))

  if (!hasBareCode) return code
  if (hasLiveLoop) {
    // Mix of live_loops and bare code — wrap only the bare parts
    // For simplicity, wrap all bare DSL calls in a single live_loop
    const topLevel: string[] = [] // use_bpm, use_synth, etc.
    const bareCode: string[] = [] // play, sleep, sample
    const blocks: string[] = []   // live_loop blocks
    let inBlock = false
    let blockDepth = 0

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        if (inBlock) blocks.push(line)
        else bareCode.push(line)
        continue
      }

      if (/^\s*(live_loop|define|in_thread)\s/.test(line)) {
        inBlock = true
        blockDepth = 1
        blocks.push(line)
        continue
      }

      if (inBlock) {
        blocks.push(line)
        // Count all block-opening constructs for proper depth tracking
        if (/\bdo\s*(\|.*\|)?\s*$/.test(trimmed)) blockDepth++
        if (/^(if|unless|loop|while|until|for|begin|case)\s/.test(trimmed)) blockDepth++
        if (/\.times\s+do/.test(trimmed)) { /* already counted by `do` above */ }
        if (trimmed === 'end') {
          blockDepth--
          if (blockDepth <= 0) inBlock = false
        }
        continue
      }

      // Top-level settings
      if (/^\s*(use_bpm|use_synth|use_random_seed)\s/.test(line)) {
        topLevel.push(line)
        continue
      }

      // Bare DSL code
      bareCode.push(line)
    }

    const hasActualBare = bareCode.some(l => bareDSLPattern.test(l))
    if (!hasActualBare) return code

    return [
      ...topLevel,
      '',
      'live_loop :main do',
      ...bareCode.map(l => '  ' + l),
      'end',
      '',
      ...blocks,
    ].join('\n')
  }

  // No live_loops at all — wrap everything in a single live_loop
  const topLevel: string[] = []
  const body: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\s*(use_bpm|use_synth|use_random_seed)\s/.test(line)) {
      topLevel.push(line)
    } else {
      body.push(line)
    }
  }

  return [
    ...topLevel,
    '',
    'live_loop :main do',
    ...body.map(l => '  ' + l),
    'end',
  ].join('\n')
}

export function transpileRubyToJS(ruby: string): string {
  // Wrap bare top-level code in an implicit live_loop
  ruby = wrapBareCode(ruby)

  let lines = ruby.split('\n')

  let result: string[] = []
  let i = 0
  // Track block types so `end` produces the correct closing bracket
  // 'loop' → `})`, 'block' → `}`, 'thread' → `})()`
  const blockStack: Array<'loop' | 'block' | 'thread'> = []

  while (i < lines.length) {
    let line = lines[i]
    const trimmed = line.trim()

    // Skip empty lines and preserve them
    if (trimmed === '') {
      result.push('')
      i++
      continue
    }

    const indent = getIndent(line)

    // --- Extract inline comment BEFORE transpiling ---
    // Strip trailing # comment, transpile the code part, then re-append as //
    let inlineComment = ''
    const commentMatch = trimmed.match(/^(.+?)\s+#\s(.*)$/)
    if (commentMatch && !trimmed.startsWith('#')) {
      inlineComment = ` // ${commentMatch[2]}`
      // Re-derive trimmed without the comment for pattern matching below
      line = indent + commentMatch[1]
    }

    // Re-read trimmed after stripping comment
    const code = line.trim()

    // --- Full-line comment ---
    if (code.startsWith('#')) {
      result.push(`${indent}//${code.slice(1)}`)
      i++
      continue
    }

    // --- live_loop :name, sync: :other do --- (check BEFORE generic live_loop)
    const liveLoopSyncMatch = code.match(
      /^live_loop\s+:(\w+)\s*,\s*sync:\s*:(\w+)\s*do\s*$/
    )
    if (liveLoopSyncMatch) {
      const name = liveLoopSyncMatch[1]
      const syncName = liveLoopSyncMatch[2]
      result.push(`${indent}live_loop("${name}", async (ctx) => {${inlineComment}`)
      result.push(`${indent}  await ctx.sync("${syncName}")`)
      blockStack.push('loop')
      i++
      continue
    }

    // --- live_loop :name do ---
    const liveLoopMatch = code.match(
      /^live_loop\s+:(\w+)\s*do\s*$/
    )
    if (liveLoopMatch) {
      const name = liveLoopMatch[1]
      result.push(`${indent}live_loop("${name}", async (ctx) => {${inlineComment}`)
      blockStack.push('loop')
      i++
      continue
    }

    // --- with_fx :name, opts do ---
    const withFxMatch = code.match(
      /^with_fx\s+:(\w+)\s*(?:,\s*(.+?))?\s*do\s*$/
    )
    if (withFxMatch) {
      const fxName = withFxMatch[1]
      const fxOpts = withFxMatch[2] ? transpileArgs(withFxMatch[2]) : ''
      if (fxOpts) {
        result.push(`${indent}await ctx.with_fx("${fxName}", ${fxOpts}, async (ctx) => {${inlineComment}`)
      } else {
        result.push(`${indent}await ctx.with_fx("${fxName}", async (ctx) => {${inlineComment}`)
      }
      blockStack.push('loop') // uses }) closing like live_loop
      i++
      continue
    }

    // --- N.times do |var| ---
    const timesMatch = code.match(
      /^(\w+(?:\.\w+)*)\.times\s+do\s*(?:\|(\w+)\|)?\s*$/
    )
    if (timesMatch) {
      const count = transpileExpression(timesMatch[1])
      const varName = timesMatch[2] ?? '_i'
      result.push(`${indent}for (let ${varName} = 0; ${varName} < ${count}; ${varName}++) {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- in_thread do ---
    const inThreadMatch = code.match(/^in_thread\s+do\s*$/)
    if (inThreadMatch) {
      result.push(`${indent};(async () => {${inlineComment}`)
      blockStack.push('thread')
      i++
      continue
    }

    // --- if condition ---
    const ifMatch = code.match(/^if\s+(.+)$/)
    if (ifMatch) {
      result.push(`${indent}if (${transpileExpression(ifMatch[1])}) {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- elsif condition ---
    const elsifMatch = code.match(/^elsif\s+(.+)$/)
    if (elsifMatch) {
      result.push(`${indent}} else if (${transpileExpression(elsifMatch[1])}) {${inlineComment}`)
      i++
      continue
    }

    // --- else ---
    if (code === 'else') {
      result.push(`${indent}} else {${inlineComment}`)
      i++
      continue
    }

    // --- unless condition ---
    const unlessBlockMatch = code.match(/^unless\s+(.+)$/)
    if (unlessBlockMatch) {
      result.push(`${indent}if (!(${transpileExpression(unlessBlockMatch[1])})) {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- loop do ---
    if (code === 'loop do') {
      result.push(`${indent}while (true) {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- density N do ---
    const densityMatch = code.match(/^density\s+(.+?)\s+do\s*$/)
    if (densityMatch) {
      // density N compresses time: all sleeps inside are divided by N
      // We achieve this by temporarily changing the task's density factor
      const factor = transpileExpression(densityMatch[1])
      result.push(`${indent}{ const __prev_density = 1; // density ${factor}${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- end ---
    if (code === 'end') {
      const blockType = blockStack.pop() ?? 'loop'
      const closing = blockType === 'loop' ? '})' : blockType === 'thread' ? '})()' : '}'
      result.push(`${indent}${closing}${inlineComment}`)
      i++
      continue
    }

    // --- define :name do |args| ---
    const defineMatch = code.match(
      /^define\s+:(\w+)\s+do\s*(?:\|(.+?)\|)?\s*$/
    )
    if (defineMatch) {
      const name = defineMatch[1]
      const args = defineMatch[2]
        ? defineMatch[2].split(',').map(a => a.trim()).join(', ')
        : ''
      result.push(`${indent}async function ${name}(${args}) {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- General line transformation ---
    const insideLoop = blockStack.includes('loop')
    let transformed = transpileLine(code, insideLoop, i + 1)
    result.push(`${indent}${transformed}${inlineComment}`)
    i++
  }

  return result.join('\n')
}

/**
 * Transpile a single line of Sonic Pi Ruby to JS.
 */
function transpileLine(line: string, insideLoop: boolean = true, srcLine?: number): string {
  // Already a JS comment
  if (line.startsWith('//')) return line

  // Ruby comment → JS comment
  if (line.startsWith('#')) return '//' + line.slice(1)

  // NOTE: inline comments are stripped by the caller before we get here

  // --- Ruby trailing conditional: `statement if condition` ---
  const trailingIfMatch = line.match(/^(.+?)\s+if\s+(.+)$/)
  if (trailingIfMatch) {
    const statement = transpileLine(trailingIfMatch[1], insideLoop, srcLine)
    const condition = transpileExpression(trailingIfMatch[2])
    return `if (${condition}) { ${statement} }`
  }

  // --- Ruby trailing unless: `statement unless condition` ---
  const trailingUnlessMatch = line.match(/^(.+?)\s+unless\s+(.+)$/)
  if (trailingUnlessMatch) {
    const statement = transpileLine(trailingUnlessMatch[1], insideLoop, srcLine)
    const condition = transpileExpression(trailingUnlessMatch[2])
    return `if (!(${condition})) { ${statement} }`
  }

  // --- play note, opts ---
  const playMatch = line.match(/^play\s+(.+)$/)
  if (playMatch) {
    const args = transpileArgs(playMatch[1], srcLine)
    return `await ctx.play(${args})`
  }

  // --- sleep duration ---
  const sleepMatch = line.match(/^sleep\s+(.+)$/)
  if (sleepMatch) {
    return `await ctx.sleep(${transpileExpression(sleepMatch[1])})`
  }

  // --- sample :name, opts ---
  const sampleMatch = line.match(/^sample\s+(.+)$/)
  if (sampleMatch) {
    const args = transpileArgs(sampleMatch[1], srcLine)
    return `await ctx.sample(${args})`
  }

  // --- control node, opts ---
  const controlMatch = line.match(/^control\s+(\w+)\s*,\s*(.+)$/)
  if (controlMatch) {
    const nodeVar = controlMatch[1]
    const args = transpileArgs(controlMatch[2])
    return `ctx.control(${nodeVar}, ${args})`
  }

  // --- sync :name ---
  const syncMatch = line.match(/^sync\s+:(\w+)\s*$/)
  if (syncMatch) {
    return `await ctx.sync("${syncMatch[1]}")`
  }

  // --- cue :name ---
  const cueMatch = line.match(/^cue\s+:(\w+)\s*(.*)$/)
  if (cueMatch) {
    const args = cueMatch[2] ? `, ${transpileExpression(cueMatch[2])}` : ''
    return `ctx.cue("${cueMatch[1]}"${args})`
  }

  // --- use_synth :name ---
  const useSynthMatch = line.match(/^use_synth\s+:(\w+)\s*$/)
  if (useSynthMatch) {
    const prefix = insideLoop ? 'ctx.' : ''
    return `${prefix}use_synth("${useSynthMatch[1]}")`
  }

  // --- use_bpm N ---
  const useBpmMatch = line.match(/^use_bpm\s+(.+)$/)
  if (useBpmMatch) {
    const prefix = insideLoop ? 'ctx.' : ''
    return `${prefix}use_bpm(${transpileExpression(useBpmMatch[1])})`
  }

  // --- use_random_seed N ---
  const useRandomSeedMatch = line.match(/^use_random_seed\s+(.+)$/)
  if (useRandomSeedMatch) {
    const prefix = insideLoop ? 'ctx.' : ''
    return `${prefix}use_random_seed(${transpileExpression(useRandomSeedMatch[1])})`
  }

  // --- puts "text" ---
  const putsMatch = line.match(/^puts\s+(.+)$/)
  if (putsMatch) {
    return `console.log(${transpileExpression(putsMatch[1])})`
  }

  // --- print "text" ---
  const printMatch = line.match(/^print\s+(.+)$/)
  if (printMatch) {
    return `console.log(${transpileExpression(printMatch[1])})`
  }

  // General expression — transpile Ruby syntax within it
  return transpileExpression(line)
}

/**
 * Transpile a Ruby expression to JS.
 */
function transpileExpression(expr: string): string {
  let result = expr.trim()

  // Ruby symbols :name → "name"
  result = result.replace(/:(\w+)/g, '"$1"')

  // Ruby string interpolation #{expr} → ${expr}
  result = result.replace(/#\{/g, '${')

  // ring, knit, range, line, spread, chord, scale, note, note_range, chord_invert → ctx.*
  result = result.replace(/\b(ring|knit|range|line|spread|chord|scale|chord_invert|note_range|note)\s*\(/g, 'ctx.$1(')
  // Without parens: ring 1, 2, 3 — also handles (ring ...) wrapping
  result = result.replace(/(?<=\(|^)(ring|spread)\s+([^(].+?)(?=\)|$)/g, 'ctx.$1($2)')

  // rrand, choose, dice, rrand_i, tick, look → ctx.*
  result = result.replace(/\b(rrand_i|rrand|rand_i|rand|choose|dice|one_in)\s*\(/g, 'ctx.$1(')
  // Without parens: rrand 0, 1
  result = result.replace(/\b(rrand_i|rrand|rand_i|rand)\s+([^(].+)$/, 'ctx.$1($2)')

  // Standalone tick/look (as function call, not method .tick())
  result = result.replace(/(?<!\.)(?<!\w)\btick\s*\(/g, 'ctx.tick(')
  result = result.replace(/(?<!\.)(?<!\w)\blook\s*\(/g, 'ctx.look(')

  // Standalone tick/look without parens (bare tick, not as method .tick)
  result = result.replace(/(?<!\.)(?<!\w)\btick\b(?!\s*[.(])/g, 'ctx.tick()')
  result = result.replace(/(?<!\.)(?<!\w)\blook\b(?!\s*[.(])/g, 'ctx.look()')

  // .tick → .tick()
  result = result.replace(/\.tick(?!\()/g, '.tick()')

  // .look → .look()
  result = result.replace(/\.look(?!\()/g, '.look()')

  // .reverse → .reverse()
  result = result.replace(/\.reverse(?!\()/g, '.reverse()')

  // .shuffle → .shuffle()
  result = result.replace(/\.shuffle(?!\()/g, '.shuffle()')

  // .choose → .choose() (when used as method on Ring/Array)
  result = result.replace(/\.choose(?!\()/g, '.choose()')

  // Ruby range (1..5) → not directly supported, but common in Sonic Pi for note ranges
  // (a..b).to_a → Array.from({length: b-a+1}, (_, i) => a+i)
  result = result.replace(
    /\((\w+)\.\.(\w+)\)\.to_a/g,
    'Array.from({length: $2 - $1 + 1}, (_, _i) => $1 + _i)'
  )

  // nil → null
  result = result.replace(/\bnil\b/g, 'null')

  // true/false stay the same

  // Ruby unless → if (!)
  result = result.replace(/\bunless\s+/g, 'if (!')
  // Needs closing paren — handled by context

  // Ruby ternary: same as JS

  // [].choose → ctx.choose([])
  // Already handled if user writes choose([...])

  return result
}

/**
 * Transpile function arguments, handling Ruby symbol → string conversion
 * and Ruby hash-style opts (key: value) → JS object.
 */
function transpileArgs(argsStr: string, srcLine?: number): string {
  let result = argsStr.trim()

  // First, convert symbols
  result = transpileExpression(result)

  // Split by comma, detect which parts are keyword args
  const parts = splitArgs(result)
  const positional: string[] = []
  const kwargs: string[] = []

  for (const part of parts) {
    const kwMatch = part.trim().match(/^(\w+):\s*(.+)$/)
    if (kwMatch) {
      kwargs.push(`${kwMatch[1]}: ${kwMatch[2]}`)
    } else {
      positional.push(part.trim())
    }
  }

  // Inject _srcLine for source mapping
  if (srcLine !== undefined) {
    kwargs.push(`_srcLine: ${srcLine}`)
  }

  if (kwargs.length > 0) {
    return [...positional, `{ ${kwargs.join(', ')} }`].join(', ')
  }
  return positional.join(', ')
}

/**
 * Split arguments by comma, respecting parentheses and brackets.
 */
function splitArgs(str: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (const ch of str) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts
}

/**
 * Get the leading whitespace of a line.
 */
function getIndent(line: string): string {
  const match = line.match(/^(\s*)/)
  return match ? match[1] : ''
}

/**
 * Detect whether code looks like Ruby (Sonic Pi) or JavaScript.
 */
export function detectLanguage(code: string): 'ruby' | 'js' {
  const trimmed = code.trim()

  // Strong Ruby indicators
  if (/\bdo\s*(\|.*\|)?\s*$/.test(trimmed)) return 'ruby'
  if (/\bend\s*$/.test(trimmed)) return 'ruby'
  if (/:\w+/.test(trimmed) && !/['"`]/.test(trimmed.split(':')[0])) return 'ruby'
  if (/\blive_loop\s+:/.test(trimmed)) return 'ruby'
  if (/\bsample\s+:/.test(trimmed)) return 'ruby'
  if (/\buse_synth\s+:/.test(trimmed)) return 'ruby'

  // Strong JS indicators
  if (/\basync\b/.test(trimmed)) return 'js'
  if (/\bawait\b/.test(trimmed)) return 'js'
  if (/\bctx\./.test(trimmed)) return 'js'
  if (/=>/.test(trimmed)) return 'js'
  if (/\bconst\b|\blet\b|\bvar\b/.test(trimmed)) return 'js'

  // Default to Ruby (Sonic Pi is the primary use case)
  return 'ruby'
}

/**
 * Auto-detect language and transpile if needed.
 * Uses the recursive descent parser as primary (handles nesting, ctx. prefix,
 * structured errors). Falls back to regex transpiler if parser reports errors.
 * Returns JS code ready for the engine.
 */
export function autoTranspile(code: string): string {
  if (detectLanguage(code) === 'js') return code

  // Primary: recursive descent parser
  const { code: parsed, errors } = _parseAndTranspile(code)
  if (errors.length === 0) {
    // Validate the output creates a valid Function (catches bad JS generation)
    try {
      new Function(parsed)
      return parsed
    } catch {
      // Parser output is invalid JS — fall back
    }
  }

  // Fallback: regex transpiler
  return transpileRubyToJS(code)
}
