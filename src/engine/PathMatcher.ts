/**
 * PathMatcher — desktop Sonic Pi's OSC-style Time State path glob, ported from
 * `EventMatcher` (`event_history.rb:52-120`) + the `__cue_path` / `__sync_path`
 * / `__cue_path_segment` normalisation (`core.rb:64-99`). GAP M, the `path`
 * field of the `CueEvent` 8-tuple (`cueevent.rb`).
 *
 * Desktop routes `set` / `cue` / `live_loop` / `get` / `sync` through ONE
 * coordination store keyed by hierarchical OSC paths, with an asymmetry that is
 * the whole point of the design (verified source-first, `core.rb:64-105`):
 *
 *  - WRITES namespace by operation. A SYMBOL key is rooted under the op:
 *      `set :foo`       → `/set/foo`
 *      `cue :foo`       → `/cue/foo`
 *      `live_loop :foo` → `/live_loop/foo`   (the per-iteration heartbeat)
 *    A STRING key always uses the `cue` root unless it is already absolute:
 *      `set "foo"`      → `/cue/foo`          (default prefix, core.rb:104 else-branch)
 *      `set "/a/b"`     → `/a/b`              (leading `/` ⇒ taken verbatim)
 *
 *  - READS glob across all three op roots. A SYMBOL key reads the union:
 *      `get :foo` / `sync :foo` → `/{cue,set,live_loop}/foo`
 *    so a `get :foo` sees a `set :foo` AND a `cue :foo`, and a `sync :foo` wakes
 *    on a `cue :foo` OR a `live_loop :foo` tick. A STRING key reads its own root:
 *      `get "foo"`  → `/cue/foo`
 *      `get "/a/b"` → `/a/b`                  (exact, no glob)
 *
 * The matcher itself (the reader path) supports the full OSC glob vocabulary,
 * matched against the concrete stored (writer) path (examples avoid the literal
 * `star-slash` sequence so this block comment does not self-terminate, SP101):
 *   double-star  across segments   `a · ** · d` matches `/a/b/c/d`
 *   single-star  within a segment  `/a/*` matches `/a/foo` but not `/a/b/c`
 *   `?`          one char          `/a/?oo` matches `/a/foo`
 *   `{a,b}`      alternation       `/{set,cue}/x`
 *   `[a-g]`      char range        `/[a-g]oo`
 *   `[!a-g]`     negated range
 *
 * NOTE on faithfulness: rather than literally replaying Ruby's
 * `Regexp.escape`-then-`gsub!` chain (whose escape set differs from JS), this
 * builds the regex directly to the SAME match SEMANTICS, token by token, and is
 * pinned by unit tests covering every glob form. Leading/trailing `/` are
 * optional on both sides exactly as desktop's `\A/?…/?\Z` anchor (`:94`).
 */

/** The three op-roots a symbol read globs across (`__sync_path`, core.rb:87). */
export const SYNC_PATH_ROOTS = ['cue', 'set', 'live_loop'] as const

/**
 * Sanitise one path segment — port of `__cue_path_segment` (core.rb:64-68):
 * whitespace and OSC-glob metacharacters become `_` so a user key can never
 * inject glob structure into a WRITE path. Note `/` is also replaced (a symbol
 * key is a single segment), unlike the string-key path which keeps `/`.
 */
