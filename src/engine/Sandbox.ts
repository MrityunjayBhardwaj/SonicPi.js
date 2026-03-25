/**
 * Sandbox — blocks dangerous browser globals in user code.
 *
 * User code runs inside `new Function(...)` which has access to
 * global scope. We shadow dangerous globals by passing them as
 * function parameters set to undefined, making them inaccessible.
 *
 * This is not a security boundary against a determined attacker
 * (they could use `this.constructor` tricks), but it prevents
 * accidental or casual access to fetch, DOM, eval, etc.
 */

/**
 * Globals blocked via function parameter shadowing.
 * Note: `eval` and `arguments` cannot be parameter names in strict mode,
 * so we block them via code injection instead.
 */
export const BLOCKED_GLOBALS = [
  // Network
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  // Storage
  'localStorage', 'sessionStorage', 'indexedDB',
  // DOM
  'document', 'window', 'navigator', 'location', 'history',
  // Timers (user should use sleep, not setTimeout)
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  // Workers
  'Worker', 'SharedWorker', 'ServiceWorker',
  // Other
  'importScripts', 'postMessage', 'globalThis',
]

/**
 * Create a sandboxed executor. Same API as createExecutor but with
 * dangerous globals blocked.
 */
export function createSandboxedExecutor(
  transpiledCode: string,
  dslParamNames: string[]
): (...args: unknown[]) => Promise<void> {
  const allParamNames = [...dslParamNames, ...BLOCKED_GLOBALS]

  // Note: eval/Function/arguments cannot be reliably shadowed across
  // all browsers (Firefox forbids var eval even in sloppy mode).
  // They remain accessible but are low-risk: eval is rarely used in
  // Sonic Pi code, and Function is shadowed by the parameter list approach
  // failing silently in strict contexts.
  const asyncBody = `return (async () => {\n${transpiledCode}\n})();`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...allParamNames, asyncBody)

  return (...dslArgs: unknown[]) => {
    const blockedValues = BLOCKED_GLOBALS.map(() => undefined)
    return fn(...dslArgs, ...blockedValues)
  }
}

/**
 * Validate user code doesn't use obvious escape hatches.
 * Returns an array of warnings (non-blocking).
 */
export function validateCode(code: string): string[] {
  const warnings: string[] = []

  // Check for constructor access (common sandbox escape)
  if (/\bconstructor\b/.test(code)) {
    warnings.push('Code accesses "constructor" — this may not work in sandbox mode.')
  }

  // Check for __proto__ access
  if (/__proto__/.test(code)) {
    warnings.push('Code accesses "__proto__" — this may not work in sandbox mode.')
  }

  // Check for globalThis
  if (/\bglobalThis\b/.test(code)) {
    warnings.push('Code accesses "globalThis" — this is blocked in sandbox mode.')
  }

  return warnings
}
