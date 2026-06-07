import { describe, it, expect } from 'vitest'
import {
  pathMatch,
  normalizeWritePath,
  normalizeReadPath,
  cuePathSegment,
  SYNC_PATH_ROOTS,
} from '../PathMatcher'

describe('PathMatcher — write/read normalisation (core.rb:64-99)', () => {
  it('symbol write namespaces by op root', () => {
    expect(normalizeWritePath('foo', 'set', true)).toBe('/set/foo')
    expect(normalizeWritePath('foo', 'cue', true)).toBe('/cue/foo')
    expect(normalizeWritePath('foo', 'live_loop', true)).toBe('/live_loop/foo')
  })

  it('string write uses cue root when relative, verbatim when absolute', () => {
    // core.rb:104 — non-symbol keys always take __cue_path with the default prefix.
    expect(normalizeWritePath('foo', 'set', false)).toBe('/cue/foo')
    expect(normalizeWritePath('/a/b', 'set', false)).toBe('/a/b')
  })

  it('symbol read globs across all three op roots', () => {
    expect(normalizeReadPath('foo', true)).toBe('/{cue,set,live_loop}/foo')
  })

  it('string read: absolute verbatim, relative under cue root', () => {
    expect(normalizeReadPath('/a/b', false)).toBe('/a/b')
    expect(normalizeReadPath('foo', false)).toBe('/cue/foo')
  })

  it('cuePathSegment sanitises glob metacharacters to underscore', () => {
    expect(cuePathSegment('a b')).toBe('a_b')
    expect(cuePathSegment('a*b?c')).toBe('a_b_c')
    expect(cuePathSegment('a/b')).toBe('a_b') // symbol is a single segment
  })

  it('SYNC_PATH_ROOTS is the canonical desktop order', () => {
    expect([...SYNC_PATH_ROOTS]).toEqual(['cue', 'set', 'live_loop'])
  })
})

describe('PathMatcher — the read-glob unifies set/cue/live_loop (GAP M headline)', () => {
  it('a symbol read matches a set, a cue, AND a live_loop write', () => {
    const reader = normalizeReadPath('foo', true) // /{cue,set,live_loop}/foo
    expect(pathMatch(reader, normalizeWritePath('foo', 'set', true))).toBe(true)
    expect(pathMatch(reader, normalizeWritePath('foo', 'cue', true))).toBe(true)
    expect(pathMatch(reader, normalizeWritePath('foo', 'live_loop', true))).toBe(true)
  })

  it('a symbol read does NOT match a different key', () => {
    const reader = normalizeReadPath('foo', true)
    expect(pathMatch(reader, normalizeWritePath('bar', 'set', true))).toBe(false)
  })

  it('a string read on /cue does NOT see a /set write (desktop is stricter)', () => {
    // get "foo" → /cue/foo, which must NOT match a set :foo → /set/foo.
    expect(pathMatch(normalizeReadPath('foo', false), normalizeWritePath('foo', 'set', true))).toBe(false)
  })
})

describe('PathMatcher — exact + leading/trailing slash optionality (event_history.rb:94)', () => {
  it('exact match', () => {
    expect(pathMatch('/a/b', '/a/b')).toBe(true)
    expect(pathMatch('/a/b', '/a/c')).toBe(false)
  })
  it('leading/trailing slash is optional on both sides', () => {
    expect(pathMatch('a/b', '/a/b')).toBe(true)
    expect(pathMatch('/a/b/', '/a/b')).toBe(true)
    expect(pathMatch('/a/b', 'a/b/')).toBe(true)
  })
})

describe('PathMatcher — glob vocabulary (event_history.rb:69-91)', () => {
  it('* matches within a single segment only', () => {
    expect(pathMatch('/a/*', '/a/foo')).toBe(true)
    expect(pathMatch('/a/*', '/a/')).toBe(true) // empty segment
    expect(pathMatch('/a/*', '/a/b/c')).toBe(false) // does not cross /
  })

  it('** matches across segments', () => {
    expect(pathMatch('/a/**/d', '/a/b/c/d')).toBe(true)
    expect(pathMatch('/a/**/d', '/a/x/d')).toBe(true)
    // Desktop's /**/ → /.*/ keeps the surrounding slashes, so the middle ** needs
    // at least one intermediate segment: /a/d (zero segments) does NOT match.
    expect(pathMatch('/a/**/d', '/a/d')).toBe(false)
    expect(pathMatch('/a/**', '/a/b/c')).toBe(true)
    expect(pathMatch('/**', '/anything/at/all')).toBe(true)
  })

  it('? matches exactly one character', () => {
    expect(pathMatch('/a/?oo', '/a/foo')).toBe(true)
    expect(pathMatch('/a/?oo', '/a/oo')).toBe(false)
  })

  it('{a,b} alternation', () => {
    expect(pathMatch('/{set,cue}/x', '/set/x')).toBe(true)
    expect(pathMatch('/{set,cue}/x', '/cue/x')).toBe(true)
    expect(pathMatch('/{set,cue}/x', '/live_loop/x')).toBe(false)
  })

  it('[a-g] char range and [!a-g] negation', () => {
    expect(pathMatch('/[a-g]oo', '/foo')).toBe(true)
    expect(pathMatch('/[a-g]oo', '/zoo')).toBe(false)
    expect(pathMatch('/[!a-g]oo', '/zoo')).toBe(true)
    expect(pathMatch('/[!a-g]oo', '/foo')).toBe(false)
  })

  it('regex metacharacters in literal segments are escaped, not interpreted', () => {
    expect(pathMatch('/a.b', '/a.b')).toBe(true)
    expect(pathMatch('/a.b', '/axb')).toBe(false) // '.' is literal, not "any char"
  })
})
