import { describe, it, expect } from 'vitest'
import { createSandboxedExecutor, validateCode, BLOCKED_GLOBALS } from '../Sandbox'

describe('Sandbox', () => {
  it('blocks fetch in user code', async () => {
    const executor = createSandboxedExecutor(
      'if (typeof fetch !== "undefined") throw new Error("fetch should be blocked")',
      []
    )
    await expect(executor()).resolves.toBeUndefined()
  })

  it('blocks document in user code', async () => {
    const executor = createSandboxedExecutor(
      'if (typeof document !== "undefined") throw new Error("document should be blocked")',
      []
    )
    await expect(executor()).resolves.toBeUndefined()
  })

  it('blocks eval in user code', async () => {
    const executor = createSandboxedExecutor(
      'if (typeof eval !== "undefined") throw new Error("eval should be blocked")',
      []
    )
    await expect(executor()).resolves.toBeUndefined()
  })

  it('blocks setTimeout in user code', async () => {
    const executor = createSandboxedExecutor(
      'if (typeof setTimeout !== "undefined") throw new Error("setTimeout should be blocked")',
      []
    )
    await expect(executor()).resolves.toBeUndefined()
  })

  it('allows DSL functions to pass through', async () => {
    let called = false
    const executor = createSandboxedExecutor(
      'await myFunc()',
      ['myFunc']
    )
    await executor(async () => { called = true })
    expect(called).toBe(true)
  })

  it('blocks all listed globals', () => {
    expect(BLOCKED_GLOBALS).toContain('fetch')
    expect(BLOCKED_GLOBALS).toContain('document')
    expect(BLOCKED_GLOBALS).toContain('window')
    expect(BLOCKED_GLOBALS).toContain('localStorage')
    expect(BLOCKED_GLOBALS).toContain('XMLHttpRequest')
    expect(BLOCKED_GLOBALS).toContain('WebSocket')
    expect(BLOCKED_GLOBALS).toContain('globalThis')
    expect(BLOCKED_GLOBALS.length).toBeGreaterThanOrEqual(18)
  })

  it('validateCode warns about constructor access', () => {
    const warnings = validateCode('this.constructor.constructor("return this")()')
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('constructor')
  })

  it('validateCode returns no warnings for clean code', () => {
    const warnings = validateCode('await ctx.play(60)\nawait ctx.sleep(1)')
    expect(warnings).toHaveLength(0)
  })
})
