/**
 * TreeSitterTranspiler — partial fold over the Ruby CST.
 *
 * Replaces the regex-based Ruby→JS transpiler with a tree-sitter AST walk.
 * Uses web-tree-sitter to parse Ruby into a concrete syntax tree, then
 * walks named nodes via a switch — explicit handlers for ~60 semantically
 * meaningful node types, recursive traversal for structural wrappers,
 * and error flagging for unrecognized leaf nodes.
 *
 * Not a true catamorphism (which would require exhaustive coverage of all
 * ~150 named node types in the Ruby grammar). This is a partial fold over
 * the Sonic Pi subset, following the same pattern as Semgrep and ast-grep:
 * handle what matters, recurse through structure, flag the rest.
 *
 * Variable assignment uses bare assignment (no let/const) so the Sandbox
 * Proxy's set trap captures writes into scope-isolated storage — matching
 * Ruby's mutable variable semantics and Opal/CoffeeScript's approach.
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
  // Emscripten's abort() throws globally even when we catch the promise.
  // Install a temporary error suppressor so it doesn't leak to window.onerror.
  const isBrowser = typeof window !== 'undefined'
  let prevOnError: typeof window.onerror | null = null
  let rejectHandler: ((e: PromiseRejectionEvent) => void) | null = null
  if (isBrowser) {
    prevOnError = window.onerror
    window.onerror = (msg) => {
      if (typeof msg === 'string' && (msg.includes('Aborted') || msg.includes('_abort'))) {
        return true // suppress — we handle it via the promise rejection
      }
      return prevOnError ? (prevOnError as any)(...arguments) : false
    }
    // Also suppress unhandled promise rejections from Emscripten abort
    rejectHandler = (e: PromiseRejectionEvent) => {
      const reason = String(e.reason ?? '')
      if (reason.includes('Aborted') || reason.includes('_abort') || reason.includes('LinkError')) {
        e.preventDefault()
      }
    }
    window.addEventListener('unhandledrejection', rejectHandler)
  }

  try {
    const mod: any = await import('web-tree-sitter')
    // web-tree-sitter <0.22 exports a default function (the Parser class)
    // web-tree-sitter >=0.22 exports named { Parser, Language }
    const TSParser = mod.Parser ?? mod.default ?? mod

    // Resolve WASM URLs — default to /public/ paths served by Vite
    const tsWasm = opts?.treeSitterWasmUrl ?? '/tree-sitter.wasm'
    const rubyWasm = opts?.rubyWasmUrl ?? '/tree-sitter-ruby.wasm'

    // Race init with a 5-second timeout to avoid hanging in test environments
    const initWithTimeout = Promise.race([
      TSParser.init({
        locateFile: (_filename: string, _scriptDir: string) => tsWasm,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tree-sitter init timeout')), 5000)
      ),
    ])

    await initWithTimeout

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
  } finally {
    // Restore original error handlers
    if (isBrowser) {
      // Delay restore to catch any async Emscripten abort throws
      setTimeout(() => {
        window.onerror = prevOnError
        if (rejectHandler) window.removeEventListener('unhandledrejection', rejectHandler)
      }, 200)
    }
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

  // Pre-process: Sonic Pi uses /text/ as single-line comments (Ruby regex syntax
  // repurposed). TreeSitter's Ruby grammar may parse these as division depending
  // on context. Convert to # comments before parsing so TreeSitter sees clean Ruby.
  ruby = ruby.split('\n').map(line => {
    const trimmed = line.trim()
    if (/^\/[^/].*\/$/.test(trimmed) && !/[=~<>!]/.test(trimmed)) {
      return line.replace(trimmed, `# ${trimmed.slice(1, -1).trim()}`)
    }
    return line
  }).join('\n')

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
  const bareBlockPattern = /^\s*(\d+\.times\s+do|.*\.each\s+do|with_fx\s)/
  const hasBareCode = lines.some(l => bareDSLPattern.test(l) || bareBlockPattern.test(l))

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
      'live_loop :__run_once do',
      ...bareCode.map(l => '  ' + l),
      '  stop',
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
    'live_loop :__run_once do',
    ...body.map(l => '  ' + l),
    '  stop',
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
  /** Current node's source line (1-based) for _srcLine injection */
  srcLine?: number
}

// ---------------------------------------------------------------------------
// DSL functions — split by where they actually exist
// ---------------------------------------------------------------------------

