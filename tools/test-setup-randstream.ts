/**
 * Vitest setup — load desktop's frozen rand stream for Node tests (EPIC #531).
 *
 * Every ProgramBuilder indexes the shared white table (the browser fetches it at
 * SonicPiEngine.init; here we read the served wav from `public/` via fs). Lives in
 * tools/ (not src/engine/__tests__/) so it can use node:fs without the src
 * tsconfig — which has no @types/node — failing to type-check it. Registered
 * alongside the tree-sitter setup in vitest.config.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeRandStream, setWhiteRandStream, isWhiteRandStreamLoaded } from '../src/engine/RandStream'

if (!isWhiteRandStreamLoaded()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  setWhiteRandStream(decodeRandStream(readFileSync(join(root, 'public', 'rand-stream.wav'))))
}
