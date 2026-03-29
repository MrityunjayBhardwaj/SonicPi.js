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
 *   live_loop("drums", (b) => {
 *     b.sample("bd_haus")
 *     b.sleep(0.5)
 *     b.sample("sn_dub")
 *     b.sleep(0.5)
 *   })
 */

// DSL functions that need `b.` prefix (builder chain — all synchronous)
const BUILDER_FUNCTIONS = new Set([
  'play', 'sleep', 'sample', 'sync',
  'use_synth', 'use_bpm', 'use_random_seed',
  'cue', 'rrand', 'rrand_i', 'choose', 'dice',
  'ring', 'spread', 'note',
])

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

      if (/^\s*(live_loop|define|in_thread|with_fx|at|time_warp|density)\s/.test(line)) {
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

  // Join continuation lines: trailing comma, backslash, or binary operator
  const rawLines = ruby.split('\n')
  let lines: string[] = []
  for (let j = 0; j < rawLines.length; j++) {
    let ln = rawLines[j]
    while (j + 1 < rawLines.length) {
      const t = ln.trimEnd()
      if (t.endsWith('\\')) {
        ln = t.slice(0, -1).trimEnd() + ' ' + rawLines[j + 1].trim()
        j++
      } else if (t.endsWith(',') || /(?:&&|\|\||[+*\/%]|\band\b|\bor\b)$/.test(t)) {
        ln = t + ' ' + rawLines[j + 1].trim()
        j++
      } else {
        break
      }
    }
    lines.push(ln)
  }

  let result: string[] = []
  let i = 0
  // Track block types so `end` produces the correct closing bracket
  // 'loop' → `})`, 'block' → `}`, 'thread' → `})()`
  const blockStack: Array<'loop' | 'block' | 'thread' | 'density' | 'density-toplevel' | 'case'> = []
  const definedFunctions = new Set<string>()
  // Stack for case/when — stores the expression being matched and whether first when was seen
  const caseExprStack: string[] = []
  const caseHadWhenStack: boolean[] = []

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
      result.push(`${indent}live_loop("${name}", {sync: "${syncName}"}, (b) => {${inlineComment}`)
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
      result.push(`${indent}live_loop("${name}", (b) => {${inlineComment}`)
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
      const insideLoop = blockStack.includes('loop')
      const prefix = insideLoop ? 'b.' : ''
      if (fxOpts) {
        result.push(`${indent}${prefix}with_fx("${fxName}", ${fxOpts}, (b) => {${inlineComment}`)
      } else {
        result.push(`${indent}${prefix}with_fx("${fxName}", (b) => {${inlineComment}`)
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
      result.push(`${indent}  b.__checkBudget__()`)
      blockStack.push('block')
      i++
      continue
    }

    // --- expr.each do |var| ---
    const eachMatch = code.match(
      /^(.+)\.each\s+do\s*(?:\|(\w+)\|)?\s*$/
    )
    if (eachMatch) {
      const iterable = transpileExpression(eachMatch[1])
      const varName = eachMatch[2] ?? '_item'
      result.push(`${indent}for (const ${varName} of ${iterable}) {${inlineComment}`)
      result.push(`${indent}  b.__checkBudget__()`)
      blockStack.push('block')
      i++
      continue
    }

    // --- expr.map/select/reject/collect do |var| --- (multi-line block)
    const mapDoMatch = code.match(
      /^(.+)\.(map|select|reject|collect)\s+do\s*(?:\|(\w+)\|)?\s*$/
    )
    if (mapDoMatch) {
      const iterableExpr = transpileExpression(mapDoMatch[1])
      const method = mapDoMatch[2]
      const varName = mapDoMatch[3] ?? '_item'
      const jsMethod = (method === 'select' || method === 'reject') ? 'filter' : 'map'
      const isReject = method === 'reject'
      const inLoop = blockStack.includes('loop')

      // Collect body lines until 'end'
      const bodyLines: string[] = []
      i++
      while (i < lines.length) {
        const bodyLine = lines[i].trim()
        if (bodyLine === 'end') break
        bodyLines.push(bodyLine)
        i++
      }
      // i now points at 'end', will be incremented by continue

      if (bodyLines.length === 1) {
        const bodyExpr = transpileLine(bodyLines[0], inLoop, i)
        if (isReject) {
          result.push(`${indent}${iterableExpr}.${jsMethod}((${varName}) => !(${bodyExpr}))${inlineComment}`)
        } else {
          result.push(`${indent}${iterableExpr}.${jsMethod}((${varName}) => ${bodyExpr})${inlineComment}`)
        }
      } else {
        // Multi-line: last expression is return value
        const lastBody = bodyLines.pop() ?? ''
        const lastExpr = transpileLine(lastBody, inLoop, i)
        result.push(`${indent}${iterableExpr}.${jsMethod}((${varName}) => {${inlineComment}`)
        for (const bl of bodyLines) {
          result.push(`${indent}  ${transpileLine(bl, inLoop, i)}`)
        }
        if (isReject) {
          result.push(`${indent}  return !(${lastExpr})`)
        } else {
          result.push(`${indent}  return ${lastExpr}`)
        }
        result.push(`${indent}})`)
      }
      i++
      continue
    }

    // --- at [times] do / at [times], [values] do |params| ---
    const atMatch = code.match(
      /^at\s+(\[.+?\])(?:\s*,\s*(\[.+?\]))?\s+do\s*(?:\|(.+?)\|)?\s*$/
    )
    if (atMatch) {
      const timesArr = transpileExpression(atMatch[1])
      const valuesArr = atMatch[2] ? transpileExpression(atMatch[2]) : 'null'
      const params = atMatch[3]
        ? atMatch[3].split(',').map(a => a.trim()).join(', ')
        : ''
      const insideLoop = blockStack.includes('loop')
      const atPrefix = insideLoop ? 'b.' : ''
      result.push(`${indent}${atPrefix}at(${timesArr}, ${valuesArr}, (b${params ? ', ' + params : ''}) => {${inlineComment}`)
      blockStack.push('loop')  // 'loop' so body gets b. prefixes
      i++
      continue
    }

    // --- time_warp N do --- (sugar for at([N], null, fn))
    const timeWarpMatch = code.match(/^time_warp\s+(.+?)\s+do\s*$/)
    if (timeWarpMatch) {
      const offset = transpileExpression(timeWarpMatch[1])
      const insideLoop = blockStack.includes('loop')
      const twPrefix = insideLoop ? 'b.' : ''
      result.push(`${indent}${twPrefix}at([${offset}], null, (b) => {${inlineComment}`)
      blockStack.push('loop')
      i++
      continue
    }

    // --- in_thread do ---
    const inThreadMatch = code.match(/^in_thread\s+do\s*$/)
    if (inThreadMatch) {
      const insideLoop = blockStack.includes('loop')
      const itPrefix = insideLoop ? 'b.' : ''
      result.push(`${indent}${itPrefix}in_thread((b) => {${inlineComment}`)
      blockStack.push('loop')  // 'loop' so body gets b. prefixes
      i++
      continue
    }

    // --- case expr ---
    const caseMatch = code.match(/^case\s+(.+)$/)
    if (caseMatch) {
      caseExprStack.push(transpileExpression(caseMatch[1]))
      caseHadWhenStack.push(false)
      blockStack.push('case')
      i++
      continue
    }

    // --- when val1, val2, ... ---
    const whenMatch = code.match(/^when\s+(.+)$/)
    if (whenMatch && caseExprStack.length > 0) {
      const expr = caseExprStack[caseExprStack.length - 1]
      const vals = whenMatch[1].split(',').map(v => v.trim())
      const condition = vals.map(v => `${expr} === ${transpileExpression(v)}`).join(' || ')
      const hadWhen = caseHadWhenStack[caseHadWhenStack.length - 1]
      if (hadWhen) {
        result.push(`${indent}} else if (${condition}) {${inlineComment}`)
      } else {
        result.push(`${indent}if (${condition}) {${inlineComment}`)
        caseHadWhenStack[caseHadWhenStack.length - 1] = true
      }
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
      result.push(`${indent}  b.__checkBudget__()`)
      blockStack.push('block')
      i++
      continue
    }

    // --- density N do ---
    const densityMatch = code.match(/^density\s+(.+?)\s+do\s*$/)
    if (densityMatch) {
      // density N compresses time: all sleeps inside are divided by N
      const factor = transpileExpression(densityMatch[1])
      const insideLoop = blockStack.includes('loop')
      const bRef = insideLoop ? 'b' : '__densityB'
      result.push(`${indent}{${inlineComment}`)
      if (!insideLoop) {
        result.push(`${indent}  const ${bRef} = { density: 1 }`)
      }
      result.push(`${indent}  const __prevDensity = ${bRef}.density`)
      result.push(`${indent}  ${bRef}.density = __prevDensity * ${factor}`)
      blockStack.push(insideLoop ? 'density' : 'density-toplevel')
      i++
      continue
    }

    // --- begin (try) ---
    if (code === 'begin') {
      result.push(`${indent}try {${inlineComment}`)
      blockStack.push('block')
      i++
      continue
    }

    // --- rescue => e ---
    const rescueMatch = code.match(/^rescue\s*(?:=>\s*(\w+))?\s*$/)
    if (rescueMatch) {
      const errorVar = rescueMatch[1] ?? '_e'
      result.push(`${indent}} catch (${errorVar}) {${inlineComment}`)
      i++
      continue
    }

    // --- ensure (finally) ---
    if (code === 'ensure') {
      result.push(`${indent}} finally {${inlineComment}`)
      i++
      continue
    }

    // --- end ---
    if (code === 'end') {
      const blockType = blockStack.pop() ?? 'loop'
      if (blockType === 'density' || blockType === 'density-toplevel') {
        const dBRef = blockType === 'density' ? 'b' : '__densityB'
        result.push(`${indent}  ${dBRef}.density = __prevDensity`)
        result.push(`${indent}}${inlineComment}`)
      } else if (blockType === 'case') {
        caseExprStack.pop()
        caseHadWhenStack.pop()
        result.push(`${indent}}${inlineComment}`)
      } else {
        const closing = blockType === 'loop' ? '})' : blockType === 'thread' ? '})()' : '}'
        result.push(`${indent}${closing}${inlineComment}`)
      }
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
      definedFunctions.add(name)
      result.push(`${indent}function ${name}(b${args ? ', ' + args : ''}) {${inlineComment}`)
      blockStack.push('loop') // 'loop' so body lines get b. prefix (insideLoop = blockStack.includes('loop'))
      i++
      continue
    }

    // --- Call to user-defined function: inject b as first arg ---
    const insideLoop = blockStack.includes('loop')
    const firstWord = code.match(/^(\w+)/)
    if (firstWord && definedFunctions.has(firstWord[1])) {
      const fnName = firstWord[1]
      const rest = code.slice(fnName.length).trim()
      if (!rest) {
        result.push(`${indent}${fnName}(b)${inlineComment}`)
      } else if (rest.startsWith('(')) {
        const inner = rest.slice(1, -1).trim()
        result.push(`${indent}${fnName}(b${inner ? ', ' + transpileExpression(inner) : ''})${inlineComment}`)
      } else {
        result.push(`${indent}${fnName}(b, ${transpileExpression(rest)})${inlineComment}`)
      }
      i++
      continue
    }

    // --- General line transformation ---
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

  // --- stop ---
  if (line === 'stop') return `b.stop()`

  // --- stop_loop :name --- (top-level only, no b. prefix)
  const stopLoopMatch = line.match(/^stop_loop\s+(.+)$/)
  if (stopLoopMatch) return `stop_loop(${transpileExpression(stopLoopMatch[1])})`

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
    return `b.play(${args})`
  }

  // --- sleep duration ---
  const sleepMatch = line.match(/^sleep\s+(.+)$/)
  if (sleepMatch) {
    return `b.sleep(${transpileExpression(sleepMatch[1])})`
  }

  // --- synth :name, opts --- (explicit synth command)
  const synthMatch = line.match(/^synth\s+"?(\w+)"?\s*,?\s*(.*)$/)
  if (synthMatch) {
    const synthName = synthMatch[1]
    const rest = synthMatch[2].trim()
    const args = rest ? transpileArgs(rest, srcLine) : (srcLine !== undefined ? `{ _srcLine: ${srcLine} }` : '')
    return `b.play(${args ? args : ''}, { synth: "${synthName}"${srcLine !== undefined ? `, _srcLine: ${srcLine}` : ''} })`.replace(', {})', ')').replace('(, ', '(')
  }

  // --- bare synth name as command: beep note:67, tb303 60, etc ---
  const SYNTH_NAMES = ['beep','saw','prophet','tb303','supersaw','pluck','pretty_bell','piano','dsaw','dpulse','dtri','fm','mod_fm','mod_saw','mod_pulse','mod_tri','sine','square','tri','pulse','noise','pnoise','bnoise','gnoise','cnoise','chipbass','chiplead','chipnoise','dark_ambience','hollow','growl','zawa','blade','tech_saws']
  const bareSynthMatch = line.match(/^(\w+)\s+(.+)$/)
  if (bareSynthMatch && SYNTH_NAMES.includes(bareSynthMatch[1])) {
    const synthName = bareSynthMatch[1]
    const args = transpileArgs(bareSynthMatch[2], srcLine)
    // Inject synth name into the opts
    if (args.includes('{')) {
      return `b.play(${args.replace('{', `{ synth: "${synthName}", `)})`
    }
    return `b.play(${args}, { synth: "${synthName}"${srcLine !== undefined ? `, _srcLine: ${srcLine}` : ''} })`
  }

  // --- sample :name, opts ---
  const sampleMatch = line.match(/^sample\s+(.+)$/)
  if (sampleMatch) {
    const args = transpileArgs(sampleMatch[1], srcLine)
    return `b.sample(${args})`
  }

  // --- control node, opts ---
  const controlMatch = line.match(/^control\s+(\w+)\s*,\s*(.+)$/)
  if (controlMatch) {
    const nodeVar = controlMatch[1]
    const args = transpileArgs(controlMatch[2])
    return `b.control(${nodeVar}, ${args})`
  }

  // --- sync :name ---
  const syncMatch = line.match(/^sync\s+:(\w+)\s*$/)
  if (syncMatch) {
    return `b.sync("${syncMatch[1]}")`
  }

  // --- cue :name ---
  const cueMatch = line.match(/^cue\s+:(\w+)\s*(.*)$/)
  if (cueMatch) {
    const args = cueMatch[2] ? `, ${transpileExpression(cueMatch[2])}` : ''
    return `b.cue("${cueMatch[1]}"${args})`
  }

  // --- live_audio :name, opts ---
  const liveAudioMatch = line.match(/^live_audio\s+(.+)$/)
  if (liveAudioMatch) {
    const args = transpileArgs(liveAudioMatch[1])
    return `b.live_audio(${args})`
  }

  // --- use_synth :name ---
  const useSynthMatch = line.match(/^use_synth\s+:(\w+)\s*$/)
  if (useSynthMatch) {
    const prefix = insideLoop ? 'b.' : ''
    return `${prefix}use_synth("${useSynthMatch[1]}")`
  }

  // --- use_bpm N ---
  const useBpmMatch = line.match(/^use_bpm\s+(.+)$/)
  if (useBpmMatch) {
    const prefix = insideLoop ? 'b.' : ''
    return `${prefix}use_bpm(${transpileExpression(useBpmMatch[1])})`
  }

  // --- use_random_seed N ---
  const useRandomSeedMatch = line.match(/^use_random_seed\s+(.+)$/)
  if (useRandomSeedMatch) {
    const prefix = insideLoop ? 'b.' : ''
    return `${prefix}use_random_seed(${transpileExpression(useRandomSeedMatch[1])})`
  }

  // --- puts "text" ---
  const putsMatch = line.match(/^puts\s+(.+)$/)
  if (putsMatch) {
    const prefix = insideLoop ? 'b.' : ''
    return `${prefix}puts(${transpileExpression(putsMatch[1])})`
  }

  // --- print "text" ---
  const printMatch = line.match(/^print\s+(.+)$/)
  if (printMatch) {
    const prefix = insideLoop ? 'b.' : ''
    return `${prefix}puts(${transpileExpression(printMatch[1])})`
  }

  // --- Variable assignment ---
  const assignMatch = line.match(/^(\w+)\s*=\s*(.+)$/)
  if (assignMatch) {
    const varName = assignMatch[1]
    const rhs = transpileLine(assignMatch[2], insideLoop, srcLine)
    // play/sample return `this` for chaining — use lastRef for node control
    if (insideLoop && /^b\.(play|sample)\(/.test(rhs)) {
      return `${rhs}; const ${varName} = b.lastRef`
    }
    return `const ${varName} = ${rhs}`
  }

  // General expression — transpile Ruby syntax within it
  return transpileExpression(line)
}

/**
 * Transpile a Ruby expression to JS.
 */
function transpileExpression(expr: string): string {
  let result = expr.trim()

  // Ruby symbols :name → "name" (only letter/underscore-starting; skip ternary :50)
  result = result.replace(/:([a-zA-Z_]\w*)/g, '"$1"')

  // Ruby string interpolation #{expr} → ${expr} with backtick conversion
  // "hello #{name}" → `hello ${name}`
  result = result.replace(/"([^"]*#\{[^"]*)"/, (_match, inner) => {
    return '`' + inner.replace(/#\{/g, '${') + '`'
  })
  result = result.replace(/#\{/g, '${')

  // ring, knit, range, line, spread, chord, scale, note, note_range, chord_invert → b.*
  result = result.replace(/\b(ring|knit|range|line|spread|chord|scale|chord_invert|note_range|note)\s*\(/g, 'b.$1(')
  // Without parens: ring 1, 2, 3 — also handles (ring ...) wrapping
  result = result.replace(/(?<=\(|^)(ring|spread)\s+([^(].+?)(?=\)|$)/g, 'b.$1($2)')

  // rrand, choose, dice, rrand_i, tick, look → b.*
  result = result.replace(/\b(rrand_i|rrand|rand_i|rand|choose|dice|one_in)\s*\(/g, 'b.$1(')
  // Without parens: rrand 0, 1
  result = result.replace(/\b(rrand_i|rrand|rand_i|rand)\s+([^(].+)$/, 'b.$1($2)')
  // Bare rand / rand_i (no args, no parens) — Ruby treats as function call
  result = result.replace(/(?<!\.)(?<!\w)\b(rand_i|rand)\b(?!\s*[.()\w])/g, 'b.$1()')

  // Standalone tick/look (as function call, not method .tick())
  result = result.replace(/(?<!\.)(?<!\w)\btick\s*\(/g, 'b.tick(')
  result = result.replace(/(?<!\.)(?<!\w)\blook\s*\(/g, 'b.look(')

  // Standalone tick/look without parens (bare tick, not as method .tick)
  result = result.replace(/(?<!\.)(?<!\w)\btick\b(?!\s*[.(])/g, 'b.tick()')
  result = result.replace(/(?<!\.)(?<!\w)\blook\b(?!\s*[.(])/g, 'b.look()')

  // .tick / .tick() on ring objects → .at(b.tick())
  // Ring.tick() uses the ring's own counter which resets each iteration.
  // b.tick() uses the ProgramBuilder's counter which persists across iterations.
  result = result.replace(/\.tick\(\)/g, '.at(b.tick())')
  result = result.replace(/\.tick(?!\()/g, '.at(b.tick())')

  // .look / .look() → .at(b.look())
  result = result.replace(/\.look\(\)/g, '.at(b.look())')
  result = result.replace(/\.look(?!\()/g, '.at(b.look())')

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

  // [].choose → b.choose([])
  // Already handled if user writes choose([...])

  // Ruby block syntax: .map { |var| expr } → .map((var) => expr)
  result = result.replace(/\.map\s*\{\s*\|(\w+)\|\s*(.+?)\s*\}/g, '.map(($1) => $2)')
  result = result.replace(/\.select\s*\{\s*\|(\w+)\|\s*(.+?)\s*\}/g, '.filter(($1) => $2)')
  result = result.replace(/\.reject\s*\{\s*\|(\w+)\|\s*(.+?)\s*\}/g, '.filter(($1) => !($2))')
  result = result.replace(/\.collect\s*\{\s*\|(\w+)\|\s*(.+?)\s*\}/g, '.map(($1) => $2)')

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
  if (/\bb\./.test(trimmed)) return 'js'
  if (/=>/.test(trimmed)) return 'js'
  if (/\bconst\b|\blet\b|\bvar\b/.test(trimmed)) return 'js'

  // Default to Ruby (Sonic Pi is the primary use case)
  return 'ruby'
}

/** Result of autoTranspile — includes fallback metadata for callers. */
export interface TranspileResult {
  code: string
  usedFallback: boolean
  fallbackReason?: string
}

/**
 * Auto-detect language and transpile if needed.
 * Uses the recursive descent parser as primary (handles nesting, b. prefix,
 * structured errors). Falls back to regex transpiler if parser reports errors.
 * Returns the transpiled JS code string (backward compatible).
 */
export function autoTranspile(code: string): string {
  return autoTranspileDetailed(code).code
}

/**
 * Auto-detect language and transpile if needed, with detailed metadata.
 * Returns `{ code, usedFallback, fallbackReason }` for callers that need
 * to know whether the parser fell back to the regex transpiler.
 */
export function autoTranspileDetailed(code: string): TranspileResult {
  if (detectLanguage(code) === 'js') return { code, usedFallback: false }

  // Wrap bare code in implicit live_loop BEFORE either transpiler
  code = wrapBareCode(code)

  // Primary: recursive descent parser
  const { code: parsed, errors } = _parseAndTranspile(code)
  if (errors.length === 0) {
    // Validate the output creates a valid Function (catches bad JS generation)
    try {
      new Function(parsed)
      return { code: parsed, usedFallback: false }
    } catch {
      // Parser output is invalid JS — fall back
      const reason = 'Parser produced invalid JS'
      console.warn(`[SonicPi] ${reason}, falling back to regex transpiler`)
      return { code: transpileRubyToJS(code), usedFallback: true, fallbackReason: reason }
    }
  } else {
    const reason = errors.map(e => e.message).join('; ')
    console.warn('[SonicPi] Parser reported errors, falling back to regex transpiler:', errors)
    return { code: transpileRubyToJS(code), usedFallback: true, fallbackReason: reason }
  }
}
