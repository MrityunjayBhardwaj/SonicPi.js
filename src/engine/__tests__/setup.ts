/**
 * Vitest setup — initializes TreeSitter WASM in every test worker.
 *
 * TreeSitter is the sole transpiler. WASM files are loaded from
 * node_modules (not public/) since tests run in Node.js.
 */
import { initTreeSitter, isTreeSitterReady } from '../TreeSitterTranspiler'

const base = new URL('../../..', import.meta.url).pathname
const tsWasm = base + 'node_modules/web-tree-sitter/tree-sitter.wasm'
const rubyWasm = base + 'node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm'

if (!isTreeSitterReady()) {
  const ok = await initTreeSitter({
    treeSitterWasmUrl: tsWasm,
    rubyWasmUrl: rubyWasm,
  })

  if (!ok) {
    throw new Error('TreeSitter WASM initialization failed — cannot run tests without it')
  }
}
