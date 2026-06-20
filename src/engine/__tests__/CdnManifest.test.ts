import { describe, it, expect } from 'vitest'
import {
  SUPERSONIC_VERSION,
  WEB_TREE_SITTER_VERSION,
  TREE_SITTER_WASMS_VERSION,
  CDN_DEFAULTS,
  CDN_DEPENDENCIES,
} from '../cdn-manifest'

// #604 / SV80: the engine loads its runtime deps from these URLs by default.
// SV22: every CDN URL must be VERSION-PINNED — an unpinned ("@latest" or bare)
// dependency silently drifts and produces the version-skew failures SV22 guards
// against. These tests freeze the contract so a careless edit can't unpin them.
describe('cdn-manifest CDN_DEFAULTS (SV80/SV22)', () => {
  it('every default URL is absolute https', () => {
    for (const [k, url] of Object.entries(CDN_DEFAULTS)) {
      expect(url, k).toMatch(/^https:\/\//)
    }
  })

  it('every default URL is version- or commit-pinned (no bare @latest)', () => {
    for (const [k, url] of Object.entries(CDN_DEFAULTS)) {
      // unpkg/jsdelivr npm: name@x.y.z ; jsdelivr gh: repo@<sha-or-tag>
      expect(url, k).toMatch(/@[^/]+/)
      expect(url, k).not.toMatch(/@latest(\b|\/)/)
    }
  })

  it('pins tree-sitter to the same versions as the installed packages', () => {
    expect(CDN_DEFAULTS.treeSitterWasm).toContain(`web-tree-sitter@${WEB_TREE_SITTER_VERSION}`)
    expect(CDN_DEFAULTS.rubyWasm).toContain(`tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}`)
  })

  it('pins SuperSonic to SUPERSONIC_VERSION, matching the manifest (SV22)', () => {
    expect(CDN_DEFAULTS.superSonicModule).toContain(`supersonic-scsynth@${SUPERSONIC_VERSION}`)
    // The four supersonic-* packages stay version-locked together (SV22).
    for (const key of [
      'supersonic-scsynth',
      'supersonic-scsynth-core',
      'supersonic-scsynth-samples',
      'supersonic-scsynth-synthdefs',
    ] as const) {
      expect(CDN_DEPENDENCIES[key].version, key).toBe(SUPERSONIC_VERSION)
      expect(CDN_DEPENDENCIES[key].url, key).toContain(`@${SUPERSONIC_VERSION}`)
    }
  })

  it('serves the rand-stream from the public/ dir so the 4 distribution tables resolve alongside', () => {
    // SonicPiEngine derives the distribution-table base by stripping the filename
    // (rand-stream.wav → …/public/), so the white table must live in that dir.
    expect(CDN_DEFAULTS.randStream).toMatch(/\/public\/rand-stream\.wav$/)
  })
})
