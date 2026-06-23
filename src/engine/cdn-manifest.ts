/**
 * CDN Dependency Manifest
 *
 * All external dependencies loaded at runtime from CDN.
 * Versions are pinned for reproducibility and supply-chain safety.
 *
 * IMPORTANT: dynamic import() does not support Subresource Integrity (SRI)
 * attributes. There is no way to pass an `integrity` hash to the browser's
 * module loader for dynamically imported ESM. The fetch-then-blob-URL
 * workaround breaks CORS and CSP in many configurations.
 *
 * For maximum security in production, bundle these dependencies locally
 * instead of loading them from CDN.
 *
 * Package                       Version   CDN       Used in
 * ----------------------------  --------  --------  ---------
 * @codemirror/view              6.36.5    esm.sh    Editor.ts
 * @codemirror/state             6.5.2     esm.sh    Editor.ts
 * @codemirror/commands          6         esm.sh    Editor.ts
 * @codemirror/language          6.10.8    esm.sh    Editor.ts
 * @codemirror/autocomplete      6         esm.sh    Editor.ts
 * @lezer/highlight              1.2.1     esm.sh    Editor.ts
 * codemirror                    6.0.1     esm.sh    Editor.ts
 * supersonic-scsynth            0.57.0    unpkg     SuperSonicBridge.ts, App.ts, Preloader.ts
 * supersonic-scsynth-core       0.57.0    unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-samples    0.57.0    unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-synthdefs  0.57.0    unpkg     SuperSonicBridge.ts
 *
 * SV22 (Sonic Web invariant): the four supersonic-scsynth-* packages
 * MUST be pinned to the same version. The JS module's exported worker /
 * WASM URLs hard-reference the matching core/samples/synthdefs versions;
 * mixing versions produces silent failures (worker fails to load,
 * synthdef binary mismatches, etc.).
 *
 * Bumping the SuperSonic version: change the four `0.57.0` strings
 * everywhere (this file + SuperSonicBridge.ts:131,212,213,219 +
 * App.ts:958 + Preloader.ts:198), run the FX-parity sweep, then update.
 * Do NOT bump SuperSonic in isolation — re-run the full audio comparator
 * because each WASM bump can shift gain staging and FX behaviour.
 */

export const SUPERSONIC_VERSION = '0.57.0' as const

/**
 * Transpiler runtime (#604 / SV80). The engine auto-loads these so a bare
 * consumer needs zero wiring. tree-sitter wasm comes from the upstream npm
 * packages (already on the CDN); the Ruby grammar lives in `tree-sitter-wasms`.
 * Keep these pinned in lock-step with the `web-tree-sitter` / `tree-sitter-wasms`
 * dependency versions in package.json.
 */
export const WEB_TREE_SITTER_VERSION = '0.24.3' as const
export const TREE_SITTER_WASMS_VERSION = '0.1.13' as const

/**
 * The frozen PRNG table (EPIC #531 / SV69) is OUR asset, not a published npm
 * package. It is immutable by construction, so we serve it from the repo via
 * jsdelivr pinned to a commit SHA (immutable, cacheable forever). Bump only if
 * the frozen table itself is ever regenerated.
 *
 * Repo slug = `SonicWeb` (renamed from `SonicPiWeb` 2026-06-23, #613). This
 * string feeds a RUNTIME jsdelivr fetch, so it MUST track the live GitHub repo
 * name — a stale slug 404s the PRNG table = SP5 silent no-audio. GitHub does
 * permanently redirect the old `SonicPiWeb` slug, so the pin keeps resolving
 * either way; the slug is updated here for correctness (#612). The `@<SHA>` pin
 * is immutable and lives under the repo's history regardless of its name.
 */
export const RAND_STREAM_REPO = 'MrityunjayBhardwaj/SonicWeb' as const
export const RAND_STREAM_PIN = '68cf288' as const

/**
 * Default runtime URLs the engine loads itself when a consumer supplies no
 * override (#604 / SV80). This is the single source of truth for "where does
 * the engine fetch its runtime deps from by default" — App.ts, the docs player,
 * and the dashboards all inherit these instead of re-deriving the wiring.
 */
export const CDN_DEFAULTS = {
  /** SuperSonic (GPL scsynth WASM) ESM entry — dynamic-import()ed, never bundled. */
  superSonicModule: `https://unpkg.com/supersonic-scsynth@${SUPERSONIC_VERSION}`,
  /** tree-sitter core WASM runtime. */
  treeSitterWasm: `https://cdn.jsdelivr.net/npm/web-tree-sitter@${WEB_TREE_SITTER_VERSION}/tree-sitter.wasm`,
  /** Compiled Ruby grammar WASM. */
  rubyWasm: `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}/out/tree-sitter-ruby.wasm`,
  /** Frozen white-noise PRNG table (EPIC #531). The 4 distribution tables sit
   *  alongside it; the engine derives their base by stripping this filename. */
  randStream: `https://cdn.jsdelivr.net/gh/${RAND_STREAM_REPO}@${RAND_STREAM_PIN}/public/rand-stream.wav`,
} as const

export const CDN_DEPENDENCIES = {
  '@codemirror/view': {
    version: '6.36.5',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/view@6.36.5',
  },
  '@codemirror/state': {
    version: '6.5.2',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/state@6.5.2',
  },
  'codemirror': {
    version: '6.0.1',
    cdn: 'esm.sh',
    url: 'https://esm.sh/codemirror@6.0.1',
  },
  '@codemirror/language': {
    version: '6.10.8',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@codemirror/language@6.10.8',
  },
  '@lezer/highlight': {
    version: '1.2.1',
    cdn: 'esm.sh',
    url: 'https://esm.sh/@lezer/highlight@1.2.1',
  },
  'supersonic-scsynth': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth@${SUPERSONIC_VERSION}/dist/`,
  },
  'supersonic-scsynth-core': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-core@${SUPERSONIC_VERSION}/`,
  },
  'supersonic-scsynth-samples': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-samples@${SUPERSONIC_VERSION}/samples/`,
  },
  'supersonic-scsynth-synthdefs': {
    version: SUPERSONIC_VERSION,
    cdn: 'unpkg',
    url: `https://unpkg.com/supersonic-scsynth-synthdefs@${SUPERSONIC_VERSION}/synthdefs/`,
  },
} as const