/**
 * Functions that exist as methods on ProgramBuilder.
 * Inside a loop, these get the `b.` prefix.
 */
const BUILDER_METHODS = new Set([
  // Core
  'play', 'sleep', 'wait', 'sample', 'sync', 'cue', 'set',
  'use_synth', 'use_bpm', 'use_random_seed',
  'control', 'stop', 'live_audio',
  'with_fx', 'in_thread', 'at',
  'puts', 'print',
  // Random (resolved eagerly)
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in', 'rdist', 'rand_look',
  'shuffle', 'pick',
  // Tick
  'tick', 'look', 'tick_reset', 'tick_reset_all',
  // Transpose
  'use_transpose', 'with_transpose',
  // Synth defaults / BPM / synth blocks
  'use_synth_defaults', 'use_sample_defaults', 'with_bpm', 'with_synth',
  // Debug
  'use_debug',
  // BPM scaling control
  'use_arg_bpm_scaling', 'with_arg_bpm_scaling',
  // Utility
  'factor_q', 'bools', 'play_pattern_timed', 'sample_duration',
  'hz_to_midi', 'midi_to_hz', 'quantise', 'quantize', 'octs',
  'kill', 'play_chord', 'play_pattern',
  'with_octave', 'with_random_seed', 'with_density',
  'noteToMidi', 'midiToFreq', 'noteToFreq',
  // Data constructors
  'ring', 'knit', 'range', 'line', 'spread',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
  'chord_degree', 'degree', 'chord_names', 'scale_names',
  // Budget
  '__checkBudget__',
])

/**
 * Functions that exist ONLY in the top-level execution scope
 * (injected by SonicPiEngine.evaluate), NOT on ProgramBuilder.
 * Inside a loop, these must NOT get the `b.` prefix —
 * they're captured from the enclosing scope via the Proxy.
 */
const TOP_LEVEL_SCOPE = new Set([
  'live_loop', 'stop_loop', 'define',
  'use_bpm', 'use_synth', 'use_random_seed', 'use_arg_bpm_scaling',
  'in_thread', 'at', 'density',
  'with_fx', 'with_arg_bpm_scaling',
  // Global store
  'set', 'get',
  // Sample catalog
  'sample_duration', 'sample_names', 'sample_groups', 'sample_loaded',
  // Output
  'puts', 'print', 'stop',
  // Volume & introspection
  'set_volume', 'current_synth', 'current_volume',
  // Catalog queries
  'synth_names', 'fx_names', 'all_sample_names',
  // Sample management
  'load_sample', 'sample_info',
  // Math / music theory
  'hz_to_midi', 'midi_to_hz', 'quantise', 'quantize', 'octs',
  'chord_degree', 'degree', 'chord_names', 'scale_names',
  'current_bpm',
  // Data constructors (also on builder, but available at top level)
  'ring', 'knit', 'range', 'line', 'spread',
  'chord', 'scale', 'chord_invert', 'note', 'note_range',
])

/**
 * Functions that don't exist on ProgramBuilder and have no runtime equivalent.
 * Transpile without `b.` prefix — they're no-ops or produce clear errors.
 */
const UNIMPLEMENTED_DSL = new Set([
  'load_samples', 'load_sample',
])

/**
 * No-arg DSL functions that Ruby code calls without parentheses.
 * When a bare identifier matches one of these, emit it as a function call.
 * e.g., `tick` → `b.tick()`, `look` → `b.look()`, `stop` → `b.stop()`
 */
const BARE_CALLABLE = new Set([
  'tick', 'look', 'stop', 'tick_reset_all',
  'rand', 'rand_i',
  'chord_names', 'scale_names',
])

/**
 * Top-level no-arg functions that Ruby calls without parens.
 * These do NOT get the `b.` prefix — they're captured from enclosing scope.
 */
const BARE_CALLABLE_TOP_LEVEL = new Set([
  'current_bpm',
])

