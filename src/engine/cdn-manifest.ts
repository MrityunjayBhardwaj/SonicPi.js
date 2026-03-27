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
 * Package                    Version   CDN       Used in
 * -------------------------  --------  --------  ---------
 * @codemirror/view           6.36.5    esm.sh    Editor.ts
 * @codemirror/state          6.5.2     esm.sh    Editor.ts
 * codemirror                 6.0.1     esm.sh    Editor.ts
 * @codemirror/language       6.10.8    esm.sh    Editor.ts
 * @lezer/highlight           1.2.1     esm.sh    Editor.ts
 * supersonic-scsynth         @latest   unpkg     SuperSonicBridge.ts  (0.66.x at time of writing)
 * supersonic-scsynth-core    @latest   unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-samples @latest   unpkg     SuperSonicBridge.ts
 * supersonic-scsynth-synthdefs @latest unpkg     SuperSonicBridge.ts
 *
 * Note: supersonic-scsynth packages use @latest rather than a pinned version
 * because the WASM binary and worker URLs must match the JS package exactly.
 * Pinning requires coordinating four package versions simultaneously.
 */

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
    version: 'latest',
    cdn: 'unpkg',
    url: 'https://unpkg.com/supersonic-scsynth@latest/dist/',
  },
} as const
