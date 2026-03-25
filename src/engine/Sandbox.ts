/**
 * Sandbox — blocks dangerous browser globals in user code.
 *
 * Strategy: create a frozen scope object with only DSL functions,
 * then execute user code via `new Function()` with a `with()` proxy
 * that intercepts all global lookups.
 *
 * Why not iframe/Worker: user code needs synchronous access to
 * the scheduler and AudioContext — can't serialize across boundaries.
 *
 * Why not parameter shadowing: Firefox + SES extensions reject
 * certain parameter names in strict mode.
 *
 * This approach: wraps user code in a `with(scope)` block where
 * `scope` is a Proxy that returns undefined for blocked globals.
 * Works in all browsers, no strict mode issues.
 */

/** Globals that are blocked in user code. */
export const BLOCKED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'localStorage', 'sessionStorage', 'indexedDB',
  'document', 'window', 'navigator', 'location', 'history',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'Worker', 'SharedWorker', 'ServiceWorker',
  'importScripts', 'postMessage', 'globalThis',
  'eval', 'Function',
]

const BLOCKED_SET = new Set(BLOCKED_GLOBALS)

/**
 * Create a sandboxed executor using a Proxy-based scope.
 *
 * The generated function uses `with(scope)` so all variable lookups
 * go through our proxy. The proxy returns undefined for blocked globals
 * and the real value for DSL functions.
 */
export function createSandboxedExecutor(
  transpiledCode: string,
  dslParamNames: string[],
  dslValues?: unknown[]
): (...args: unknown[]) => Promise<void> {
  // Build the scope object with DSL functions
  const scopeBase: Record<string, unknown> = {}

  // Pre-populate blocked globals as undefined
  for (const name of BLOCKED_GLOBALS) {
    scopeBase[name] = undefined
  }

  // Create a proxy that intercepts all property access
  const scope = new Proxy(scopeBase, {
    has() {
      // Tell `with()` that we handle ALL variables
      return true
    },
    get(target, prop) {
      if (typeof prop === 'string') {
        // Blocked global
        if (BLOCKED_SET.has(prop)) return undefined
        // DSL function
        if (prop in target) return target[prop]
      }
      // Fall through to real global for everything else (Math, Array, etc.)
      return (globalThis as Record<string | symbol, unknown>)[prop]
    },
    set(target, prop, value) {
      // Allow user variable assignments within the scope
      target[prop as string] = value
      return true
    },
  })

  // Wrap code in with(scope) block — this routes all lookups through the proxy
  // Note: `with` is forbidden in strict mode, so we do NOT use "use strict"
  const wrappedCode = `with(__scope__) { return (async () => {\n${transpiledCode}\n})(); }`

  try {
    const fn = new Function('__scope__', wrappedCode)
    return (...dslArgs: unknown[]) => {
      // Populate scope with DSL values
      for (let i = 0; i < dslParamNames.length; i++) {
        scope[dslParamNames[i]] = dslArgs[i]
      }
      return fn(scope)
    }
  } catch {
    // Fallback: plain executor without sandbox
    console.warn('[SonicPi] Sandbox unavailable — running without global blocking')
    const asyncBody = `return (async () => {\n${transpiledCode}\n})();`
    const fn = new Function(...dslParamNames, asyncBody)
    return fn as (...args: unknown[]) => Promise<void>
  }
}

/**
 * Validate user code doesn't use obvious escape hatches.
 */
export function validateCode(code: string): string[] {
  const warnings: string[] = []
  if (/\bconstructor\b/.test(code)) {
    warnings.push('Code accesses "constructor" — this may not work in sandbox mode.')
  }
  if (/__proto__/.test(code)) {
    warnings.push('Code accesses "__proto__" — this may not work in sandbox mode.')
  }
  return warnings
}
