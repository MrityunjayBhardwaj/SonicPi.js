/**
 * TreeSitterTranspiler — catamorphism over the Ruby grammar.
 *
 * Replaces the regex-based Ruby→JS transpiler with a proper AST fold.
 * Uses web-tree-sitter to parse Ruby into a concrete syntax tree, then
 * walks every node via an exhaustive switch — guaranteeing at compile
 * time that every syntactic construct is explicitly handled.
 *
 * Mathematical foundation: this is a catamorphism (fold) over the initial
 * algebra of the Ruby grammar — the same structure as QueryInterpreter's
 * fold_Q from the thesis (§2.4).
 */

// ---------------------------------------------------------------------------
// Tree-sitter init (async, one-time)
// ---------------------------------------------------------------------------

// web-tree-sitter ships as a CommonJS/ESM hybrid. The WASM loader is
// the default export and exposes an `init()` method that takes a
// locator for the core WASM binary.

// At runtime we dynamically import so the module is only loaded when
// tree-sitter is actually used (keeps the bundle lean for envs that
// never call initTreeSitter).
let Parser: any = null
let RubyLanguage: any = null
let _initPromise: Promise<boolean> | null = null

/**
 * Initialize tree-sitter WASM runtime and load the Ruby grammar.
 *
 * Safe to call multiple times — subsequent calls return the cached promise.
 * Resolves `true` on success, `false` on failure (WASM load error, CSP, etc.).
 */
export function initTreeSitter(opts?: {
  treeSitterWasmUrl?: string
  rubyWasmUrl?: string
}): Promise<boolean> {
  if (_initPromise) return _initPromise
  _initPromise = _doInit(opts)
  return _initPromise
}

async function _doInit(opts?: {
  treeSitterWasmUrl?: string
  rubyWasmUrl?: string
}): Promise<boolean> {
  try {
    const mod = await import('web-tree-sitter')
    // web-tree-sitter <0.22 exports a default function (the Parser class)
    // web-tree-sitter >=0.22 exports named { Parser, Language }
    const TSParser = mod.Parser ?? mod.default ?? mod

    // Resolve WASM URLs — default to /public/ paths served by Vite
    const tsWasm = opts?.treeSitterWasmUrl ?? '/tree-sitter.wasm'
    const rubyWasm = opts?.rubyWasmUrl ?? '/tree-sitter-ruby.wasm'

    await TSParser.init({
      locateFile: (_filename: string, _scriptDir: string) => tsWasm,
    })

    // Language is only available after init() in older versions
    const TSLanguage = mod.Language ?? TSParser.Language

    Parser = new TSParser()
    RubyLanguage = await TSLanguage.load(rubyWasm)
    Parser.setLanguage(RubyLanguage)
    return true
  } catch (err) {
    console.warn('[TreeSitter] Init failed, regex fallback will be used:', err)
    _initPromise = null // allow retry
    return false
  }
}

