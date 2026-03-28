/**
 * Recursive descent parser for Sonic Pi's Ruby DSL.
 *
 * Replaces the regex transpiler with a proper parser that:
 * - Handles nested blocks (do/end, if/end, .times, etc.)
 * - Gives friendly error messages with line numbers
 * - Handles Ruby patterns regex misses: multi-line expressions,
 *   method chains, begin/rescue, unless blocks
 * - Outputs JavaScript for the engine
 *
 * Grammar (simplified):
 *   program     → (statement NL)*
 *   statement   → live_loop | with_fx | define | if_block | unless_block
 *               | times_loop | each_loop | loop_block | in_thread | density
 *               | expression
 *   live_loop   → 'live_loop' SYMBOL (',' sync_opt)? 'do' block 'end'
 *   with_fx     → 'with_fx' SYMBOL (',' args)? 'do' block 'end'
 *   define      → 'define' SYMBOL 'do' ('|' params '|')? block 'end'
 *   if_block    → 'if' expr block ('elsif' expr block)* ('else' block)? 'end'
 *   unless_block → 'unless' expr block 'end'
 *   times_loop  → expr '.times' 'do' ('|' var '|')? block 'end'
 *   each_loop   → expr '.each' 'do' ('|' var '|')? block 'end'
 *   loop_block  → 'loop' 'do' block 'end'
 *   in_thread   → 'in_thread' 'do' block 'end'
 *   density     → 'density' expr 'do' block 'end'
 *   expression  → play | sleep | sample | use_synth | use_bpm | ...
 */

export interface ParseError {
  message: string
  line: number
  column: number
  suggestion?: string
}

