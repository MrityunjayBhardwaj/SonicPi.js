# Contributing to SonicPi.js

## Development Setup

```bash
git clone https://github.com/MrityunjayBhardwaj/SonicPi.js
cd SonicPi.js
npm install
npm run dev        # starts dev server at localhost:5173
npm test           # runs vitest (703 tests)
npm run typecheck  # runs tsc --noEmit
```

## Architecture

```
Ruby DSL → TreeSitter AST → JS builder chains → Sandbox → Scheduler → AudioWorklet → Speaker
```

Five stages:

1. **TreeSitter transpiler** (`TreeSitterTranspiler.ts`) — parses Ruby into an AST, walks it to emit JavaScript builder calls (`b.play(60)`, `b.sleep(0.5)`)
2. **Sandbox** (`Sandbox.ts`) — wraps transpiled code in a `with()` proxy that blocks dangerous globals and routes all DSL calls through the builder
3. **VirtualTimeScheduler** (`VirtualTimeScheduler.ts`) — resolves `sleep()` Promises to advance virtual time. Multiple `live_loop`s run concurrently, each on their own timeline
4. **AudioInterpreter** (`AudioInterpreter.ts`) — executes each Step against SuperSonic (scsynth WASM) via OSC messages
5. **SuperSonicBridge** (`SuperSonicBridge.ts`) — translates engine commands to scsynth OSC, manages synth nodes, bus routing, and group ordering

## Project Structure

```
src/
  engine/                         # Core engine (standalone, no UI dependency)
    __tests__/                    # Vitest tests (703)
    interpreters/
      AudioInterpreter.ts        # Executes Steps against scsynth
      QueryInterpreter.ts        # Executes Steps without audio (preview/analysis)
    Program.ts                   # Step types (the algebraic effect signatures)
    ProgramBuilder.ts            # Fluent builder API that produces Step[]
    VirtualTimeScheduler.ts      # Scheduler-controlled Promise resolution
    TreeSitterTranspiler.ts      # Ruby DSL → JS via Tree-sitter AST
    RubyTranspiler.ts            # autoTranspile entry point + wrapBareCode
    SuperSonicBridge.ts          # scsynth WASM bridge (SuperSonic CDN)
    SoundLayer.ts                # Parameter normalization (mirrors Desktop SP sound.rb)
    SonicPiEngine.ts             # Main engine class — orchestrates everything
    Sandbox.ts                   # Proxy-based sandbox for user code
    FriendlyErrors.ts            # Human-readable error messages (20 patterns)
    SynthParams.ts               # Per-synth/FX parameter catalogs
    SampleCatalog.ts             # 197 sample names with categories
    Ring.ts                      # ring, knit, range, line data structures
    ChordScale.ts                # chord(), scale(), note() — 80 chords, 80 scales
    EuclideanRhythm.ts           # spread() — Euclidean rhythm generator
    SeededRandom.ts              # Mersenne Twister PRNG (matches Desktop SP)
    config.ts                    # All hyperparameters with provenance
  app/                           # Standalone UI (vanilla TypeScript, no framework)
    App.ts                       # Application shell — layout, wiring, lifecycle
    Editor.ts                    # CodeMirror 6 editor with autocomplete
    Scope.ts                     # 5-mode audio visualizer (mono/stereo/lissajous/mirror/spectrum)
    Console.ts                   # Log output panel
    CueLog.ts                    # Live cue/sync event panel
    Toolbar.ts                   # Play/Stop/Rec/Save/Load controls + buffer tabs
    MenuBar.ts                   # View/Visuals/Samples/Prefs menus + Report Bug
    HelpPanel.ts                 # Inline docs (311 entries)
    SampleBrowser.ts             # Browse and preview samples
    helpData.ts                  # Help database (functions + auto-generated synth/FX/sample entries)
```

## How to Add a New DSL Function

Example: adding a hypothetical `wobble` function.

### Step 1: Add the Step type to `Program.ts`

```typescript
export type Step =
  | { tag: 'play'; note: number; opts: Record<string, number> }
  // ... existing steps ...
  | { tag: 'wobble'; rate: number; depth: number }  // NEW
```

### Step 2: Add the builder method to `ProgramBuilder.ts`

```typescript
wobble(rate: number = 4, depth: number = 0.5) {
  this.steps.push({ tag: 'wobble', rate, depth })
  return this
}
```

### Step 3: Handle in `AudioInterpreter.ts`

```typescript
case 'wobble':
  // Schedule the effect via the bridge
  break
```

### Step 4: Handle in `QueryInterpreter.ts`

```typescript
case 'wobble':
  events.push({ type: 'wobble', time: currentTime })
  break
```

### Step 5: Add to `TreeSitterTranspiler.ts`

Add `'wobble'` to the `BUILDER_FUNCTIONS` set:

```typescript
const BUILDER_FUNCTIONS = new Set([
  'play', 'sleep', 'sample',
  // ...
  'wobble',  // NEW
])
```

Simple functions (no blocks) just need this — the transpiler auto-prefixes with `b.`. If `wobble` takes a `do...end` block, add a dedicated handler following the pattern of `transpileWithBlock`.

### Step 6: Add tests

```typescript
// TreeSitterTranspiler.test.ts
it('transpiles wobble', () => {
  const result = treeSitterTranspile('wobble 4, depth: 0.5')
  expect(result.errors).toHaveLength(0)
  expect(result.code).toContain('b.wobble(4')
})

// RubyExamples.test.ts
it('wobble in a live_loop', async () => {
  const { error } = await runCode(`
    live_loop :wobbler do
      wobble 4, depth: 0.5
      sleep 1
    end
  `)
  expect(error).toBeUndefined()
})
```

### Step 7: Run all tests

```bash
npm test && npm run typecheck
```

### When you can skip steps

- **Build-time only** (like `density`): no Step needed — the builder modifies sleep durations internally
- **Transpiler-only** (like `define`): no Step/builder — the transpiler rewrites directly to JS constructs
- **Alias** (like `play_pattern`): only needs the builder method, which expands to existing Steps

## Testing

```bash
npm test                                                    # all 703 tests
npx vitest run src/engine/__tests__/TreeSitterTranspiler.test.ts  # specific file
npm run test:e2e                                            # Playwright browser tests
```

CI runs `tsc --noEmit` + `vitest run` on every PR.

## Code Style

- TypeScript strict mode, no framework
- No semicolons, single quotes, 2-space indent
- Prefer `const` over `let`
- Inline styles in app components (no CSS files)
- `import type { X }` for type-only imports

## PR Guidelines

- One logical change per commit
- Gitmoji prefix: `🐛 fix:`, `🎵 feat:`, `🔧 chore:`
- All tests must pass
- Update `TreeSitterTranspiler.ts` when adding syntax (it's the sole transpiler)

## License

MIT