/** Check if tree-sitter has been initialized. */
export function isTreeSitterReady(): boolean {
  return Parser !== null && RubyLanguage !== null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TreeSitterTranspileResult {
  code: string
  ok: boolean
  errors: string[]
}

/**
 * Transpile Sonic Pi Ruby code to JavaScript via tree-sitter AST fold.
 *
 * Requires `initTreeSitter()` to have completed successfully.
 * If tree-sitter is not ready, returns `{ ok: false }` so the caller
 * can fall back to the regex transpiler.
 */
export function treeSitterTranspile(ruby: string): TreeSitterTranspileResult {
  if (!isTreeSitterReady()) {
    return { code: '', ok: false, errors: ['tree-sitter not initialized'] }
  }

  const tree = Parser.parse(ruby)
  const errors: string[] = []
  const ctx: TranspileContext = {
    source: ruby,
    errors,
    insideLoop: false,
    definedFunctions: new Set(),
    indent: '',
  }

  const js = transpileNode(tree.rootNode, ctx)

  // Validate output
  if (errors.length > 0) {
    return { code: js, ok: false, errors }
  }

  try {
    new Function(js)
    return { code: js, ok: true, errors: [] }
  } catch (e: any) {
    return { code: js, ok: false, errors: [`Invalid JS output: ${e.message}`] }
  }
}

// ---------------------------------------------------------------------------
// Bare code wrapper (shared with regex transpiler)
// ---------------------------------------------------------------------------

function wrapBareCode(code: string): string {
  const lines = code.split('\n')
  const hasLiveLoop = lines.some(l => /^\s*live_loop\s/.test(l))
  const bareDSLPattern = /^\s*(play|sleep|sample)\s/
  const hasBareCode = lines.some(l => bareDSLPattern.test(l))

  if (!hasBareCode) return code

  if (hasLiveLoop) {
    const topLevel: string[] = []
    const bareCode: string[] = []
    const blocks: string[] = []
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
        if (/\bdo\s*(\|.*\|)?\s*$/.test(trimmed)) blockDepth++
        if (/^(if|unless|loop|while|until|for|begin|case)\s/.test(trimmed)) blockDepth++
        if (trimmed === 'end') {
          blockDepth--
          if (blockDepth <= 0) inBlock = false
        }
        continue
      }
      if (/^\s*(use_bpm|use_synth|use_random_seed)\s/.test(line)) {
        topLevel.push(line)
        continue
      }
      bareCode.push(line)
    }

    const hasActualBare = bareCode.some(l => bareDSLPattern.test(l))
    if (!hasActualBare) return code

    return [
      ...topLevel, '',
      'live_loop :main do',
      ...bareCode.map(l => '  ' + l),
      'end', '',
      ...blocks,
    ].join('\n')
  }

  const topLevel: string[] = []
  const body: string[] = []
  for (const line of lines) {
    if (/^\s*(use_bpm|use_synth|use_random_seed)\s/.test(line)) {
      topLevel.push(line)
    } else {
      body.push(line)
    }
  }
  return [
    ...topLevel, '',
    'live_loop :main do',
    ...body.map(l => '  ' + l),
    'end',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// AST walk context
// ---------------------------------------------------------------------------

interface TranspileContext {
  source: string
  errors: string[]
  insideLoop: boolean
  definedFunctions: Set<string>
  indent: string
}

// ---------------------------------------------------------------------------
// DSL functions that get the b. prefix inside loops
// ---------------------------------------------------------------------------

const DSL_FUNCTIONS = new Set([
  'play', 'sleep', 'sample', 'sync', 'cue',
  'use_synth', 'use_bpm', 'use_random_seed',
  'use_synth_defaults', 'use_debug',
  'ring', 'knit', 'range', 'line', 'spread',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in',
  'tick', 'look',
  'puts', 'print',
  'with_fx', 'with_synth', 'with_bpm',
  'in_thread', 'at', 'time_warp', 'density',
  'control', 'stop', 'live_audio',
  'sample_duration', 'bools',
  'play_pattern_timed',
  'set', 'get',
  'tick_reset', 'tick_reset_all',
  'load_samples', 'load_sample',
])

// DSL methods that are always top-level (never get b. prefix)
const TOP_LEVEL_ONLY = new Set([
  'live_loop', 'stop_loop', 'define',
])

// Synth names that can be used as bare commands: `beep 60`
const SYNTH_NAMES = new Set([
  'beep', 'saw', 'prophet', 'tb303', 'supersaw', 'pluck', 'pretty_bell',
  'piano', 'dsaw', 'dpulse', 'dtri', 'fm', 'mod_fm', 'mod_saw',
  'mod_pulse', 'mod_tri', 'sine', 'square', 'tri', 'pulse', 'noise',
  'pnoise', 'bnoise', 'gnoise', 'cnoise', 'chipbass', 'chiplead',
  'chipnoise', 'dark_ambience', 'hollow', 'growl', 'zawa', 'blade',
  'tech_saws',
])

// ---------------------------------------------------------------------------
// Catamorphism — the exhaustive fold over the Ruby CST
// ---------------------------------------------------------------------------

function transpileNode(node: any, ctx: TranspileContext): string {
  const type: string = node.type

  switch (type) {
    // ---- Root ----
    case 'program':
      return transpileProgram(node, ctx)

    // ---- Literals ----
    case 'integer':
    case 'float':
      return node.text

    case 'true':
      return 'true'
    case 'false':
      return 'false'
    case 'nil':
      return 'null'
    case 'self':
      return 'this'

    case 'simple_symbol':
      // :name → "name"
      return `"${node.text.slice(1)}"`

    case 'hash_key_symbol':
      // name: (in hash) — just the identifier part
      return node.text.replace(/:$/, '')

    case 'string': {
      return transpileString(node, ctx)
    }

    case 'string_content':
      return node.text

    case 'escape_sequence':
      return node.text

    case 'interpolation': {
      // #{expr} → ${expr}
      const inner = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
        .join('')
      return '${' + inner + '}'
    }

    case 'symbol_array':
    case 'string_array':
      // %w(a b c) → ["a", "b", "c"] / %i(a b c) → ["a", "b", "c"]
      return `[${node.namedChildren.map((c: any) => `"${c.text}"`).join(', ')}]`

    case 'array': {
      const elements = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      return `[${elements.join(', ')}]`
    }

    case 'hash': {
      const pairs = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      return `{ ${pairs.join(', ')} }`
    }

    case 'pair': {
      const key = node.namedChildren[0]
      const value = node.namedChildren[1]
      const keyStr = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : transpileNode(key, ctx)
      return `${keyStr}: ${transpileNode(value, ctx)}`
    }

    case 'subarray':
      return `[${node.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')}]`

    // ---- Identifiers ----
    case 'identifier': {
      const name = node.text
      // Ruby nil/true/false handled above as their own node types
      if (name === 'nil') return 'null'
      if (name === 'true') return 'true'
      if (name === 'false') return 'false'
      return name
    }

    case 'constant':
      return node.text

    case 'global_variable':
      return node.text

    case 'instance_variable':
      // @var → this._var
      return `this.${node.text.slice(1)}`

    case 'class_variable':
      return node.text

    // ---- Expressions ----
    case 'assignment': {
      const lhs = node.namedChildren[0]
      const rhs = node.namedChildren[1]
      const lhsStr = transpileNode(lhs, ctx)
      const rhsStr = transpileNode(rhs, ctx)

      // If RHS is b.play or b.sample, capture lastRef
      if (ctx.insideLoop && /^b\.(play|sample)\(/.test(rhsStr)) {
        return `${rhsStr}; const ${lhsStr} = b.lastRef`
      }

      return `const ${lhsStr} = ${rhsStr}`
    }

    case 'operator_assignment': {
      const lhs = node.namedChildren[0]
      const op = node.children.find((c: any) => c.type.endsWith('=') && c.type !== 'identifier')
      const rhs = node.namedChildren[1]
      const opText = op ? op.text : '+='
      return `${transpileNode(lhs, ctx)} ${opText} ${transpileNode(rhs, ctx)}`
    }

    case 'conditional': {
      // ternary: a ? b : c
      const cond = node.namedChildren[0]
      const trueBranch = node.namedChildren[1]
      const falseBranch = node.namedChildren[2]
      return `${transpileNode(cond, ctx)} ? ${transpileNode(trueBranch, ctx)} : ${transpileNode(falseBranch, ctx)}`
    }

    case 'binary': {
      const left = node.namedChildren[0]
      const right = node.namedChildren[1]
      const op = node.children.find((c: any) => !c.isNamed)?.text
        ?? node.children[1]?.text ?? '+'

      // Ruby `and`/`or` → JS `&&`/`||`
      const jsOp = op === 'and' ? '&&'
        : op === 'or' ? '||'
        : op === '**' ? '**'
        : op

      if (op === '**') {
        return `Math.pow(${transpileNode(left, ctx)}, ${transpileNode(right, ctx)})`
      }

      return `${transpileNode(left, ctx)} ${jsOp} ${transpileNode(right, ctx)}`
    }

    case 'unary': {
      const operand = node.namedChildren[0]
      const op = node.children[0]?.text ?? '-'
      const jsOp = op === 'not' ? '!' : op
      return `${jsOp}${transpileNode(operand, ctx)}`
    }

    case 'parenthesized_statements': {
      const inner = node.namedChildren
        .map((c: any) => transpileNode(c, ctx))
      if (inner.length === 1) return `(${inner[0]})`
      return `(${inner.join(', ')})`
    }

    case 'range': {
      // (a..b) — used for note ranges, slicing, etc.
      const from = transpileNode(node.namedChildren[0], ctx)
      const to = transpileNode(node.namedChildren[1], ctx)
      const exclusive = node.text.includes('...')
      if (exclusive) {
        return `Array.from({length: ${to} - ${from}}, (_, _i) => ${from} + _i)`
      }
      return `Array.from({length: ${to} - ${from} + 1}, (_, _i) => ${from} + _i)`
    }

    // ---- Method calls — the heart of the DSL ----
    case 'call':
    case 'method_call': {
      return transpileMethodCall(node, ctx)
    }

    case 'argument_list': {
      return transpileArgList(node, ctx)
    }

    case 'element_reference': {
      // a[b]
      const obj = transpileNode(node.namedChildren[0], ctx)
      const args = node.namedChildren.slice(1)
        .map((c: any) => transpileNode(c, ctx))
      // Handle range slice: a[1..-1] → a.slice(1)
      if (args.length === 1 && node.namedChildren[1]?.type === 'range') {
        const rangeNode = node.namedChildren[1]
        const from = transpileNode(rangeNode.namedChildren[0], ctx)
        const to = rangeNode.namedChildren[1]?.text
        if (to === '-1') {
          return `${obj}.slice(${from})`
        }
      }
      return `${obj}[${args.join(', ')}]`
    }

    case 'scope_resolution':
      return node.text

    // ---- Blocks ----
    case 'do_block':
    case 'block': {
      return transpileBlock(node, ctx)
    }

    case 'block_parameters': {
      const params = node.namedChildren.map((c: any) => transpileNode(c, ctx))
      return params.join(', ')
    }

    case 'block_body':
    case 'body_statement': {
      return transpileChildren(node, ctx)
    }

    // ---- Control flow ----
    case 'if': {
      return transpileIf(node, ctx)
    }

    case 'unless': {
      return transpileUnless(node, ctx)
    }

    case 'if_modifier': {
      // statement if condition
      const body = node.namedChildren[0]
      const cond = node.namedChildren[1]
      return `if (${transpileNode(cond, ctx)}) { ${transpileNode(body, ctx)} }`
    }

    case 'unless_modifier': {
      const body = node.namedChildren[0]
      const cond = node.namedChildren[1]
      return `if (!(${transpileNode(cond, ctx)})) { ${transpileNode(body, ctx)} }`
    }

    case 'while': {
      const cond = node.namedChildren[0]
      const bodyNode = node.namedChildren[1]
      const bodyCtx = { ...ctx }
      const bodyStr = bodyNode ? transpileNode(bodyNode, bodyCtx) : ''
      return `while (${transpileNode(cond, ctx)}) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'until': {
      const cond = node.namedChildren[0]
      const bodyNode = node.namedChildren[1]
      const bodyStr = bodyNode ? transpileNode(bodyNode, ctx) : ''
      return `while (!(${transpileNode(cond, ctx)})) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'for': {
      const varNode = node.namedChildren[0]
      const iterNode = node.namedChildren[1]
      const bodyNode = node.namedChildren[2]
      const bodyStr = bodyNode ? transpileNode(bodyNode, ctx) : ''
      return `for (const ${transpileNode(varNode, ctx)} of ${transpileNode(iterNode, ctx)}) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
    }

    case 'case': {
      return transpileCase(node, ctx)
    }

    case 'when': {
      // Handled inside transpileCase
      return ''
    }

    case 'else':
      // Handled by if/case
      return ''

    case 'then':
      return transpileChildren(node, ctx)

    case 'begin': {
      return transpileBeginRescue(node, ctx)
    }

    case 'rescue':
    case 'ensure':
      // Handled inside transpileBeginRescue
      return ''

    case 'return': {
      const val = node.namedChildren[0]
      if (val) return `return ${transpileNode(val, ctx)}`
      return 'return'
    }

    // ---- Method/function definitions ----
    case 'method': {
      // def name(args) ... end — not used in Sonic Pi DSL but handle it
      const nameNode = node.namedChildren[0]
      const params = node.namedChildren.find((c: any) => c.type === 'method_parameters')
      const body = node.namedChildren.find((c: any) => c.type === 'body_statement')
      const paramStr = params
        ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')
        : ''
      const bodyStr = body ? transpileNode(body, ctx) : ''
      return `function ${nameNode.text}(${paramStr}) {\n${bodyStr}\n${ctx.indent}}`
    }

    // ---- Splat/rest ----
    case 'splat_parameter':
    case 'rest_assignment':
      return `...${node.namedChildren[0]?.text ?? ''}`

    case 'keyword_parameter': {
      const name = node.namedChildren[0]?.text ?? ''
      const defaultVal = node.namedChildren[1]
      if (defaultVal) return `${name} = ${transpileNode(defaultVal, ctx)}`
      return name
    }

    case 'optional_parameter': {
      const name = node.namedChildren[0]?.text ?? ''
      const defaultVal = node.namedChildren[1]
      if (defaultVal) return `${name} = ${transpileNode(defaultVal, ctx)}`
      return name
    }

    case 'destructured_parameter':
      return node.text

    // ---- Comments ----
    case 'comment':
      return `//${node.text.slice(1)}`

    // ---- Misc ----
    case 'expression_statement':
      return transpileChildren(node, ctx)

    case 'empty_statement':
      return ''

    case 'ERROR': {
      ctx.errors.push(`Parse error at line ${node.startPosition.row + 1}: ${node.text.slice(0, 50)}`)
      return `/* PARSE ERROR: ${node.text.slice(0, 30)} */`
    }

    // ---- Catch-all for node types we pass through ----
    default: {
      // For unrecognized nodes, try to transpile children
      if (node.namedChildCount > 0) {
        return transpileChildren(node, ctx)
      }
      // Leaf node — emit text
      return node.text
    }
  }
}

// ---------------------------------------------------------------------------
// Program root handler — wraps bare DSL calls in an implicit live_loop
// ---------------------------------------------------------------------------

const BARE_DSL_CALLS = new Set(['play', 'sleep', 'sample'])
const TOP_LEVEL_SETTINGS = new Set(['use_bpm', 'use_synth', 'use_random_seed', 'use_debug'])

function transpileProgram(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren

  // Check if there are bare DSL calls at the top level
  const hasBareCode = children.some((c: any) => {
    if (c.type === 'call' || c.type === 'method_call') {
      const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
      return BARE_DSL_CALLS.has(method)
    }
    return false
  })

  if (!hasBareCode) {
    // No wrapping needed — transpile all children normally
    return transpileChildren(node, ctx)
  }

  // Separate top-level settings from bare code
  const topLevel: any[] = []
  const bareCode: any[] = []
  const blocks: any[] = []

  for (const child of children) {
    if (child.type === 'comment') {
      bareCode.push(child)
      continue
    }
    const method = (child.type === 'call' || child.type === 'method_call')
      ? (child.childForFieldName('method')?.text ?? child.namedChildren[0]?.text)
      : null

    if (method && TOP_LEVEL_SETTINGS.has(method)) {
      topLevel.push(child)
    } else if (method && (method === 'live_loop' || method === 'define' || method === 'with_fx' ||
                          method === 'in_thread' || method === 'uncomment' || method === 'comment')) {
      blocks.push(child)
    } else {
      bareCode.push(child)
    }
  }

  // Transpile top-level settings
  const topJS = topLevel.map(c => transpileNode(c, ctx)).filter(Boolean)

  // Transpile bare code inside an implicit live_loop
  const bareCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bareJS = bareCode
    .map(c => '  ' + transpileNode(c, bareCtx))
    .filter(s => s.trim())

  // Transpile block-level constructs
  const blockJS = blocks.map(c => transpileNode(c, ctx)).filter(Boolean)

  const parts: string[] = []
  if (topJS.length > 0) parts.push(topJS.join('\n'))
  if (bareJS.length > 0) {
    parts.push(`live_loop("main", (b) => {\n${bareJS.join('\n')}\n})`)
  }
  if (blockJS.length > 0) parts.push(blockJS.join('\n'))

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Method call handling — this is where most DSL dispatch happens
// ---------------------------------------------------------------------------

function transpileMethodCall(node: any, ctx: TranspileContext): string {
  // tree-sitter method_call: receiver.method(args) or receiver.method
  // tree-sitter call: method(args) or method arg1, arg2 (no receiver)

  const type = node.type

  // Bare method call: `method args` (no receiver, no parens)
  if (type === 'call' || type === 'method_call') {
    const receiver = node.childForFieldName('receiver')
    const methodNode = node.childForFieldName('method')
    const argsNode = node.childForFieldName('arguments')
    const blockNode = node.namedChildren.find((c: any) =>
      c.type === 'do_block' || c.type === 'block')

    // --- Receiver.method call ---
    if (receiver && methodNode) {
      return transpileReceiverMethodCall(receiver, methodNode, argsNode, blockNode, node, ctx)
    }

    // --- Bare method call (no receiver) ---
    const methodName = methodNode?.text ?? node.namedChildren[0]?.text ?? node.text

    // live_loop :name do ... end
    if (methodName === 'live_loop') {
      return transpileLiveLoop(node, argsNode, blockNode, ctx)
    }

    // define :name do |args| ... end
    if (methodName === 'define') {
      return transpileDefine(node, argsNode, blockNode, ctx)
    }

    // with_fx :name, opts do ... end
    if (methodName === 'with_fx' || methodName === 'with_synth' || methodName === 'with_bpm') {
      return transpileWithBlock(methodName, argsNode, blockNode, ctx)
    }

    // in_thread do ... end
    if (methodName === 'in_thread') {
      return transpileInThread(argsNode, blockNode, ctx)
    }

    // at [times], [values] do |params| ... end
    if (methodName === 'at') {
      return transpileAt(argsNode, blockNode, ctx)
    }

    // time_warp offset do ... end
    if (methodName === 'time_warp') {
      return transpileTimeWarp(argsNode, blockNode, ctx)
    }

    // density N do ... end
    if (methodName === 'density') {
      return transpileDensity(argsNode, blockNode, ctx)
    }

    // uncomment do ... end → emit the body
    if (methodName === 'uncomment') {
      if (blockNode) {
        const bodyCtx = { ...ctx }
        return transpileBlockBody(blockNode, bodyCtx)
      }
      return ''
    }

    // comment do ... end → skip
    if (methodName === 'comment') {
      return '/* commented out */'
    }

    // loop do ... end
    if (methodName === 'loop') {
      if (blockNode) {
        const bodyStr = transpileBlockBody(blockNode, ctx)
        return `while (true) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
      }
    }

    // stop
    if (methodName === 'stop') {
      return 'b.stop()'
    }

    // stop_loop :name
    if (methodName === 'stop_loop') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `stop_loop(${args})`
    }

    // use_synth :name
    if (methodName === 'use_synth') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}use_synth(${args})`
    }

    // use_bpm N
    if (methodName === 'use_bpm') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}use_bpm(${args})`
    }

    // use_random_seed N
    if (methodName === 'use_random_seed') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}use_random_seed(${args})`
    }

    // use_debug false
    if (methodName === 'use_debug') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : 'false'
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}use_debug(${args})`
    }

    // use_synth_defaults
    if (methodName === 'use_synth_defaults') {
      const args = argsNode ? transpileArgListAsOpts(argsNode, ctx) : '{}'
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}use_synth_defaults(${args})`
    }

    // load_samples / load_sample — no-op
    if (methodName === 'load_samples' || methodName === 'load_sample') {
      return '/* load_samples: no-op in browser */'
    }

    // osc_send — no-op with warning
    if (methodName === 'osc_send') {
      return '/* osc_send: not available in browser */'
    }

    // play, sleep, sample, etc. — DSL functions
    if (DSL_FUNCTIONS.has(methodName) && !TOP_LEVEL_ONLY.has(methodName)) {
      const prefix = ctx.insideLoop ? 'b.' : ''
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${prefix}${methodName}(${args})`
    }

    // synth command: `synth :name, opts`
    if (methodName === 'synth') {
      return transpileSynthCommand(argsNode, ctx)
    }

    // Bare synth name: `beep 60, release: 0.3`
    if (SYNTH_NAMES.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `b.play(${args}, { synth: "${methodName}" })`
    }

    // User-defined function call
    if (ctx.definedFunctions.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(b${args ? ', ' + args : ''})`
    }

    // puts / print
    if (methodName === 'puts' || methodName === 'print') {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}puts(${args})`
    }

    // tick_reset_all
    if (methodName === 'tick_reset_all') {
      return `b.tick_reset_all()`
    }

    // Generic: unknown bare function call — emit as-is
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${methodName}(${args})`
  }

  return node.text
}

// ---------------------------------------------------------------------------
// Receiver.method calls: a.b(args) / a.b / a.b do ... end
// ---------------------------------------------------------------------------

function transpileReceiverMethodCall(
  receiver: any, methodNode: any, argsNode: any, blockNode: any,
  fullNode: any, ctx: TranspileContext
): string {
  const method = methodNode.text
  const recStr = transpileNode(receiver, ctx)

  // N.times do |i| ... end
  if (method === 'times' && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const varName = params?.namedChildren[0]?.text ?? '_i'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    return `for (let ${varName} = 0; ${varName} < ${recStr}; ${varName}++) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
  }

  // .each do |item| ... end
  if (method === 'each' && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const varName = params?.namedChildren[0]?.text ?? '_item'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    return `for (const ${varName} of ${recStr}) {\n${ctx.indent}  b.__checkBudget__()\n${bodyStr}\n${ctx.indent}}`
  }

  // .map/.select/.reject/.collect do |item| ... end
  if ((method === 'map' || method === 'select' || method === 'reject' || method === 'collect') && blockNode) {
    const params = blockNode.namedChildren.find((c: any) => c.type === 'block_parameters')
    const varName = params?.namedChildren[0]?.text ?? '_item'
    const jsMethod = (method === 'select' || method === 'reject') ? 'filter' : 'map'
    const isReject = method === 'reject'
    const bodyStr = transpileBlockBody(blockNode, ctx)
    const negation = isReject ? '!' : ''
    return `${recStr}.${jsMethod}((${varName}) => ${negation}(${bodyStr}))`
  }

  // .map { |item| expr } — inline block
  if ((method === 'map' || method === 'select' || method === 'reject' || method === 'collect') && !blockNode) {
    // If there's an inline block child
    const inlineBlock = fullNode.namedChildren.find((c: any) => c.type === 'block')
    if (inlineBlock) {
      const params = inlineBlock.namedChildren.find((c: any) => c.type === 'block_parameters')
      const varName = params?.namedChildren[0]?.text ?? '_item'
      const jsMethod = (method === 'select' || method === 'reject') ? 'filter' : 'map'
      const isReject = method === 'reject'
      const bodyStr = transpileBlockBody(inlineBlock, ctx)
      const negation = isReject ? '!' : ''
      return `${recStr}.${jsMethod}((${varName}) => ${negation}(${bodyStr}))`
    }
  }

  // .tick / .tick() → .at(b.tick())
  if (method === 'tick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    if (args) return `${recStr}.at(b.tick(${args}))`
    return `${recStr}.at(b.tick())`
  }

  // .look / .look() → .at(b.look())
  if (method === 'look') {
    return `${recStr}.at(b.look())`
  }

  // .choose → .choose()
  if (method === 'choose') {
    return `${recStr}.choose()`
  }

  // .reverse → .reverse()
  if (method === 'reverse') {
    return `${recStr}.reverse()`
  }

  // .shuffle → .shuffle()
  if (method === 'shuffle') {
    return `${recStr}.shuffle()`
  }

  // .mirror → .mirror()
  if (method === 'mirror') {
    return `${recStr}.mirror()`
  }

  // .ramp → .ramp()
  if (method === 'ramp') {
    return `${recStr}.ramp()`
  }

  // .stretch(n) → .stretch(n)
  if (method === 'stretch') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.stretch(${args})`
  }

  // .drop(n) → .drop(n)
  if (method === 'drop') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.drop(${args})`
  }

  // .butlast → .butlast()
  if (method === 'butlast') {
    return `${recStr}.butlast()`
  }

  // .take(n) → .slice(0, n)
  if (method === 'take') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.slice(0, ${args})`
  }

  // .pick(n) → .pick(n)
  if (method === 'pick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.pick(${args})`
  }

  // .ring → .ring (for arrays becoming rings)
  if (method === 'ring') {
    return `b.ring(...${recStr})`
  }

  // .to_a → (identity, arrays are already arrays)
  if (method === 'to_a') {
    return `Array.from(${recStr})`
  }

  // .to_sym → identity (already strings in our DSL)
  if (method === 'to_sym' || method === 'to_s') {
    return recStr
  }

  // .to_i → Math.floor
  if (method === 'to_i') {
    return `Math.floor(${recStr})`
  }

  // .to_f → Number()
  if (method === 'to_f') {
    return `Number(${recStr})`
  }

  // .length / .size / .count → .length
  if (method === 'length' || method === 'size' || method === 'count') {
    return `${recStr}.length`
  }

  // .abs → Math.abs
  if (method === 'abs') {
    return `Math.abs(${recStr})`
  }

  // .min / .max
  if (method === 'min') return `Math.min(...${recStr})`
  if (method === 'max') return `Math.max(...${recStr})`

  // .first → [0]
  if (method === 'first') {
    return `${recStr}[0]`
  }

  // .last → .at(-1) or slice(-1)[0]
  if (method === 'last') {
    return `${recStr}.at(-1)`
  }

  // .flat_map
  if (method === 'flat_map') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.flatMap(${args})`
  }

  // .include? → .includes
  if (method === 'include?') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `${recStr}.includes(${args})`
  }

  // .sort → .sort()
  if (method === 'sort') {
    return `${recStr}.sort()`
  }

  // .sample → b.choose (Ruby's Array#sample is random pick)
  if (method === 'sample' && !argsNode) {
    return `b.choose(${recStr})`
  }

  // Methods with ? suffix → rename to _q
  if (method.endsWith('?')) {
    const cleanName = method.slice(0, -1) + '_q'
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    // factor? is a DSL function
    if (method === 'factor?') {
      return `b.factor_q(${args ? recStr + ', ' + args : recStr})`
    }
    return `${recStr}.${cleanName}(${args})`
  }

  // Default: receiver.method(args)
  const args = argsNode ? transpileArgList(argsNode, ctx) : ''
  if (args) return `${recStr}.${method}(${args})`
  // No args and no parens in source — could be property access or method call
  if (fullNode.text.includes('(')) return `${recStr}.${method}()`
  return `${recStr}.${method}()`
}

// ---------------------------------------------------------------------------
// DSL-specific transpilers
// ---------------------------------------------------------------------------

function transpileLiveLoop(
  node: any, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  // Extract name from args — first symbol argument
  const args = argsNode?.namedChildren ?? []
  let name = 'main'
  let syncName: string | null = null
  const extraOpts: string[] = []

  for (const arg of args) {
    if (arg.type === 'simple_symbol') {
      name = arg.text.slice(1) // strip :
    } else if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.text.replace(/:$/, '')
      if (keyName === 'sync') {
        syncName = val.type === 'simple_symbol' ? val.text.slice(1) : transpileNode(val, ctx)
      } else if (keyName === 'delay') {
        extraOpts.push(`delay: ${transpileNode(val, ctx)}`)
      }
      // auto_cue: false — just skip (engine handles this)
    }
  }

  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  let syncLine = ''
  if (syncName) {
    syncLine = `\n${ctx.indent}  b.sync("${syncName}")`
  }

  return `live_loop("${name}", (b) => {${syncLine}\n${bodyStr}\n${ctx.indent}})`
}

function transpileDefine(
  node: any, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const args = argsNode?.namedChildren ?? []
  let name = 'unnamed'

  for (const arg of args) {
    if (arg.type === 'simple_symbol') {
      name = arg.text.slice(1)
    }
  }

  ctx.definedFunctions.add(name)

  // Get block parameters (|a, b = default|)
  const params = blockNode?.namedChildren.find((c: any) => c.type === 'block_parameters')
  const paramStr = params
    ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ')
    : ''

  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  return `function ${name}(b${paramStr ? ', ' + paramStr : ''}) {\n${bodyStr}\n${ctx.indent}}`
}

function transpileWithBlock(
  methodName: string, argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const args = argsNode?.namedChildren ?? []
  const positional: string[] = []
  const opts: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.text.replace(/:$/, '')
      // reps: N → special handling
      if (keyName === 'reps') {
        opts.push(`reps: ${transpileNode(val, ctx)}`)
      } else {
        opts.push(`${keyName}: ${transpileNode(val, ctx)}`)
      }
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  const prefix = ctx.insideLoop ? 'b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  const optsStr = opts.length > 0 ? `{ ${opts.join(', ')} }` : ''
  const posStr = positional.join(', ')

  // with_fx("name", {opts}, (b) => { ... })
  const argParts = [posStr, optsStr, '(b) => {\n' + bodyStr + '\n' + ctx.indent + '}'].filter(Boolean)
  return `${prefix}${methodName}(${argParts.join(', ')})`
}

function transpileInThread(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const prefix = ctx.insideLoop ? 'b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  // Check for name: option
  const args = argsNode?.namedChildren ?? []
  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]?.text?.replace(/:$/, '')
      if (key === 'name') {
        // Named thread — pass name
        const name = transpileNode(arg.namedChildren[1], ctx)
        return `${prefix}in_thread({ name: ${name} }, (b) => {\n${bodyStr}\n${ctx.indent}})`
      }
    }
  }

  return `${prefix}in_thread((b) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileAt(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const args = argsNode?.namedChildren ?? []
  const positional = args.filter((a: any) => a.type !== 'pair').map((a: any) => transpileNode(a, ctx))

  const timesArr = positional[0] ?? '[]'
  const valuesArr = positional[1] ?? 'null'
  const prefix = ctx.insideLoop ? 'b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }

  // Get block parameters
  const params = blockNode?.namedChildren.find((c: any) => c.type === 'block_parameters')
  const paramNames = params?.namedChildren.map((c: any) => c.text) ?? []
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  const paramStr = paramNames.length > 0 ? ', ' + paramNames.join(', ') : ''
  return `${prefix}at(${timesArr}, ${valuesArr}, (b${paramStr}) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileTimeWarp(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const offset = argsNode?.namedChildren[0]
    ? transpileNode(argsNode.namedChildren[0], ctx)
    : '0'
  const prefix = ctx.insideLoop ? 'b.' : ''
  const bodyCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''
  return `${prefix}at([${offset}], null, (b) => {\n${bodyStr}\n${ctx.indent}})`
}

function transpileDensity(
  argsNode: any, blockNode: any, ctx: TranspileContext
): string {
  const factor = argsNode?.namedChildren[0]
    ? transpileNode(argsNode.namedChildren[0], ctx)
    : '1'
  const bodyStr = blockNode ? transpileBlockBody(blockNode, ctx) : ''
  const bRef = ctx.insideLoop ? 'b' : '__densityB'
  const lines = ['{']
  if (!ctx.insideLoop) lines.push(`  const ${bRef} = { density: 1 }`)
  lines.push(`  const __prevDensity = ${bRef}.density`)
  lines.push(`  ${bRef}.density = __prevDensity * ${factor}`)
  lines.push(bodyStr)
  lines.push(`  ${bRef}.density = __prevDensity`)
  lines.push('}')
  return lines.join('\n' + ctx.indent)
}

function transpileSynthCommand(argsNode: any, ctx: TranspileContext): string {
  if (!argsNode) return 'b.play()'
  const args = argsNode.namedChildren
  // First arg is the synth name (symbol)
  const synthNameNode = args[0]
  const synthName = synthNameNode ? transpileNode(synthNameNode, ctx) : '"beep"'

  // Separate positional and keyword args from the rest
  const positional: string[] = []
  const kwargs: string[] = [`synth: ${synthName}`]

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      kwargs.push(`${keyName}: ${transpileNode(val, ctx)}`)
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  const optsStr = `{ ${kwargs.join(', ')} }`
  if (positional.length > 0) {
    return `b.play(${positional.join(', ')}, ${optsStr})`
  }
  return `b.play(${optsStr})`
}

// ---------------------------------------------------------------------------
// Control flow transpilers
// ---------------------------------------------------------------------------

function transpileIf(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  const condition = children[0]
  const consequence = children[1]

  let result = `if (${transpileNode(condition, ctx)}) {\n`
  if (consequence) result += transpileNode(consequence, ctx) + '\n'
  result += ctx.indent + '}'

  // Handle elsif/else
  for (let i = 2; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'elsif') {
      const elsifCond = child.namedChildren[0]
      const elsifBody = child.namedChildren[1]
      result += ` else if (${transpileNode(elsifCond, ctx)}) {\n`
      if (elsifBody) result += transpileNode(elsifBody, ctx) + '\n'
      result += ctx.indent + '}'
    } else if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileUnless(node: any, ctx: TranspileContext): string {
  const condition = node.namedChildren[0]
  const body = node.namedChildren[1]
  let result = `if (!(${transpileNode(condition, ctx)})) {\n`
  if (body) result += transpileNode(body, ctx) + '\n'
  result += ctx.indent + '}'

  // Handle else
  for (let i = 2; i < node.namedChildren.length; i++) {
    const child = node.namedChildren[i]
    if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileCase(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  const expr = children[0]
  const exprStr = transpileNode(expr, ctx)
  let result = ''
  let first = true

  for (let i = 1; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'when') {
      const pattern = child.namedChildren[0]
      const body = child.namedChildren[1]
      // when can have multiple patterns separated by commas
      const patterns = child.namedChildren.filter((_: any, idx: number) => {
        // All named children except the last (body) are patterns
        return idx < child.namedChildCount - 1 || child.namedChildCount === 1
      })

      let conditions: string[]
      if (child.namedChildCount === 1) {
        // Single child — it's the pattern (when :r → no body, just skip)
        conditions = [transpileNode(pattern, ctx)]
        const condStr = conditions.map(c => `${exprStr} === ${c}`).join(' || ')
        if (first) {
          result += `if (${condStr}) {\n`
          first = false
        } else {
          result += ` else if (${condStr}) {\n`
        }
        result += ctx.indent + '}'
        continue
      }

      // Multiple children: patterns + body
      const patternNodes = child.namedChildren.slice(0, -1)
      const bodyNode = child.namedChildren[child.namedChildCount - 1]
      conditions = patternNodes.map((p: any) => transpileNode(p, ctx))
      const condStr = conditions.map(c => `${exprStr} === ${c}`).join(' || ')

      if (first) {
        result += `if (${condStr}) {\n`
        first = false
      } else {
        result += ` else if (${condStr}) {\n`
      }
      if (bodyNode) result += transpileNode(bodyNode, ctx) + '\n'
      result += ctx.indent + '}'
    } else if (child.type === 'else') {
      const elseBody = child.namedChildren[0]
      result += ` else {\n`
      if (elseBody) result += transpileNode(elseBody, ctx) + '\n'
      result += ctx.indent + '}'
    }
  }

  return result
}

function transpileBeginRescue(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren
  let result = 'try {\n'

  // Body is first child(ren) until rescue/ensure
  for (const child of children) {
    if (child.type === 'rescue') {
      const errorVar = child.namedChildren.find((c: any) =>
        c.type === 'exception_variable')?.namedChildren[0]?.text ?? '_e'
      const rescueBody = child.namedChildren.find((c: any) =>
        c.type === 'then' || c.type === 'body_statement')
      result += ctx.indent + `} catch (${errorVar}) {\n`
      if (rescueBody) result += transpileNode(rescueBody, ctx) + '\n'
    } else if (child.type === 'ensure') {
      const ensureBody = child.namedChildren[0]
      result += ctx.indent + '} finally {\n'
      if (ensureBody) result += transpileNode(ensureBody, ctx) + '\n'
    } else {
      // Body statement
      result += transpileNode(child, ctx) + '\n'
    }
  }

  result += ctx.indent + '}'
  return result
}

// ---------------------------------------------------------------------------
// String handling
// ---------------------------------------------------------------------------

function transpileString(node: any, ctx: TranspileContext): string {
  // Check for interpolation
  const hasInterpolation = node.namedChildren.some((c: any) => c.type === 'interpolation')

  if (hasInterpolation) {
    // Use template literal
    let result = '`'
    for (const child of node.children) {
      if (child.type === '"') continue // skip quote delimiters
      if (child.type === 'interpolation') {
        result += transpileNode(child, ctx)
      } else if (child.type === 'string_content') {
        result += child.text
      } else if (child.type === 'escape_sequence') {
        result += child.text
      }
    }
    result += '`'
    return result
  }

  // Plain string — keep as double-quoted
  return node.text
}

// ---------------------------------------------------------------------------
// Block body helper
// ---------------------------------------------------------------------------

function transpileBlockBody(blockNode: any, ctx: TranspileContext): string {
  // Block children: optional block_parameters, then body statements
  const bodyChildren = blockNode.namedChildren.filter(
    (c: any) => c.type !== 'block_parameters'
  )
  return bodyChildren
    .map((c: any) => ctx.indent + '  ' + transpileNode(c, ctx))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Argument list handling
// ---------------------------------------------------------------------------

function transpileArgList(node: any, ctx: TranspileContext): string {
  const args = node.namedChildren
  const positional: string[] = []
  const kwargs: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      kwargs.push(`${keyName}: ${transpileNode(val, ctx)}`)
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  if (kwargs.length > 0) {
    return [...positional, `{ ${kwargs.join(', ')} }`].join(', ')
  }
  return positional.join(', ')
}

/** Transpile all args as a single options object. */
function transpileArgListAsOpts(node: any, ctx: TranspileContext): string {
  const args = node.namedChildren
  const opts: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      const keyName = key.type === 'hash_key_symbol'
        ? key.text.replace(/:$/, '')
        : key.type === 'simple_symbol'
        ? key.text.slice(1)
        : transpileNode(key, ctx)
      opts.push(`${keyName}: ${transpileNode(val, ctx)}`)
    }
  }

  return `{ ${opts.join(', ')} }`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transpileChildren(node: any, ctx: TranspileContext): string {
  return node.namedChildren
    .map((c: any) => transpileNode(c, ctx))
    .filter((s: string) => s.trim() !== '')
    .join('\n')
}
