import { describe, it, expect } from 'vitest'
import { ProgramBuilder, InfiniteLoopError, DEFAULT_LOOP_BUDGET } from '../ProgramBuilder'
import { autoTranspile, autoTranspileDetailed } from '../RubyTranspiler'
import { note_range } from '../ChordScale'
import { range } from '../Ring'

describe('BudgetGuard — execution budget (Fix #1)', () => {
  it('__checkBudget__ throws InfiniteLoopError after budget exhaustion', () => {
    const b = new ProgramBuilder()
    // Exhaust the budget
    for (let i = 0; i < DEFAULT_LOOP_BUDGET - 1; i++) {
      b.__checkBudget__()
    }
    // The next call should throw
    expect(() => b.__checkBudget__()).toThrow(InfiniteLoopError)
    expect(() => b.__checkBudget__()).toThrow('Infinite loop detected')
  })

  it('sleep resets budget so loops with sleep run normally', () => {
    const b = new ProgramBuilder()
    // Use most of the budget
    for (let i = 0; i < DEFAULT_LOOP_BUDGET - 10; i++) {
      b.__checkBudget__()
    }
    // Sleep resets the counter
    b.sleep(1)
    // Now we should be able to iterate again
    for (let i = 0; i < DEFAULT_LOOP_BUDGET - 1; i++) {
      b.__checkBudget__()
    }
    // Only now should it throw
    expect(() => b.__checkBudget__()).toThrow(InfiniteLoopError)
  })

  it('transpiled loop do injects __checkBudget__', () => {
    const code = `
live_loop :test do
  loop do
    play 60
    sleep 1
  end
end`
    const result = autoTranspile(code)
    expect(result).toContain('__checkBudget__')
  })

  it('transpiled N.times loop injects __checkBudget__', () => {
    const code = `
live_loop :test do
  4.times do |i|
    play 60 + i
    sleep 0.25
  end
  sleep 1
end`
    const result = autoTranspile(code)
    expect(result).toContain('__checkBudget__')
  })

  it('transpiled .each loop injects __checkBudget__', () => {
    const code = `
live_loop :test do
  [60, 64, 67].each do |n|
    play n
    sleep 0.25
  end
  sleep 1
end`
    const result = autoTranspile(code)
    expect(result).toContain('__checkBudget__')
  })

  it('note_range with huge range is capped at 10000', () => {
    const notes = note_range(0, 200_000)
    expect(notes.length).toBeLessThanOrEqual(10_000)
  })

  it('range with degenerate step is capped at 10000', () => {
    // step of 0.001 would generate 1_000_000 items without guard
    const r = range(0, 1000, 0.001)
    expect(r.length).toBeLessThanOrEqual(10_000)
  })

  it('InfiniteLoopError has correct name property', () => {
    const err = new InfiniteLoopError()
    expect(err.name).toBe('InfiniteLoopError')
    expect(err.message).toBe('Infinite loop detected — did you forget a sleep?')
  })

  it('nested 200x200 loop (40000 iterations, no sleep) passes budget', () => {
    const b = new ProgramBuilder()
    // 200*200 = 40000 < DEFAULT_LOOP_BUDGET (100000)
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) {
        b.__checkBudget__()
      }
    }
    // Should not throw — 40000 iterations is within budget
  })

  it('nested 500x500 loop (250000 iterations, no sleep) throws InfiniteLoopError', () => {
    const b = new ProgramBuilder()
    expect(() => {
      for (let i = 0; i < 500; i++) {
        for (let j = 0; j < 500; j++) {
          b.__checkBudget__()
        }
      }
    }).toThrow(InfiniteLoopError)
  })
})