// Synth names that can be used as bare commands: `beep 60`
// Complete synth list — all 66 user-facing synths from Desktop SP synthinfo.rb
const SYNTH_NAMES = new Set([
  'beep', 'sine', 'saw', 'pulse', 'subpulse', 'square', 'tri',
  'dsaw', 'dpulse', 'dtri', 'fm', 'mod_fm', 'mod_saw', 'mod_dsaw',
  'mod_sine', 'mod_beep', 'mod_tri', 'mod_pulse',
  'supersaw', 'hoover', 'prophet', 'zawa', 'dark_ambience', 'growl',
  'hollow', 'blade', 'piano', 'pluck', 'pretty_bell', 'dull_bell',
  'tech_saws', 'winwood_lead', 'chipbass', 'chiplead', 'chipnoise',
  'tb303', 'bass_foundation', 'bass_highend',
  'organ_tonewheel', 'rhodey', 'rodeo', 'kalimba', 'singer',
  'dark_sea_horn', 'gabberkick',
  'noise', 'pnoise', 'bnoise', 'gnoise', 'cnoise',
  'sound_in', 'sound_in_stereo',
  'sc808_bassdrum', 'sc808_snare', 'sc808_clap',
  'sc808_tomlo', 'sc808_tommid', 'sc808_tomhi',
  'sc808_congalo', 'sc808_congamid', 'sc808_congahi',
  'sc808_rimshot', 'sc808_claves', 'sc808_maracas', 'sc808_cowbell',
  'sc808_closed_hihat', 'sc808_open_hihat', 'sc808_cymbal',
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

      // Only transform bare identifiers to calls in statement context
      const parentType = node.parent?.type
      const isStatement = parentType === 'body_statement' || parentType === 'program' ||
                          parentType === 'then' || parentType === 'block_body'

      // Bare identifier that matches a user-defined function → call it with b
      if (isStatement && ctx.definedFunctions.has(name)) {
        return `${name}(b)`
      }

      // Bare identifier that matches a known no-arg DSL function.
      // Ruby allows calling methods without parens: `tick` = `tick()`
      // This applies in any context (statement, argument, etc.)
      // because `tick`, `look`, `stop` are always function calls in Sonic Pi.
      if (BARE_CALLABLE.has(name)) {
        const prefix = ctx.insideLoop ? 'b.' : ''
        return `${prefix}${name}()`
      }

      // Top-level bare callables — no b. prefix, just append ()
      if (BARE_CALLABLE_TOP_LEVEL.has(name)) {
        return `${name}()`
      }

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
        return `${rhsStr}; ${lhsStr} = b.lastRef`
      }

      // Bare assignment (no let/const/var) — the Sandbox's Proxy `set` trap
      // captures it into scope-isolated storage. This matches Ruby semantics:
      // variables are mutable and re-assignable. Using `const` or `let` would
      // create a lexical binding invisible to the Proxy, breaking scope isolation.
      return `${lhsStr} = ${rhsStr}`
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

      const lhs = transpileNode(left, ctx)
      const rhs = transpileNode(right, ctx)

      // Sonic Pi operator helpers — handle note strings (:c3→48),
      // Ring arithmetic (ring*3→repeat, ring+ring→concat),
      // and note+array mapping (:c3+[0,7,11]→[48,55,59]).
      if (op === '+') return `__spAdd(${lhs}, ${rhs})`
      if (op === '-') return `__spSub(${lhs}, ${rhs})`
      if (op === '*') return `__spMul(${lhs}, ${rhs})`

      return `${lhs} ${jsOp} ${rhs}`
    }

    case 'unary': {
      const operand = node.namedChildren[0]
      const op = node.children[0]?.text ?? '-'
      // defined? x → typeof x !== 'undefined'
      if (op === 'defined?') return `(typeof ${transpileNode(operand, ctx)} !== 'undefined')`
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
      // Handle range slice: a[1..-1] → a.slice(1)
      if (node.namedChildren[1]?.type === 'range') {
        const rangeNode = node.namedChildren[1]
        const from = transpileNode(rangeNode.namedChildren[0], ctx)
        const toNode = rangeNode.namedChildren[1]
        const toStr = transpileNode(toNode, ctx)
        // Negative index: a[1..-1] → a.slice(1)
        if (toStr === '-1' || (toNode.type === 'unary' && toNode.namedChildren[0]?.text === '1')) {
          return `${obj}.slice(${from})`
        }
        // Other negative: a[0..-2] → a.slice(0, -1)
        if (toStr.startsWith('-')) {
          const absVal = parseInt(toStr.slice(1))
          return `${obj}.slice(${from}, ${-(absVal - 1) || undefined})`
        }
        return `${obj}.slice(${from}, ${toStr} + 1)`
      }
      const args = node.namedChildren.slice(1)
        .map((c: any) => transpileNode(c, ctx))
      return `${obj}[${args.join(', ')}]`
    }

    case 'scope_resolution':
      return node.text

    // ---- Blocks ----
    case 'do_block':
    case 'block': {
      return transpileBlockBody(node, ctx)
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

    // ---- Lambda ----
    case 'lambda': {
      // ->(x) { x * 2 } → (x) => { return x * 2 }
      const params = node.namedChildren.find((c: any) => c.type === 'lambda_parameters' || c.type === 'block_parameters')
      const body = node.namedChildren.find((c: any) => c.type === 'block' || c.type === 'do_block') ?? node.namedChildren[node.namedChildCount - 1]
      const paramStr = params ? params.namedChildren.map((c: any) => transpileNode(c, ctx)).join(', ') : ''
      const bodyStr = body ? transpileNode(body, ctx) : ''
      return `(${paramStr}) => { ${bodyStr} }`
    }

    // ---- Block argument (&:method → (x) => x.method()) ----
    case 'block_argument': {
      const inner = node.namedChildren[0]
      if (inner?.type === 'simple_symbol') {
        const method = inner.text.slice(1) // strip :
        return `(__x) => __x.${method}()`
      }
      return transpileNode(inner, ctx)
    }

    // ---- Multiple assignment: a, b = [1, 2] → [a, b] = [1, 2] ----
    case 'left_assignment_list': {
      const vars = node.namedChildren.map((c: any) => transpileNode(c, ctx))
      return `[${vars.join(', ')}]`
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

    // Sonic Pi uses /text/ as multi-line comments. Ruby's grammar parses
    // these as regex literals. Convert to JS comments.
    case 'regex':
      return `// ${node.text.slice(1, -1).trim()}`

    // ---- Misc ----
    case 'expression_statement':
      return transpileChildren(node, ctx)

    case 'empty_statement':
      return ''

    case 'ERROR': {
      ctx.errors.push(`Parse error at line ${node.startPosition.row + 1}: ${node.text.slice(0, 50)}`)
      return `/* PARSE ERROR: ${node.text.slice(0, 30)} */`
    }

    // ---- Structural wrapper nodes — recurse into children ----
    // These are CST nodes that exist for grouping but carry no semantic
    // content for transpilation (e.g., `then`, `body_statement` variants).
    // A partial fold over named nodes — handle semantically meaningful
    // types explicitly above, recurse through structural wrappers here.
    default: {
      if (node.namedChildCount > 0) {
        return transpileChildren(node, ctx)
      }
      // Leaf node we don't recognize — likely raw Ruby leaking through.
      // Don't silently emit it as JS; flag it so the caller can fall back.
      if (node.type !== 'empty_statement' && node.text.trim()) {
        ctx.errors.push(`Unhandled node type '${node.type}' at line ${node.startPosition.row + 1}: ${node.text.slice(0, 40)}`)
      }
      return node.text
    }
  }
}

