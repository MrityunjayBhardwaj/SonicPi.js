import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildTutorialData, OUT_FILE } from '../ingest-tutorial'

/**
 * #333 — CI no-drift guard for tools/ingest-tutorial.ts (self-review of #332,
 * EPIC #309).
 *
 * tutorialData.ts is generated + committed, and the ingester is deterministic,
 * but nothing enforced that the committed file matches a fresh ingest of the
 * pinned vendored corpus. Editing src/tutorial/content/ or the ingester
 * without re-running `npm run ingest:tutorial` would silently drift the baked
 * data from source.
 *
 * This asserts byte-identity in-process: buildTutorialData() rebuilds from the
 * same vendored corpus the ingester reads, and we compare to the committed
 * tutorialData.ts. No subprocess, no temp path — importing the ingester is
 * side-effect-free (its main() runs only under direct execution). Lives in
 * tools/__tests__ (not src/) so the src tsconfig isn't dragged across the
 * tools boundary, mirroring tools/__tests__/capture-async-heuristic.test.ts.
 *
 * If this fails: run `npm run ingest:tutorial` and commit the result.
 */
describe('tutorial ingest drift guard (#333)', () => {
  it('committed tutorialData.ts is byte-identical to a fresh ingest', () => {
    const fresh = buildTutorialData().content
    const committed = readFileSync(OUT_FILE, 'utf8')
    expect(fresh).toBe(committed)
  })
})