interface Token {
  type: 'word' | 'symbol' | 'number' | 'string' | 'op' | 'newline' | 'comma'
       | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'lbrace' | 'rbrace'
       | 'pipe' | 'dot' | 'colon' | 'hash_comment' | 'eof'
  value: string
  line: number
  col: number
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  // Join continuation lines: trailing comma, backslash, or binary operator
  const rawLines = source.split('\n')
  const lines: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]
    while (i + 1 < rawLines.length) {
      const t = line.trimEnd()
      if (t.endsWith('\\')) {
        line = t.slice(0, -1).trimEnd() + ' ' + rawLines[i + 1].trim()
        i++
      } else if (t.endsWith(',') || /(?:&&|\|\||[+*\/%]|\band\b|\bor\b)$/.test(t)) {
        line = t + ' ' + rawLines[i + 1].trim()
        i++
      } else {
        break
      }
    }
    lines.push(line)
  }

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum]
    let i = 0

    while (i < line.length) {
      const ch = line[i]

      // Whitespace
      if (ch === ' ' || ch === '\t') { i++; continue }

      // Comment
      if (ch === '#') {
        tokens.push({ type: 'hash_comment', value: line.slice(i), line: lineNum + 1, col: i + 1 })
        break
      }

      // String (double-quoted) — convert to backtick template if interpolation present
      if (ch === '"') {
        let str = '"'
        i++
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\') { str += line[i++] }
          str += line[i++]
        }
        if (i < line.length) { str += '"'; i++ }
        // Ruby #{expr} → JS ${expr} in backtick template literal
        if (str.includes('#{')) {
          str = '`' + str.slice(1, -1).replace(/#\{/g, '${') + '`'
        }
        tokens.push({ type: 'string', value: str, line: lineNum + 1, col: i + 1 })
        continue
      }

      // String (single-quoted)
      if (ch === "'") {
        let str = "'"
        i++
        while (i < line.length && line[i] !== "'") {
          if (line[i] === '\\') { str += line[i++] }
          str += line[i++]
        }
        if (i < line.length) { str += "'"; i++ }
        tokens.push({ type: 'string', value: str, line: lineNum + 1, col: i + 1 })
        continue
      }

      // Symbol :name
      if (ch === ':' && i + 1 < line.length && /[a-zA-Z_]/.test(line[i + 1])) {
        let sym = ':'
        i++
        while (i < line.length && /[\w]/.test(line[i])) { sym += line[i++] }
        tokens.push({ type: 'symbol', value: sym, line: lineNum + 1, col: i + 1 })
        continue
      }

      // Number (careful: 4.times should be number(4) + dot + word, not number(4.))
      if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < line.length && /[0-9]/.test(line[i + 1]) && (tokens.length === 0 || ['op', 'comma', 'lparen', 'lbracket', 'colon', 'newline'].includes(tokens[tokens.length - 1]?.type)))) {
        let num = ''
        if (ch === '-') { num += '-'; i++ }
        while (i < line.length && /[0-9]/.test(line[i])) { num += line[i++] }
        // Only consume dot if followed by a digit (decimal point), not a letter (method call)
        if (i < line.length && line[i] === '.' && i + 1 < line.length && /[0-9]/.test(line[i + 1])) {
          num += line[i++]
          while (i < line.length && /[0-9]/.test(line[i])) { num += line[i++] }
        }
        tokens.push({ type: 'number', value: num, line: lineNum + 1, col: i + 1 })
        continue
      }

      // Word / keyword
      if (/[a-zA-Z_]/.test(ch)) {
        let word = ''
        while (i < line.length && /[\w!?]/.test(line[i])) { word += line[i++] }
        tokens.push({ type: 'word', value: word, line: lineNum + 1, col: i + 1 })
        continue
      }

      // Operators and punctuation
      // Check || BEFORE singles — '|' is in singles (pipe) and would swallow it
      if (ch === '|' && i + 1 < line.length && line[i + 1] === '|') {
        tokens.push({ type: 'op', value: '||', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }

      const singles: Record<string, Token['type']> = {
        '(': 'lparen', ')': 'rparen',
        '[': 'lbracket', ']': 'rbracket',
        '{': 'lbrace', '}': 'rbrace',
        ',': 'comma', '|': 'pipe', '.': 'dot',
      }

      if (singles[ch]) {
        tokens.push({ type: singles[ch], value: ch, line: lineNum + 1, col: i + 1 })
        i++
        continue
      }

      // Multi-char operators
      if (ch === '=' && line[i + 1] === '=') {
        tokens.push({ type: 'op', value: '==', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '!' && line[i + 1] === '=') {
        tokens.push({ type: 'op', value: '!=', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '<' && line[i + 1] === '=') {
        tokens.push({ type: 'op', value: '<=', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '>' && line[i + 1] === '=') {
        tokens.push({ type: 'op', value: '>=', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '&' && line[i + 1] === '&') {
        tokens.push({ type: 'op', value: '&&', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '|' && line[i + 1] === '|') {
        tokens.push({ type: 'op', value: '||', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }
      if (ch === '.' && line[i + 1] === '.') {
        tokens.push({ type: 'op', value: '..', line: lineNum + 1, col: i + 1 })
        i += 2; continue
      }

      // Single-char operators
      if ('=<>+-*/%!&^~?'.includes(ch)) {
        tokens.push({ type: 'op', value: ch, line: lineNum + 1, col: i + 1 })
        i++; continue
      }

      // Colon (not symbol)
      if (ch === ':') {
        tokens.push({ type: 'colon', value: ':', line: lineNum + 1, col: i + 1 })
        i++; continue
      }

      // Skip unknown
      i++
    }

    // Add newline token
    tokens.push({ type: 'newline', value: '\n', line: lineNum + 1, col: line.length + 1 })
  }

  tokens.push({ type: 'eof', value: '', line: lines.length, col: 0 })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse and transpile Sonic Pi Ruby DSL to JavaScript.
 * Returns { code, errors }.
 */
export function parseAndTranspile(source: string): { code: string; errors: ParseError[] } {
  const tokens = tokenize(source)
  const errors: ParseError[] = []
  let pos = 0
  const output: string[] = []

  // Track block depth for b. prefix
  let insideLoop = false
  const blockStack: Array<'loop' | 'block' | 'thread'> = []
  const definedFunctions = new Set<string>()

  function peek(): Token { return tokens[pos] ?? { type: 'eof', value: '', line: 0, col: 0 } }
  function advance(): Token { return tokens[pos++] }
  function at(type: Token['type'], value?: string): boolean {
    const t = peek()
    return t.type === type && (value === undefined || t.value === value)
  }
  function expect(type: Token['type'], value?: string): Token {
    const t = peek()
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      errors.push({
        message: `Expected ${value ?? type}, got "${t.value}"`,
        line: t.line,
        column: t.col,
      })
    }
    return advance()
  }
  function skipNewlines(): void {
    while (at('newline')) advance()
  }
  function getIndent(): string {
    // Use 2-space indent based on block depth
    return '  '.repeat(blockStack.length)
  }

  function parseProgram(): void {
    skipNewlines()
    while (!at('eof')) {
      parseStatement()
      skipNewlines()
    }
  }

  function parseStatement(): void {
    skipNewlines()
    if (at('eof')) return

    const t = peek()

    // Comments
    if (t.type === 'hash_comment') {
      output.push(`${getIndent()}//${t.value.slice(1)}`)
      advance()
      if (at('newline')) advance()
      return
    }

    // live_loop
    if (t.type === 'word' && t.value === 'live_loop') {
      parseLiveLoop()
      return
    }

    // with_fx
    if (t.type === 'word' && t.value === 'with_fx') {
      parseWithFx()
      return
    }

    // define
    if (t.type === 'word' && t.value === 'define') {
      parseDefine()
      return
    }

    // in_thread
    if (t.type === 'word' && t.value === 'in_thread') {
      parseInThread()
      return
    }

    // if block
    if (t.type === 'word' && t.value === 'if') {
      parseIfBlock()
      return
    }

    // unless block
    if (t.type === 'word' && t.value === 'unless') {
      parseUnlessBlock()
      return
    }

    // loop do
    if (t.type === 'word' && t.value === 'loop') {
      parseLoopDo()
      return
    }

    // at [times] do ... end
    if (t.type === 'word' && t.value === 'at') {
      parseAtBlock()
      return
    }

    // time_warp N do ... end (sugar for at([N], null, fn))
    if (t.type === 'word' && t.value === 'time_warp') {
      parseTimeWarp()
      return
    }

    // density N do
    if (t.type === 'word' && t.value === 'density') {
      parseDensity()
      return
    }

    // case/when
    if (t.type === 'word' && t.value === 'case') {
      parseCaseWhen()
      return
    }

    // begin/rescue/ensure/end
    if (t.type === 'word' && t.value === 'begin') {
      parseBeginRescue()
      return
    }

    // end
    if (t.type === 'word' && t.value === 'end') {
      // Handled by block parsers — shouldn't reach here
      advance()
      if (at('newline')) advance()
      return
    }

    // elsif / else — handled by if parser
    if (t.type === 'word' && (t.value === 'elsif' || t.value === 'else')) {
      advance()
      if (at('newline')) advance()
      return
    }

    // General line — collect tokens until newline
    parseLine()
  }

  function parseLiveLoop(): void {
    const startLine = peek().line
    advance() // 'live_loop'

    // Name (symbol)
    let name = 'main'
    if (at('symbol')) {
      name = advance().value.slice(1) // strip ':'
    }

    // Optional sync: :name
    let syncName: string | null = null
    if (at('comma')) {
      advance()
      if (at('word', 'sync')) {
        advance()
        if (at('colon')) advance()
        if (at('symbol')) {
          syncName = advance().value.slice(1)
        }
      }
    }

    // 'do'
    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}live_loop("${name}", (b) => {`)

    if (syncName) {
      output.push(`${indent}  b.sync("${syncName}")`)
    }

    blockStack.push('loop')
    const prevInsideLoop = insideLoop
    insideLoop = true

    parseBlock()

    insideLoop = prevInsideLoop
    blockStack.pop()

    // 'end'
    if (at('word', 'end')) {
      advance()
    } else {
      errors.push({
        message: `Expected 'end' to close 'live_loop :${name} do' (opened on line ${startLine})`,
        line: peek().line,
        column: peek().col,
      })
    }
    output.push(`${indent}})`)
    if (at('newline')) advance()
  }

  function parseWithFx(): void {
    const startLine = peek().line
    advance() // 'with_fx'

    let fxName = 'reverb'
    if (at('symbol')) fxName = advance().value.slice(1)

    // Optional params
    let opts = ''
    if (at('comma')) {
      advance()
      opts = collectUntilDo()
    }

    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    const prefix = insideLoop ? 'b.' : ''
    if (opts) {
      output.push(`${indent}${prefix}with_fx("${fxName}", ${transpileArgs(opts)}, (b) => {`)
    } else {
      output.push(`${indent}${prefix}with_fx("${fxName}", (b) => {`)
    }

    blockStack.push('loop')
    const prevInsideLoop = insideLoop
    insideLoop = true
    parseBlock()
    insideLoop = prevInsideLoop
    blockStack.pop()

    if (at('word', 'end')) advance()
    else errors.push({ message: `Expected 'end' to close 'with_fx :${fxName} do' (opened on line ${startLine})`, line: peek().line, column: peek().col })

    output.push(`${indent}})`)
    if (at('newline')) advance()
  }

  function parseDefine(): void {
    advance() // 'define'
    let name = 'my_func'
    if (at('symbol')) name = advance().value.slice(1)

    definedFunctions.add(name)

    if (at('word', 'do')) advance()

    // Optional |params|
    let params = ''
    if (at('pipe')) {
      advance()
      const parts: string[] = []
      while (!at('pipe') && !at('newline') && !at('eof')) {
        parts.push(advance().value)
      }
      if (at('pipe')) advance()
      params = parts.filter(p => p !== ',').join(', ')
    }
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}function ${name}(b${params ? ', ' + params : ''}) {`)

    const prevInsideLoop = insideLoop
    insideLoop = true
    blockStack.push('block')
    parseBlock()
    blockStack.pop()
    insideLoop = prevInsideLoop

    if (at('word', 'end')) advance()
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseInThread(): void {
    advance() // 'in_thread'
    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    const prefix = insideLoop ? 'b.' : ''
    output.push(`${indent}${prefix}in_thread((b) => {`)

    const prevInsideLoop = insideLoop
    insideLoop = true
    blockStack.push('loop')  // 'loop' so body gets b. prefixes
    parseBlock()
    blockStack.pop()
    insideLoop = prevInsideLoop

    if (at('word', 'end')) advance()
    output.push(`${indent}})`)
    if (at('newline')) advance()
  }

  function parseIfBlock(): void {
    advance() // 'if'
    const cond = collectUntilNewline()
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}if (${addBuilderPrefixes(transpileExpr(cond), insideLoop)}) {`)
    blockStack.push('block')
    parseBlock()

    // Handle elsif/else chains
    while (at('word', 'elsif')) {
      advance()
      const elsifCond = collectUntilNewline()
      skipNewlines()
      output.push(`${indent}} else if (${addBuilderPrefixes(transpileExpr(elsifCond), insideLoop)}) {`)
      parseBlock()
    }

    if (at('word', 'else')) {
      advance()
      skipNewlines()
      output.push(`${indent}} else {`)
      parseBlock()
    }

    blockStack.pop()
    if (at('word', 'end')) advance()
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseCaseWhen(): void {
    advance() // 'case'
    const expr = collectUntilNewline().trim()
    skipNewlines()

    const indent = getIndent()
    let firstWhen = true

    while (!at('eof') && !at('word', 'end')) {
      if (at('word', 'when')) {
        advance()
        const vals = collectUntilNewline().split(',').map(v => v.trim())
        const condition = vals.map(v =>
          `${addBuilderPrefixes(transpileExpr(expr), insideLoop)} === ${addBuilderPrefixes(transpileExpr(v), insideLoop)}`
        ).join(' || ')
        skipNewlines()
        if (firstWhen) {
          output.push(`${indent}if (${condition}) {`)
          firstWhen = false
        } else {
          output.push(`${indent}} else if (${condition}) {`)
        }
        blockStack.push('block')
        parseBlock()
        blockStack.pop()
      } else if (at('word', 'else')) {
        advance()
        skipNewlines()
        output.push(`${indent}} else {`)
        blockStack.push('block')
        parseBlock()
        blockStack.pop()
        break
      } else {
        break
      }
    }

    if (at('word', 'end')) advance()
    if (!firstWhen) output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseUnlessBlock(): void {
    advance() // 'unless'
    const cond = collectUntilNewline()
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}if (!(${addBuilderPrefixes(transpileExpr(cond), insideLoop)})) {`)
    blockStack.push('block')
    parseBlock()
    blockStack.pop()
    if (at('word', 'end')) advance()
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseLoopDo(): void {
    advance() // 'loop'
    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}while (true) {`)
    output.push(`${indent}  b.__checkBudget__()`)
    blockStack.push('block')
    parseBlock()
    blockStack.pop()
    if (at('word', 'end')) advance()
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseDensity(): void {
    advance() // 'density'
    const factor = collectUntilDo()
    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    const bRef = insideLoop ? 'b' : '__densityB'
    output.push(`${indent}{`)
    if (!insideLoop) {
      output.push(`${indent}  const ${bRef} = { density: 1 }`)
    }
    output.push(`${indent}  const __prevDensity = ${bRef}.density`)
    output.push(`${indent}  ${bRef}.density = __prevDensity * ${factor.trim()}`)

    const prevInsideLoop = insideLoop
    insideLoop = true
    blockStack.push('block')
    parseBlock()
    blockStack.pop()
    insideLoop = prevInsideLoop

    if (at('word', 'end')) advance()
    output.push(`${indent}  ${bRef}.density = __prevDensity`)
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  function parseBeginRescue(): void {
    advance() // 'begin'
    skipNewlines()

    const indent = getIndent()
    output.push(`${indent}try {`)
    blockStack.push('block')
    parseBlockUntil(['rescue', 'ensure', 'end'])

    // Handle rescue
    if (at('word', 'rescue')) {
      advance()
      let errorVar = '_e'
      // Optional => e (tokenizer splits => into = and >)
      if (at('op', '=')) {
        advance() // '='
        if (at('op', '>')) {
          advance() // '>'
          if (at('word')) {
            errorVar = advance().value
          }
        }
      }
      skipNewlines()
      blockStack.pop()
      output.push(`${indent}} catch (${errorVar}) {`)
      blockStack.push('block')
      parseBlockUntil(['ensure', 'end'])
    }

    // Handle ensure
    if (at('word', 'ensure')) {
      advance()
      skipNewlines()
      blockStack.pop()
      output.push(`${indent}} finally {`)
      blockStack.push('block')
      parseBlockUntil(['end'])
    }

    blockStack.pop()
    if (at('word', 'end')) advance()
    output.push(`${indent}}`)
    if (at('newline')) advance()
  }

  /** Like parseBlock() but also stops at specific keywords. */
  function parseBlockUntil(stopWords: string[]): void {
    skipNewlines()
    while (
      !at('eof') &&
      !at('word', 'end') &&
      !at('word', 'elsif') &&
      !at('word', 'else') &&
      !stopWords.some(w => at('word', w))
    ) {
      parseStatement()
      skipNewlines()
    }
  }

  function parseAtBlock(): void {
    const startLine = peek().line
    advance() // 'at'

    // Collect times array: tokens until 'do' or comma followed by '[' (second array)
    // Strategy: collect all tokens until 'do', split by comma at depth 0 to detect
    // whether there's a second array argument
    const allTokens: Token[] = []
    while (!at('word', 'do') && !at('newline') && !at('eof')) {
      allTokens.push(advance())
    }

    // Split into times and optional values by finding comma at depth 0 between ] and [
    let timesStr = ''
    let valuesStr = ''
    let splitIdx = -1
    let depth = 0
    for (let j = 0; j < allTokens.length; j++) {
      const tk = allTokens[j]
      if (tk.type === 'lbracket') depth++
      if (tk.type === 'rbracket') depth--
      if (tk.type === 'comma' && depth === 0) {
        // Check if there's a '[' ahead (values array)
        const rest = allTokens.slice(j + 1)
        if (rest.some(r => r.type === 'lbracket')) {
          splitIdx = j
          break
        }
      }
    }

    if (splitIdx >= 0) {
      timesStr = allTokens.slice(0, splitIdx).map(t => transpileToken(t)).join(' ').trim()
      valuesStr = allTokens.slice(splitIdx + 1).map(t => transpileToken(t)).join(' ').trim()
    } else {
      timesStr = allTokens.map(t => transpileToken(t)).join(' ').trim()
    }

    if (at('word', 'do')) advance()

    // Optional |params|
    let params: string[] = []
    if (at('pipe')) {
      advance()
      while (!at('pipe') && !at('newline') && !at('eof')) {
        const tk = advance()
        if (tk.type !== 'comma') params.push(tk.value)
      }
      if (at('pipe')) advance()
    }
    skipNewlines()

    const indent = getIndent()
    const prefix = insideLoop ? 'b.' : ''
    // Build the callback signature
    const paramList = params.length > 0 ? `, ${params.join(', ')}` : ''
    output.push(`${indent}${prefix}at(${timesStr}, ${valuesStr || 'null'}, (b${paramList}) => {`)

    blockStack.push('loop')
    const prevInsideLoop = insideLoop
    insideLoop = true
    parseBlock()
    insideLoop = prevInsideLoop
    blockStack.pop()

    if (at('word', 'end')) advance()
    else errors.push({ message: `Expected 'end' to close 'at' block (opened on line ${startLine})`, line: peek().line, column: peek().col })

    output.push(`${indent}})`)
    if (at('newline')) advance()
  }

  function parseTimeWarp(): void {
    advance() // 'time_warp'
    const offset = collectUntilDo().trim()
    if (at('word', 'do')) advance()
    skipNewlines()

    const indent = getIndent()
    const prefix = insideLoop ? 'b.' : ''
    output.push(`${indent}${prefix}at([${offset}], null, (b) => {`)

    blockStack.push('loop')
    const prevInsideLoop = insideLoop
    insideLoop = true
    parseBlock()
    insideLoop = prevInsideLoop
    blockStack.pop()

    if (at('word', 'end')) advance()
    output.push(`${indent}})`)
    if (at('newline')) advance()
  }

  function parseBlock(): void {
    skipNewlines()
    while (!at('eof') && !at('word', 'end') && !at('word', 'elsif') && !at('word', 'else')) {
      parseStatement()
      skipNewlines()
    }
  }

  function parseLine(): void {
    // Collect all tokens on this line
    const lineTokens: Token[] = []
    while (!at('newline') && !at('eof')) {
      lineTokens.push(advance())
    }
    if (at('newline')) advance()

    if (lineTokens.length === 0) return

    // Check for N.times do |var| pattern
    const timesIdx = lineTokens.findIndex((t, i) =>
      t.type === 'dot' && lineTokens[i + 1]?.value === 'times'
    )
    if (timesIdx >= 0 && lineTokens.some(t => t.value === 'do')) {
      const countTokens = lineTokens.slice(0, timesIdx)
      const count = countTokens.map(t => transpileToken(t)).join('')

      // Find |var| if present
      let varName = '_i'
      const pipeIdx = lineTokens.findIndex(t => t.type === 'pipe')
      if (pipeIdx >= 0) {
        const endPipe = lineTokens.findIndex((t, i) => i > pipeIdx && t.type === 'pipe')
        if (endPipe >= 0) {
          varName = lineTokens.slice(pipeIdx + 1, endPipe).map(t => t.value).join('').trim()
        }
      }

      const indent = getIndent()
      output.push(`${indent}for (let ${varName} = 0; ${varName} < ${transpileExpr(count)}; ${varName}++) {`)
      output.push(`${indent}  b.__checkBudget__()`)
      blockStack.push('block')
      parseBlock()
      blockStack.pop()
      if (at('word', 'end')) advance()
      output.push(`${indent}}`)
      return
    }

    // Check for expr.each do |var| pattern
    const eachIdx = lineTokens.findIndex((t, i) =>
      t.type === 'dot' && lineTokens[i + 1]?.value === 'each'
    )
    if (eachIdx >= 0 && lineTokens.some(t => t.value === 'do')) {
      const iterableTokens = lineTokens.slice(0, eachIdx)
      const iterable = iterableTokens.map((t, idx) => {
        const val = transpileToken(t)
        const next = iterableTokens[idx + 1]
        if (t.type === 'dot' || next?.type === 'dot') return val
        if (t.type === 'lbracket' || t.type === 'lparen') return val
        if (next && ['comma', 'rbracket', 'rparen'].includes(next.type)) return val
        return val + ' '
      }).join('').trim()

      // Find |var| if present
      let varName = '_item'
      const pipeIdx = lineTokens.findIndex(t => t.type === 'pipe')
      if (pipeIdx >= 0) {
        const endPipe = lineTokens.findIndex((t, i) => i > pipeIdx && t.type === 'pipe')
        if (endPipe >= 0) {
          varName = lineTokens.slice(pipeIdx + 1, endPipe).map(t => t.value).join('').trim()
        }
      }

      const indent = getIndent()
      output.push(`${indent}for (const ${varName} of ${transpileExpr(iterable)}) {`)
      output.push(`${indent}  b.__checkBudget__()`)
      blockStack.push('block')
      parseBlock()
      blockStack.pop()
      if (at('word', 'end')) advance()
      output.push(`${indent}}`)
      return
    }

    // Check for expr.map/select/reject/collect do |var| pattern (multi-line)
    const MAP_METHODS: Record<string, string> = { map: 'map', select: 'filter', reject: 'filter', collect: 'map' }
    const mapIdx = lineTokens.findIndex((t, i) =>
      t.type === 'dot' && lineTokens[i + 1] && MAP_METHODS[lineTokens[i + 1].value]
    )
    if (mapIdx >= 0 && lineTokens.some(t => t.value === 'do')) {
      const methodName = lineTokens[mapIdx + 1].value as keyof typeof MAP_METHODS
      const jsMethod = MAP_METHODS[methodName]
      const isReject = methodName === 'reject'

      const iterableTokens = lineTokens.slice(0, mapIdx)
      const iterable = iterableTokens.map((t, idx) => {
        const val = transpileToken(t)
        const next = iterableTokens[idx + 1]
        if (t.type === 'dot' || next?.type === 'dot') return val
        if (t.type === 'lbracket' || t.type === 'lparen') return val
        if (next && ['comma', 'rbracket', 'rparen'].includes(next.type)) return val
        return val + ' '
      }).join('').trim()

      // Find |var| if present
      let varName = '_item'
      const pipeIdx = lineTokens.findIndex(t => t.type === 'pipe')
      if (pipeIdx >= 0) {
        const endPipe = lineTokens.findIndex((t, i) => i > pipeIdx && t.type === 'pipe')
        if (endPipe >= 0) {
          varName = lineTokens.slice(pipeIdx + 1, endPipe).map(t => t.value).join('').trim()
        }
      }

      // Check if there's an assignment: `result = expr.map do |n|`
      let assignVar: string | null = null
      // Look backwards from the iterable to see if there's an assignment
      // The iterable itself may contain the assignment pattern
      const iterableStr = transpileExpr(iterable)
      const assignCheck = iterableStr.match(/^(\w+)\s*=\s*(.+)$/)
      let actualIterable = iterableStr
      if (assignCheck) {
        assignVar = assignCheck[1]
        actualIterable = assignCheck[2]
      }

      const indent = getIndent()
      // Collect block body lines
      const bodyOutput: string[] = []
      const savedOutput = output.splice(0, output.length) // save current output
      blockStack.push('block')
      const prevInsideLoop = insideLoop
      insideLoop = true
      parseBlock()
      insideLoop = prevInsideLoop
      blockStack.pop()
      // The body lines are now in `output`
      bodyOutput.push(...output)
      output.length = 0
      output.push(...savedOutput) // restore

      if (at('word', 'end')) advance()

      if (bodyOutput.length === 1) {
        // Single-line body — emit as arrow expression
        const bodyExpr = bodyOutput[0].trim()
        const expr = isReject
          ? `${actualIterable}.${jsMethod}((${varName}) => !(${bodyExpr}))`
          : `${actualIterable}.${jsMethod}((${varName}) => ${bodyExpr})`
        if (assignVar) {
          output.push(`${indent}const ${assignVar} = ${expr}`)
        } else {
          output.push(`${indent}${expr}`)
        }
      } else {
        // Multi-line body — last expression is return value
        const lastLine = bodyOutput.pop()?.trim() ?? ''
        const bodyLines = bodyOutput.map(l => `${indent}  ${l.trim()}`).join('\n')
        const returnLine = isReject
          ? `${indent}  return !(${lastLine})`
          : `${indent}  return ${lastLine}`
        const fnBody = bodyLines ? `\n${bodyLines}\n${returnLine}\n${indent}` : `\n${returnLine}\n${indent}`
        const expr = `${actualIterable}.${jsMethod}((${varName}) => {${fnBody}})`
        if (assignVar) {
          output.push(`${indent}const ${assignVar} = ${expr}`)
        } else {
          output.push(`${indent}${expr}`)
        }
      }
      return
    }

    // Reconstruct line — no spaces around dots (for method chains)
    const rawLine = reconstructTokens(lineTokens)
    const indent = getIndent()

    // Rewrite calls to user-defined functions to inject `b` as first arg
    if (insideLoop && lineTokens.length > 0 && lineTokens[0].type === 'word' && definedFunctions.has(lineTokens[0].value)) {
      const fnName = lineTokens[0].value
      // Collect arg tokens (everything after the function name)
      const argTokens = lineTokens.slice(1)
      if (argTokens.length === 0) {
        output.push(`${indent}${fnName}(b)`)
      } else {
        // Reconstruct args, transpiling tokens
        const args = reconstructTokens(argTokens)
        // If args already have parens, inject b after opening paren
        if (args.startsWith('(')) {
          const inner = args.slice(1, -1).trim()
          output.push(`${indent}${fnName}(b${inner ? ', ' + inner : ''})`)
        } else {
          output.push(`${indent}${fnName}(b, ${transpileSonicPiLine(args, false)})`)
        }
      }
      return
    }

    const transpiled = transpileSonicPiLine(rawLine, insideLoop)
    output.push(`${indent}${transpiled}`)
  }

  // Helpers

  /** Reconstruct tokens into a string with proper spacing (no space before/after colons for kwargs). */
  function reconstructTokens(toks: Token[]): string {
    return toks.map((t, idx) => {
      const val = transpileToken(t)
      const next = toks[idx + 1]
      const prev = toks[idx - 1]
      // No space before/after dot
      if (t.type === 'dot' || next?.type === 'dot') return val
      if (prev?.type === 'dot') return val
      // No space before comma, rparen, rbracket
      if (next && ['comma', 'rparen', 'rbracket'].includes(next.type)) return val
      // No space after lparen, lbracket
      if (t.type === 'lparen' || t.type === 'lbracket') return val
      // No space before colon only for kwargs (word immediately before: amp: 2)
      if (next?.type === 'colon' && t.type === 'word') return val
      // No space after colon only for kwargs (word immediately before)
      if (t.type === 'colon' && prev?.type === 'word') return val
      return val + ' '
    }).join('').trim()
  }

  function collectUntilNewline(): string {
    const toks: Token[] = []
    while (!at('newline') && !at('eof')) {
      toks.push(advance())
    }
    return reconstructTokens(toks)
  }

  function collectUntilDo(): string {
    const toks: Token[] = []
    while (!at('word', 'do') && !at('newline') && !at('eof')) {
      toks.push(advance())
    }
    return reconstructTokens(toks)
  }

  function transpileToken(t: Token): string {
    if (t.type === 'symbol') return `"${t.value.slice(1)}"`
    if (t.type === 'word' && t.value === 'nil') return 'null'
    if (t.type === 'word' && t.value === 'true') return 'true'
    if (t.type === 'word' && t.value === 'false') return 'false'
    if (t.type === 'word' && t.value === 'and') return '&&'
    if (t.type === 'word' && t.value === 'or') return '||'
    if (t.type === 'word' && t.value === 'not') return '!'
    return t.value
  }

  // Run the parser
  parseProgram()

  return { code: output.join('\n'), errors }
}

// ---------------------------------------------------------------------------
// Line-level transpilation (reused from regex transpiler)
// ---------------------------------------------------------------------------

function transpileExpr(expr: string): string {
  let result = expr.trim()
  result = result.replace(/#\{/g, '${')
  return result
}

/** Add b. prefix to all DSL function calls in a string. */
function addBuilderPrefixes(line: string, insideLoop: boolean): string {
  if (!insideLoop) return line

  let result = line

  // Expression-level DSL functions (NOT statement-level play/sleep/sample/etc — those
  // are handled by the match arms in transpileSonicPiLine and add their own b. prefix)
  // Use negative lookbehind to avoid prefixing method calls like notes.tick(
  result = result.replace(
    /(?<!\.)(?<!b\.)\b(rrand_i|rrand|rand_i|rand|choose|dice|one_in|ring|knit|range|line|spread|chord|scale|chord_invert|note_range|note|tick|look)\s*\(/g,
    'b.$1('
  )

  // Bare rand / rand_i (no args, no parens) — Ruby treats as function call
  result = result.replace(/(?<!\.)(?<!b\.)\b(rand_i|rand)\b(?!\s*[.()\w])/g, 'b.$1()')

  // Standalone tick/look without parens (not as method: notes.tick)
  result = result.replace(/(?<!\.)(?<!b\.)\btick\b(?!\s*[.(])/g, 'b.tick()')
  result = result.replace(/(?<!\.)(?<!b\.)\blook\b(?!\s*[.(])/g, 'b.look()')

  // .tick → .tick() (method on ring)
  result = result.replace(/\.tick(?!\()/g, '.tick()')
  result = result.replace(/\.look(?!\()/g, '.look()')

  // .reverse, .shuffle, .choose → .reverse(), .shuffle(), .choose()
  result = result.replace(/\.reverse(?!\()/g, '.reverse()')
  result = result.replace(/\.shuffle(?!\()/g, '.shuffle()')
  result = result.replace(/\.choose(?!\()/g, '.choose()')

  // ring without parens: (ring 1, 2, 3) → (b.ring(1, 2, 3))
  result = result.replace(/(?<=\(|^)(ring|spread)\s+([^(].+?)(?=\)|$)/g, 'b.$1($2)')

  // Ruby block syntax: .map { |var| expr } → .map((var) => expr)
  // Note: tokenizer may insert spaces around pipes, so match `| var |` flexibly
  result = result.replace(/\.map\s*\{\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\}/g, '.map(($1) => $2)')
  result = result.replace(/\.select\s*\{\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\}/g, '.filter(($1) => $2)')
  result = result.replace(/\.reject\s*\{\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\}/g, '.filter(($1) => !($2))')
  result = result.replace(/\.collect\s*\{\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\}/g, '.map(($1) => $2)')

  return result
}

/** Transpile DSL calls with b. prefix (synchronous builder chain). */
function transpileSonicPiLine(line: string, insideLoop: boolean): string {
  const prefix = insideLoop ? 'b.' : ''
  // Apply b. prefix to all DSL calls in the line first
  line = addBuilderPrefixes(line, insideLoop)

  // Trailing if: `statement if condition`
  const trailingIf = line.match(/^(.+?)\s+if\s+(.+)$/)
  if (trailingIf) {
    const stmt = transpileSonicPiLine(trailingIf[1], insideLoop)
    return `if (${addBuilderPrefixes(trailingIf[2], insideLoop)}) { ${stmt} }`
  }

  // Trailing unless
  const trailingUnless = line.match(/^(.+?)\s+unless\s+(.+)$/)
  if (trailingUnless) {
    const stmt = transpileSonicPiLine(trailingUnless[1], insideLoop)
    return `if (!(${addBuilderPrefixes(trailingUnless[2], insideLoop)})) { ${stmt} }`
  }

  // synth :name, opts
  const synthCmdMatch = line.match(/^synth\s+"?(\w+)"?\s*,?\s*(.*)$/)
  if (synthCmdMatch) {
    const sName = synthCmdMatch[1]
    const rest = synthCmdMatch[2].trim()
    const args = rest ? transpileArgs(rest) : ''
    if (args && args.includes('{')) {
      return `${prefix}play(${args.replace('{', `{ synth: "${sName}", `)})`
    }
    return `${prefix}play(${args ? args + ', ' : ''}{ synth: "${sName}" })`
  }

  // bare synth name as command: beep note:67
  const SYNTH_NAMES_SET = new Set(['beep','saw','prophet','tb303','supersaw','pluck','pretty_bell','piano','dsaw','dpulse','dtri','fm','mod_fm','mod_saw','mod_pulse','mod_tri','sine','square','tri','pulse','noise','pnoise','bnoise','gnoise','cnoise','chipbass','chiplead','chipnoise','dark_ambience','hollow','growl','zawa','blade','tech_saws'])
  const bareSynth = line.match(/^(\w+)\s+(.+)$/)
  if (bareSynth && SYNTH_NAMES_SET.has(bareSynth[1])) {
    const sName = bareSynth[1]
    const args = transpileArgs(bareSynth[2])
    if (args.includes('{')) {
      return `${prefix}play(${args.replace('{', `{ synth: "${sName}", `)})`
    }
    return `${prefix}play(${args}, { synth: "${sName}" })`
  }

  // play
  const playMatch = line.match(/^play\s+(.+)$/)
  if (playMatch) return `${prefix}play(${transpileArgs(playMatch[1])})`

  // sleep
  const sleepMatch = line.match(/^sleep\s+(.+)$/)
  if (sleepMatch) return `${prefix}sleep(${sleepMatch[1]})`

  // sample
  const sampleMatch = line.match(/^sample\s+(.+)$/)
  if (sampleMatch) return `${prefix}sample(${transpileArgs(sampleMatch[1])})`

  // sync
  const syncMatch = line.match(/^sync\s+"(\w+)"$/)
  if (syncMatch) return `${prefix}sync("${syncMatch[1]}")`

  // cue
  const cueMatch = line.match(/^cue\s+"(\w+)"(.*)$/)
  if (cueMatch) return `${prefix}cue("${cueMatch[1]}"${cueMatch[2] ? `, ${cueMatch[2].trim()}` : ''})`

  // control
  const controlMatch = line.match(/^control\s+(\w+)\s*,\s*(.+)$/)
  if (controlMatch) return `${prefix}control(${controlMatch[1]}, ${transpileArgs(controlMatch[2])})`

  // use_synth
  const useSynthMatch = line.match(/^use_synth\s+"(\w+)"$/)
  if (useSynthMatch) return `${prefix}use_synth("${useSynthMatch[1]}")`

  // use_bpm
  const useBpmMatch = line.match(/^use_bpm\s+(.+)$/)
  if (useBpmMatch) return `${prefix}use_bpm(${useBpmMatch[1]})`

  // use_random_seed
  const useRandSeedMatch = line.match(/^use_random_seed\s+(.+)$/)
  if (useRandSeedMatch) return `${prefix}use_random_seed(${useRandSeedMatch[1]})`

  // live_audio
  const liveAudioMatch = line.match(/^live_audio\s+(.+)$/)
  if (liveAudioMatch) return `${prefix}live_audio(${transpileArgs(liveAudioMatch[1])})`

  // stop
  if (line === 'stop') return `${prefix}stop()`

  // stop_loop :name — top-level only (no b. prefix)
  const stopLoopMatch = line.match(/^stop_loop\s+(.+)$/)
  if (stopLoopMatch) return `stop_loop(${transpileArgs(stopLoopMatch[1])})`

  // puts / print
  const putsMatch = line.match(/^puts\s+(.+)$/)
  if (putsMatch) return `${prefix}puts(${putsMatch[1]})`
  const printMatch = line.match(/^print\s+(.+)$/)
  if (printMatch) return `${prefix}puts(${printMatch[1]})`

  // Variable assignment
  const assignMatch = line.match(/^(\w+)\s*=\s*(.+)$/)
  if (assignMatch) {
    const varName = assignMatch[1]
    const rhsRaw = assignMatch[2]
    const rhs = transpileSonicPiLine(rhsRaw, insideLoop)
    // play/sample return `this` for chaining — use lastRef for node control
    if (insideLoop && /^b\.(play|sample)\(/.test(rhs)) {
      return `${rhs}; const ${varName} = b.lastRef`
    }
    // Check if the RHS was transpiled (has b. prefix)
    if (rhs !== rhsRaw) {
      return `const ${varName} = ${rhs}`
    }
    return `const ${varName} = ${rhsRaw}`
  }

  return line
}

function transpileArgs(argsStr: string): string {
  const parts = splitByComma(argsStr)
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

  if (kwargs.length > 0) {
    return [...positional, `{ ${kwargs.join(', ')} }`].join(', ')
  }
  return positional.join(', ')
}

function splitByComma(str: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of str) {
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
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
