/**
 * Transforms user code before execution:
 * - Adds `await` before play(), sleep(), sample(), sync() if missing
 * - Wraps code in an async function for execution
 * - Generates basic source mapping for error reporting
 */

/** Functions that should be awaited */
const AWAIT_FUNCTIONS = new Set([
  'play', 'sleep', 'sample', 'sync',
])

/**
 * Add `await` before DSL function calls that are missing it.
 *
 * Handles:
 *   play(60)          → await play(60)
 *   sample("bd_haus") → await sample("bd_haus")
 *   sleep(0.5)        → await sleep(0.5)
 *
 * Already-awaited calls are left unchanged.
 */
export function addMissingAwaits(code: string): string {
  // Match function calls that need await, but not if already preceded by "await"
  // Uses a regex approach — sufficient for the DSL's simple syntax
  const fnNames = [...AWAIT_FUNCTIONS].join('|')
  const pattern = new RegExp(
    // Negative lookbehind: not preceded by "await " or "await\n" or "function "
    `(?<!await\\s)(?<!\\.)\\b(${fnNames})\\s*\\(`,
    'g'
  )

  return code.replace(pattern, 'await $1(')
}

export interface TranspileResult {
  code: string
  lineOffset: number
}

/**
 * Transpile user code into an executable async function body.
 *
 * The returned code string is meant to be passed to `new Function(...)`.
 * DSL functions are provided as parameters to the generated function.
 */
export function transpile(userCode: string): TranspileResult {
  let code = addMissingAwaits(userCode)

  // The code runs inside an async function that receives DSL bindings.
  // Line offset = 0 because we use the code directly as the function body.
  return {
    code,
    lineOffset: 0,
  }
}

/**
 * Create an executable function from transpiled code.
 * DSL function names are passed as parameter names,
 * and their implementations are passed as arguments at call time.
 */
export function createExecutor(
  transpiledCode: string,
  dslParamNames: string[]
): (...args: unknown[]) => Promise<void> {
  // Wrap in async IIFE (async functions are always strict mode — no explicit directive needed)
  const asyncBody = `return (async () => {\n${transpiledCode}\n})();`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...dslParamNames, asyncBody)
  return fn as (...args: unknown[]) => Promise<void>
}
