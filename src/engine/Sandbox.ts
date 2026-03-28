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
 *
 * Per-loop scope isolation: when __enterScope__(name) is called, variable
 * writes go to a per-scope storage Map. Reads check local scope first,
 * then fall through to DSL functions and safe globals. This prevents
 * live_loops from accidentally sharing user variables.
 */
/** Scope management handle returned alongside the executor. */
export interface ScopeHandle {
  enterScope(name: string): void
  exitScope(): void
}

/**
 * Create an isolated executor with scope management handle.
 * Returns `{ execute, scopeHandle }` for full control over per-loop scoping.
 */
export function createIsolatedExecutor(
  transpiledCode: string,
  dslParamNames: string[],
): { execute: (...args: unknown[]) => Promise<void>; scopeHandle: ScopeHandle } {
  // Build the scope object with DSL functions
  const scopeBase: Record<string, unknown> = {}

  // Pre-populate blocked globals as undefined
  for (const name of BLOCKED_GLOBALS) {
    scopeBase[name] = undefined
  }

  // Per-loop scope isolation state — stack-based to handle async interleaving
  const scopeStack: string[] = []
  const scopeLocals = new Map<string, Map<string, unknown>>()

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

        // Check per-loop local scope first (if inside a scope)
        const currentScopeName = scopeStack[scopeStack.length - 1] ?? null
        if (currentScopeName !== null) {
          const locals = scopeLocals.get(currentScopeName)
          if (locals && locals.has(prop)) return locals.get(prop)
        }

        // DSL function / top-level variable
        if (prop in target) return target[prop]
      }
      // Fall through to real global for everything else (Math, Array, etc.)
      return (globalThis as Record<string | symbol, unknown>)[prop]
    },
    set(target, prop, value) {
      if (typeof prop === 'string') {
        // Inside a scope: write to per-loop local storage
        const currentScopeName = scopeStack[scopeStack.length - 1] ?? null
        if (currentScopeName !== null) {
          let locals = scopeLocals.get(currentScopeName)
          if (!locals) {
            locals = new Map()
            scopeLocals.set(currentScopeName, locals)
          }
          locals.set(prop, value)
          return true
        }
      }
      // Outside any scope: write to shared scope (top-level code)
      target[prop as string] = value
      return true
    },
  })

  const scopeHandle: ScopeHandle = {
    enterScope(name: string) { scopeStack.push(name) },
    exitScope() { scopeStack.pop() },
  }

  // Wrap code in with(scope) block — this routes all lookups through the proxy
  // Note: `with` is forbidden in strict mode, so we do NOT use "use strict"
  const wrappedCode = `with(__scope__) { return (async () => {\n${transpiledCode}\n})(); }`

  try {
    const fn = new Function('__scope__', wrappedCode)
    const execute = (...dslArgs: unknown[]) => {
      // Populate scope with DSL values
      for (let i = 0; i < dslParamNames.length; i++) {
        scope[dslParamNames[i]] = dslArgs[i]
      }
      return fn(scope)
    }
    return { execute, scopeHandle }
  } catch {
    // Fallback: plain executor without sandbox
    console.warn('[SonicPi] Sandbox unavailable — running without global blocking')
    const asyncBody = `return (async () => {\n${transpiledCode}\n})();`
    const fn = new Function(...dslParamNames, asyncBody)
    return { execute: fn as (...args: unknown[]) => Promise<void>, scopeHandle }
  }
}

/**
 * Create a sandboxed executor. Returns just the execute function for backward
 * compatibility. Use `createIsolatedExecutor` for scope management.
 */
export function createSandboxedExecutor(
  transpiledCode: string,
  dslParamNames: string[],
): (...args: unknown[]) => Promise<void> {
  return createIsolatedExecutor(transpiledCode, dslParamNames).execute
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