// ---------------------------------------------------------------------------
// Program root handler — wraps bare DSL calls in an implicit live_loop
// ---------------------------------------------------------------------------

const BARE_DSL_CALLS = new Set([
  'play', 'sleep', 'sample', 'cue', 'sync',
  'puts', 'print', 'control', 'synth',
])
const TOP_LEVEL_SETTINGS = new Set(['use_bpm', 'use_synth', 'use_random_seed', 'use_debug'])

function transpileProgram(node: any, ctx: TranspileContext): string {
  const children = node.namedChildren

  // Check if there are bare DSL calls at the top level
  // Also detect .times do, .each do blocks, and bare with_fx (no live_loop inside)
  const hasBareCode = children.some((c: any) => {
    if (c.type === 'call' || c.type === 'method_call') {
      const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
      if (BARE_DSL_CALLS.has(method)) return true
      // .times do / .each do — method_call on a receiver
      if (method === 'times' || method === 'each') return true
    }
    return false
  })
  // Also check for bare with_fx that doesn't contain live_loops
  const hasBareFx = children.some((c: any) => {
    if (c.type !== 'call' && c.type !== 'method_call') return false
    const method = c.childForFieldName('method')?.text ?? c.namedChildren[0]?.text
    if (method !== 'with_fx') return false
    // Check if with_fx contains a live_loop — if so, it's a block, not bare
    const text = c.text ?? ''
    return !/live_loop/.test(text)
  })

  if (!hasBareCode && !hasBareFx) {
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

    // Bare with_fx (no live_loop inside) should be treated as bare code, not a block
    const isBareFxNode = method === 'with_fx' && !/live_loop/.test(child.text ?? '')

    if (method && TOP_LEVEL_SETTINGS.has(method)) {
      topLevel.push(child)
    } else if (method && !isBareFxNode && (method === 'live_loop' || method === 'define' || method === 'with_fx' ||
                          method === 'in_thread' || method === 'uncomment' || method === 'comment')) {
      blocks.push(child)
    } else {
      bareCode.push(child)
    }
  }

  // Transpile top-level settings
  const topJS = topLevel.map(c => transpileNode(c, ctx)).filter(Boolean)

  // Transpile bare code inside an implicit in_thread (runs once, not forever)
  // Desktop SP runs bare code once — thread terminates at end.
  const bareCtx: TranspileContext = { ...ctx, insideLoop: true }
  const bareJS = bareCode
    .map(c => '  ' + transpileNode(c, bareCtx))
    .filter(s => s.trim())

  // Transpile block-level constructs
  const blockJS = blocks.map(c => transpileNode(c, ctx)).filter(Boolean)

  const parts: string[] = []
  if (topJS.length > 0) parts.push(topJS.join('\n'))
  if (bareJS.length > 0) {
    parts.push(`live_loop("__run_once", (b) => {\n${bareJS.join('\n')}\n  b.stop()\n})`)
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
    // Strip Ruby bang (!) from method names: set_volume! → set_volume
    const rawMethodName = methodNode?.text ?? node.namedChildren[0]?.text ?? node.text
    const methodName = rawMethodName.endsWith('!') ? rawMethodName.slice(0, -1) : rawMethodName

    // live_loop :name do ... end
    if (methodName === 'live_loop') {
      return transpileLiveLoop(node, argsNode, blockNode, ctx)
    }

    // define :name do |args| ... end
    if (methodName === 'define') {
      return transpileDefine(node, argsNode, blockNode, ctx)
    }

    // with_fx :name, opts do ... end
    if (methodName === 'with_fx' || methodName === 'with_synth' || methodName === 'with_bpm' || methodName === 'with_transpose' || methodName === 'with_arg_bpm_scaling') {
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

    // loop do ... end  OR  loop { ... }
    if (methodName === 'loop') {
      const block = blockNode ?? node.namedChildren.find((c: any) => c.type === 'block')
      if (block) {
        const bodyStr = transpileBlockBody(block, ctx)
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

    // use_synth_defaults / use_sample_defaults — all args become a single opts object
    if (methodName === 'use_synth_defaults' || methodName === 'use_sample_defaults') {
      const args = argsNode ? transpileArgListAsOpts(argsNode, ctx) : '{}'
      const prefix = ctx.insideLoop ? 'b.' : ''
      return `${prefix}${methodName}(${args})`
    }

    // load_samples / load_sample — no-op
    if (methodName === 'load_samples' || methodName === 'load_sample') {
      return '/* load_samples: no-op in browser */'
    }

    // osc_send — no-op with warning
    if (methodName === 'osc_send') {
      return '/* osc_send: not available in browser */'
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

    // Methods ending with ? — rename to _q, with b. prefix (on ProgramBuilder)
    if (methodName.endsWith('?')) {
      const cleanName = methodName.slice(0, -1) + '_q'
      const prefix = ctx.insideLoop ? 'b.' : ''
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${prefix}${cleanName}(${args})`
    }

    // --- Dispatch by which set the function belongs to ---

    // Functions that exist on ProgramBuilder → b.method() inside loops
    if (BUILDER_METHODS.has(methodName)) {
      const prefix = ctx.insideLoop ? 'b.' : ''
      // Inject _srcLine for play/sample for friendly error source mapping
      const needsSrcLine = methodName === 'play' || methodName === 'sample'
      const nodeCtx = { ...ctx, srcLine: node.startPosition.row + 1 }
      const args = argsNode ? transpileArgList(argsNode, nodeCtx, needsSrcLine) : ''
      return `${prefix}${methodName}(${args})`
    }

    // Functions that exist only at top-level scope → never b. prefix
    // (captured from enclosing scope via the Proxy)
    if (TOP_LEVEL_SCOPE.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(${args})`
    }

    // Unimplemented DSL functions → emit without b. prefix
    // (will be undefined at runtime — clear error message)
    if (UNIMPLEMENTED_DSL.has(methodName)) {
      const args = argsNode ? transpileArgList(argsNode, ctx) : ''
      return `${methodName}(${args})`
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
  // Use optional chaining (?.) so undefined receivers (e.g. npat when no case matched) return undefined instead of crashing
  if (method === 'tick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    if (args) return `${recStr}?.at(b.tick(${args}))`
    return `${recStr}?.at(b.tick())`
  }

  // .look / .look() → .at(b.look())
  if (method === 'look') {
    return `${recStr}?.at(b.look())`
  }

  // .choose → b.choose(receiver) — works on both arrays and Rings
  if (method === 'choose') {
    return `b.choose(${recStr})`
  }

  // .reverse → .reverse()
  if (method === 'reverse') {
    return `${recStr}.reverse()`
  }

  // .shuffle → b.shuffle(receiver) — works on both arrays and Rings
  if (method === 'shuffle') {
    return `b.shuffle(${recStr})`
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

  // .pick(n) → b.pick(receiver, n)
  if (method === 'pick') {
    const args = argsNode ? transpileArgList(argsNode, ctx) : ''
    return `b.pick(${recStr}${args ? ', ' + args : ''})`
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

  // sync: option — pass as registration option (one-time sync before first iteration),
  // NOT as b.sync() inside the body (which would re-sync every iteration).
  const optsArg = syncName ? `{sync: "${syncName}"}, ` : ''

  return `live_loop("${name}", ${optsArg}(b) => {\n${bodyStr}\n${ctx.indent}})`
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

  // Inside a loop, the block body is inside ProgramBuilder context (insideLoop: true).
  // At top level, with_fx just wraps live_loops — the body stays at top-level context.
  // The engine's topLevelWithFx passes null to the callback, so `b` is not available.
  const bodyCtx: TranspileContext = ctx.insideLoop
    ? { ...ctx, insideLoop: true }
    : { ...ctx }  // keep insideLoop false — live_loops inside will set their own
  const bodyStr = blockNode ? transpileBlockBody(blockNode, bodyCtx) : ''

  const optsStr = opts.length > 0 ? `{ ${opts.join(', ')} }` : ''
  const posStr = positional.join(', ')

  // Check for block parameter: with_fx :reverb do |lv| → (b, lv) => { ... }
  const blockParams = blockNode?.namedChildren.find((c: any) => c.type === 'block_parameters')
  const fxParamName = blockParams?.namedChildren[0]?.text

  let callbackParams: string
  if (ctx.insideLoop) {
    // Inside loop: callback receives ProgramBuilder + optional FX ref
    callbackParams = fxParamName ? `(b, ${fxParamName})` : '(b)'
  } else {
    // Top level: engine passes null, we use _ to discard it
    callbackParams = fxParamName ? `(${fxParamName})` : '()'
  }

  const argParts = [posStr, optsStr, `${callbackParams} => {\n` + bodyStr + '\n' + ctx.indent + '}'].filter(Boolean)
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

      // Multiple children: patterns + body (filter out comment nodes)
      const patternNodes = child.namedChildren.slice(0, -1)
        .filter((p: any) => p.type !== 'comment')
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

function transpileArgList(node: any, ctx: TranspileContext, injectSrcLine = false): string {
  const args = node.namedChildren
  const positional: string[] = []
  const kwargs: string[] = []

  for (const arg of args) {
    if (arg.type === 'pair') {
      const key = arg.namedChildren[0]
      const val = arg.namedChildren[1]
      if (key.type === 'hash_key_symbol') {
        kwargs.push(`${key.text.replace(/:$/, '')}: ${transpileNode(val, ctx)}`)
      } else if (key.type === 'simple_symbol') {
        kwargs.push(`${key.text.slice(1)}: ${transpileNode(val, ctx)}`)
      } else {
        // Computed key: opt => value → [opt]: value
        // (opt.to_s+"_slide").to_sym => dt → [opt + "_slide"]: dt
        kwargs.push(`[${transpileNode(key, ctx)}]: ${transpileNode(val, ctx)}`)
      }
    } else {
      positional.push(transpileNode(arg, ctx))
    }
  }

  // Inject _srcLine for source mapping (play/sample calls)
  if (injectSrcLine && ctx.srcLine !== undefined) {
    kwargs.push(`_srcLine: ${ctx.srcLine}`)
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
