import { treeSitterTranspile, isTreeSitterReady } from './TreeSitterTranspiler'

/**
 * Transpiles Sonic Pi's Ruby DSL into JavaScript that runs on our engine.
 *
 * TreeSitter (WASM-based AST parser) is the sole transpiler.
 * This module provides the public API: autoTranspile / autoTranspileDetailed,
 * plus pre-processing (wrapBareCode, detectLanguage).
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
 *
 * Variable assignment uses bare assignment (no let/const) so the Sandbox
 * Proxy captures writes. This matches Ruby's mutable semantics.
 */

// ---------------------------------------------------------------------------
// Bare code wrapper — wraps top-level play/sleep/sample in implicit live_loop
// ---------------------------------------------------------------------------

/**
 * Wraps bare DSL calls (play, sleep, sample outside any live_loop) in an
 * implicit `live_loop :__run_once do ... stop ... end` block.
 *
 * This matches Sonic Pi's behavior where bare code runs once then stops.
 * Called before transpilation so the transpiler sees well-structured code.
 */
function wrapBareCode(code: string): string {
  const lines = code.split('\n')

  // Check if there are any live_loop blocks
  const hasLiveLoop = lines.some(l => /^\s*live_loop\s/.test(l))

  // Check for bare DSL calls outside any live_loop/define/with_fx block.
  // We track nesting: only flag code at depth 0 (not inside builder-owning blocks).
  let bareCheckDepth = 0
  let hasBareCode = false
  for (const l of lines) {
    const t = l.trim()
    // Count block openers — anything that has a matching `end`
    if (/^(live_loop|define|in_thread|with_fx|at|time_warp|density)\s/.test(t)) bareCheckDepth++
    else if (/\bdo\s*(\|.*\|)?\s*$/.test(t) && bareCheckDepth > 0) bareCheckDepth++
    else if (/^(if|unless|case|begin|loop|while|until|for)\s/.test(t) && bareCheckDepth > 0) bareCheckDepth++
    if (t === 'end' && bareCheckDepth > 0) bareCheckDepth--
    if (bareCheckDepth === 0) {
      // Bare DSL calls that need to be wrapped in an implicit live_loop so
      // the ProgramBuilder `__b` is in scope (use_synth_defaults, play_pattern_timed, etc.)
      if (/^\s*(play|sleep|sample|synth|control|cue|sync|play_chord|play_pattern|play_pattern_timed|use_synth_defaults|use_sample_defaults|use_transpose)\s/.test(l) ||
          /^\s*(\d+\.times\s+do|.*\.each\s+do)\s*/.test(l)) {
        hasBareCode = true
        break
      }
    }
  }

  if (!hasBareCode) return code
  if (hasLiveLoop) {
    // Mix of live_loops and bare code — wrap only the bare parts
    // For simplicity, wrap all bare DSL calls in a single live_loop
    const topLevel: string[] = [] // use_bpm, use_synth, etc.
    const bareCode: string[] = [] // play, sleep, sample
    const blocks: string[] = []   // live_loop blocks
    let inBlock: false | 'dsl' | 'bare' = false
    let blockDepth = 0

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        if (inBlock === 'dsl') blocks.push(line)
        else bareCode.push(line)
        continue
      }

      if (!inBlock && /^\s*(live_loop|define|in_thread|with_fx|at|time_warp|density)\s/.test(line)) {
        inBlock = 'dsl'
        blockDepth = 1
        blocks.push(line)
        continue
      }

      // loop do, N.times do, .each do at top level — track as bare block
      // so use_synth/use_bpm inside them are NOT hoisted
      if (!inBlock && (/^\s*loop\s+do\b/.test(line) || /\.(times|each)\s+do\b/.test(line))) {
        inBlock = 'bare'
        blockDepth = 1
        bareCode.push(line)
        continue
      }

      if (inBlock) {
        const target = inBlock === 'dsl' ? blocks : bareCode
        target.push(line)
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

      // Top-level settings (only at depth 0)
      if (/^\s*(use_bpm|use_synth|use_random_seed|use_arg_bpm_scaling|use_sample_bpm)\s/.test(line)) {
        topLevel.push(line)
        continue
      }

      // Bare DSL code
      bareCode.push(line)
    }

    const hasActualBare = bareCode.some(l => /^\s*(play|sleep|sample|synth|control|cue|sync|play_chord|play_pattern|play_pattern_timed|use_synth_defaults|use_sample_defaults|use_transpose)\s/.test(l))
    if (!hasActualBare) return code

    return [
      ...topLevel,
      '',
      'live_loop :__run_once do',
      ...bareCode.map(l => '  ' + l),
      '  stop',
      'end',
      '',
      ...blocks,
    ].join('\n')
  }

  // No live_loops at all — wrap in a one-shot live_loop with stop
  // Only hoist use_synth/use_bpm/etc. that are at depth 0 (not inside blocks)
  const topLevel: string[] = []
  const body: string[] = []
  let hoistDepth = 0

  for (const line of lines) {
    const trimmed = line.trim()
    // Track block depth for hoisting decisions
    if (/^(in_thread|with_fx|at|time_warp|density|define)\s/.test(trimmed)) hoistDepth++
    else if (/\bdo\s*(\|.*\|)?\s*$/.test(trimmed) && hoistDepth > 0) hoistDepth++
    else if (/^(if|unless|case|begin|loop|while|until|for)\s/.test(trimmed) && hoistDepth > 0) hoistDepth++
    if (trimmed === 'end' && hoistDepth > 0) hoistDepth--

    if (hoistDepth === 0 && /^\s*(use_bpm|use_synth|use_random_seed|use_arg_bpm_scaling|use_sample_bpm)\s/.test(line)) {
      topLevel.push(line)
    } else {
      body.push(line)
    }
  }

  return [
    ...topLevel,
    '',
    'live_loop :__run_once do',
    ...body.map(l => '  ' + l),
    '  stop',
    'end',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result of autoTranspile — includes fallback metadata for callers. */
export interface TranspileResult {
  code: string
  usedFallback: boolean
  fallbackReason?: string
  method?: 'tree-sitter'
}

/**
 * Auto-detect language and transpile if needed.
 * Returns the transpiled JS code string (backward compatible).
 */
export function autoTranspile(code: string): string {
  return autoTranspileDetailed(code).code
}

/**
 * Auto-detect language and transpile if needed, with detailed metadata.
 *
 * TreeSitter is the sole transpiler — WASM must be initialized before
 * calling this (browser: SonicPiEngine.init(), tests: setupFiles).
 */
export function autoTranspileDetailed(code: string): TranspileResult {
  if (detectLanguage(code) === 'js') return { code, usedFallback: false }

  // Wrap bare code in implicit live_loop BEFORE transpilation
  code = wrapBareCode(code)

  if (!isTreeSitterReady()) {
    throw new Error('[SonicPi] TreeSitter parser not available — the audio engine may still be loading. Try clicking Run again.')
  }

  const tsResult = treeSitterTranspile(code)
  if (tsResult.errors.length > 0) {
    return { code: code, usedFallback: true, fallbackReason: tsResult.errors.join('; '), method: 'tree-sitter' }
  }

  try {
    new Function(tsResult.code)
  } catch (e) {
    return { code: tsResult.code, usedFallback: true, fallbackReason: `TreeSitter produced invalid JS: ${e}`, method: 'tree-sitter' }
  }

  return { code: tsResult.code, usedFallback: false, method: 'tree-sitter' }
}