export function cuePathSegment(s: string): string {
  return s.replace(/[\s#*,?/[\]{}]/g, '_')
}

/**
 * Normalise a WRITE key to its stored path — port of `__cue_path` (core.rb:70-83)
 * combined with the symbol branch of `__cueset` (core.rb:105-111).
 *
 * @param key    the user key (already a string; the caller converts symbols)
 * @param prefix the op root for a relative key (`'set'`, `'cue'`, `'live_loop'`)
 * @param isSymbol whether the original key was a Ruby symbol (rooted under the
 *   op) vs a string (only the `cue` root, and absolute strings verbatim)
 */
export function normalizeWritePath(key: string, prefix: string, isSymbol: boolean): string {
  if (isSymbol) {
    // Symbol: always `/{prefix}/{sanitised-segment}` (core.rb:106 → __cue_path(k, prefix)).
    return `/${prefix}/${cuePathSegment(key)}`
  }
  // String: absolute stays verbatim; relative uses the default `cue` root.
  // core.rb:73-79 sanitises everything except `/`, so segment structure is kept.
  const sanitised = key.replace(/[\s#*,?[\]{}]/g, '_')
  if (sanitised.startsWith('/')) return sanitised
  return `/cue/${sanitised}`
}

/**
 * Normalise a READ key to its matcher (glob) path — port of `__sync_path`
 * (core.rb:85-99).
 *
 *  - symbol → `/{cue,set,live_loop}/{sanitised}` (the union read glob)
 *  - string starting `/` → verbatim (exact path, may itself contain user globs)
 *  - string otherwise → `/cue/{string}`
 */
export function normalizeReadPath(key: string, isSymbol: boolean): string {
  if (isSymbol) {
    return `/{${SYNC_PATH_ROOTS.join(',')}}/${cuePathSegment(key)}`
  }
  const s = String(key)
  if (s.startsWith('/')) return s
  return `/cue/${s}`
}

/**
 * Compile a reader glob path into a RegExp with desktop's match semantics
 * (`EventMatcher#initialize`, event_history.rb:57-96). Leading/trailing `/` are
 * optional on the target via the `^/?…/?$` anchor.
 */
function compileGlob(pattern: string): RegExp {
  // Strip the single optional leading `/`; the anchor restores its optionality.
  let p = pattern.trim()
  if (p.startsWith('/')) p = p.slice(1)

  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` — cross-segment. Desktop maps `/**/` → `/.*/` and a trailing
        // `/**` → `/.*`; in both cases the `.*` may span `/`. A bare `**`
        // (no surrounding slashes) likewise becomes `.*`.
        out += '.*'
        i++ // consume the second '*'
      } else {
        // `*` — within a segment only.
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '.' // one char (event_history.rb:91)
    } else if (c === '{') {
      // `{a,b,c}` → `(a|b|c)` (event_history.rb:78). Literal chars inside are
      // escaped; `,` becomes `|`.
      const end = p.indexOf('}', i)
      if (end === -1) {
        out += '\\{' // unterminated — literal
      } else {
        const inner = p
          .slice(i + 1, end)
          .split(',')
          .map((alt) => escapeLiteral(alt))
          .join('|')
        out += `(${inner})`
        i = end
      }
    } else if (c === '[') {
      // `[a-g]` / `[!a-g]` char class (event_history.rb:81-84). `-` is kept as a
      // range operator; `!` at the front becomes `^`.
      const end = p.indexOf(']', i)
      if (end === -1) {
        out += '\\[' // unterminated — literal
      } else {
        let inner = p.slice(i + 1, end)
        if (inner.startsWith('!')) inner = '^' + inner.slice(1)
        out += `[${inner}]`
        i = end
      }
    } else {
      out += escapeLiteral(c)
    }
  }
  return new RegExp(`^/?${out}/?$`)
}

/** Escape a run of literal characters for use in a RegExp body. */
function escapeLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

const globCache = new Map<string, RegExp>()

/**
 * True iff the reader `pattern` (a normalised glob path) matches the concrete
 * stored `path`. Port of `EventMatcher#path_match` (event_history.rb:113-120),
 * value side excluded (that is the `val_matcher`, handled by EventHistory).
 *
 * Fast path: an exact, glob-free pattern is a string compare.
 */
export function pathMatch(pattern: string, path: string): boolean {
  if (pattern === path) return true
  if (!/[*?{[]/.test(pattern)) {
    // No glob tokens — only the optional leading/trailing `/` can differ.
    return stripSlashes(pattern) === stripSlashes(path)
  }
  let re = globCache.get(pattern)
  if (!re) {
    re = compileGlob(pattern)
    globCache.set(pattern, re)
  }
  return re.test(path)
}

/**
 * Symbol-erasure adaptation (the GAP M faithfulness boundary). Our transpiler
 * lowers BOTH `:foo` and `"foo"` to the same JS string `"foo"`
 * (TreeSitterTranspiler.ts:509) — Ruby symbol-ness does not survive to the
 * engine. Desktop's namespacing split keys on symbol-vs-string, which we cannot
 * observe. We use the distinction that DOES survive: a leading `/` marks an
 * explicit absolute path (string semantics); everything else is treated as a
 * symbol key (op-namespaced write + `/{cue,set,live_loop}/` union read).
 *
 * This is exact for the two cases users actually write — a bare `:foo` and an
 * absolute `"/a/b"` — and collapses only the rare relative-string `set "foo"`
 * into symbol behaviour (a documented, more-permissive divergence).
 */
export function toWritePath(key: string, op: string): string {
  return normalizeWritePath(key, op, !key.startsWith('/'))
}

/** Read-side companion of {@link toWritePath} (same leading-`/` heuristic). */
export function toReadPath(key: string): string {
  return normalizeReadPath(key, !key.startsWith('/'))
}

/** The literal prefix of the canonical symbol union read (`/{cue,set,live_loop}/`). */
const UNION_READ_PREFIX = `/{${SYNC_PATH_ROOTS.join(',')}}/`

/**
 * If `pattern` is the canonical symbol union read ({@link toReadPath} of a
 * symbol: `/{cue,set,live_loop}/SEG` with SEG one glob-free segment), return the
 * three exact keys it matches — `/cue/SEG`, `/set/SEG`, `/live_loop/SEG` — so a
 * caller can resolve them by direct lookup instead of scanning the whole store
 * (#498 task 2). Returns `null` for any general glob (`/a/*`), which keeps the
 * full scan.
 *
 * Safe because the brace glob compiles to `^/?(cue|set|live_loop)/SEG/?$`
 * ({@link compileGlob}) — segment-anchored, so those three literals are EXACTLY
 * its match set. The direct lookup is therefore identical to filtering the store
 * by {@link pathMatch}, just O(3) instead of O(keys).
 */
export function unionReadKeys(pattern: string): string[] | null {
  if (!pattern.startsWith(UNION_READ_PREFIX)) return null
  const seg = pattern.slice(UNION_READ_PREFIX.length)
  // SEG must be a single literal segment: no nested path, no residual glob token
  // (a genuine union SEG is cuePathSegment output, which strips all of these).
  if (seg.length === 0 || /[*?{}[\]/]/.test(seg)) return null
  return SYNC_PATH_ROOTS.map((root) => `/${root}/${seg}`)
}

function stripSlashes(s: string): string {
  let a = 0
  let b = s.length
  if (s[a] === '/') a++
  if (b > a && s[b - 1] === '/') b--
  return s.slice(a, b)
}
