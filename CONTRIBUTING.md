# Contributing to SonicPi.js

## Development Setup

```bash
git clone https://github.com/user/sonicpi.js
cd sonicpi.js
npm install
npm run dev        # starts dev server at localhost:5173
npm test           # runs vitest
npm run typecheck  # runs tsc --noEmit
```

## Project Structure

```
src/
  engine/                       # Core engine (scheduler, DSL, transpiler, bridge)
    __tests__/                  # Vitest tests
    interpreters/
      AudioInterpreter.ts      # Executes Steps against the audio backend
      QueryInterpreter.ts      # Executes Steps for query/preview (no audio)
    Program.ts                  # Step types (the "free monad" data layer)
    ProgramBuilder.ts           # Fluent builder API that produces a Program
    VirtualTimeScheduler.ts     # The core innovation -- scheduler-controlled Promises
    Parser.ts                   # Recursive descent transpiler (Ruby DSL -> JS)
    RubyTranspiler.ts           # Regex-based fallback transpiler
    Transpiler.ts               # autoTranspile entry point (tries Parser first)
    SuperSonicBridge.ts         # scsynth WASM bridge (via SuperSonic CDN)
    SonicPiEngine.ts            # Main engine class
    Ring.ts                     # ring, knit, range, line data structures
    ChordScale.ts               # chord(), scale(), note() helpers
    EuclideanRhythm.ts          # spread() -- Euclidean rhythm generator
    SeededRandom.ts             # Deterministic PRNG for reproducible randomness
    SoundEventStream.ts         # Event bus for sound events
    Sandbox.ts                  # Proxy-based sandbox for user code
    FriendlyErrors.ts           # Human-readable error messages
    SynthParams.ts              # Synth parameter definitions
    SampleCatalog.ts            # Sample name catalog
    ...
  app/                          # Standalone UI (vanilla TypeScript)
    App.ts                      # Main application shell
    Editor.ts                   # Code editor component
    Scope.ts                    # Audio visualizer
    Console.ts                  # Log output panel
    Toolbar.ts                  # Play/stop controls
docs/                           # Architecture documentation
artifacts/                      # Research papers and reference material
```

## How to Add a New DSL Function

This walkthrough uses a hypothetical `wobble` function as an example -- a synth effect that oscillates pitch. The same steps apply to any new function.

### Step 1: Add the Step type to `Program.ts`

Every runtime action needs a Step variant. Add it to the `Step` union:

```typescript
// in Program.ts
export type Step =
  | { tag: 'play'; note: number; opts: Record<string, number>; synth?: string }
  | { tag: 'sample'; name: string; opts: Record<string, number> }
  // ... existing steps ...
  | { tag: 'wobble'; rate: number; depth: number; opts: Record<string, number> }  // NEW
```

### Step 2: Add the builder method to `ProgramBuilder.ts`

The builder is the fluent API that transpiled code calls. Add a method:

```typescript
// in ProgramBuilder.ts
wobble(rate: number = 4, depth: number = 0.5, opts: Record<string, number> = {}) {
  this.steps.push({ tag: 'wobble', rate, depth, opts })
  return this
}
```

### Step 3: Add the handler to `AudioInterpreter.ts`

This is where the Step actually produces sound. Add a case in the step-processing switch:

```typescript
case 'wobble':
  // Schedule the wobble effect via the bridge
  break
```

### Step 4: Add the handler to `QueryInterpreter.ts`

The query interpreter runs Programs without audio (for preview, analysis). Mirror the step:

```typescript
case 'wobble':
  events.push({ type: 'wobble', time: currentTime, ... })
  break
```

### Step 5: Add parsing to `Parser.ts`

In the recursive descent parser, add recognition for the new function. Look at how existing functions like `play` or `sample` are handled in `parseStatement` or `parseExpression`, and follow the same pattern.

The parser needs to:
- Recognize `wobble` as a known function call
- Parse its arguments
- Emit `b.wobble(...)` in the output JavaScript

### Step 6: Mirror in `RubyTranspiler.ts`

Add `'wobble'` to the `BUILDER_FUNCTIONS` set at the top of the file:

```typescript
const BUILDER_FUNCTIONS = new Set([
  'play', 'sleep', 'sample', 'sync',
  // ... existing entries ...
  'wobble',  // NEW
])
```

The regex transpiler auto-prefixes any function in this set with `b.`, so simple functions often need no other changes. If `wobble` has special syntax (like blocks), add a dedicated regex rule.

### Step 7: Add tests

**Parser test** (`__tests__/Parser.test.ts`):
```typescript
it('transpiles wobble', () => {
  const { code, errors } = parseAndTranspile('wobble 4, depth: 0.5')
  expect(errors).toHaveLength(0)
  expect(code).toContain('b.wobble(4')
})
```

**Integration test** (`__tests__/RubyExamples.test.ts`):
```typescript
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

### Step 8: Run all tests

```bash
npm test
```

All tests must pass before submitting.

### When you can skip steps

Not every function touches every layer:

- **Build-time only** (like `density`): skip steps 1, 3, 4. The builder handles it internally by modifying sleep durations -- no Step is emitted.
- **Transpiler-only** (like `define`): skip steps 1, 2, 3, 4. The transpiler rewrites it directly into JS constructs (functions), no builder involvement.
- **Alias** (like mapping `play_pattern` to multiple `play` + `sleep` calls): might only need steps 2, 5, 6, 7.

## How the Transpiler Works

Sonic Pi code is Ruby. The engine runs JavaScript. Two transpilers bridge the gap:

1. **Parser.ts** (primary) -- recursive descent parser
   - Tokenizes the input into a token stream
   - Parses using recursive descent following the grammar in the file header
   - Emits JavaScript with `b.` prefixed builder calls
   - Handles nested blocks (`do`/`end`), control flow (`if`/`unless`), loops (`.times`, `.each`)
   - Produces friendly error messages with line numbers

2. **RubyTranspiler.ts** (fallback) -- line-by-line regex
   - Processes one line at a time with pattern matching
   - Simpler but misses multi-line expressions and complex nesting
   - Functions in the `BUILDER_FUNCTIONS` set get auto-prefixed with `b.`

3. **Transpiler.ts** -- the entry point
   - `autoTranspile()` tries Parser first, falls back to RubyTranspiler on failure
   - Both produce the same output format: JavaScript code that calls builder methods

Both transpilers must be updated when adding new syntax. The Parser handles it structurally; the RubyTranspiler usually just needs the function name added to `BUILDER_FUNCTIONS`.

## Testing

### Commands

```bash
npm test                                              # run all tests once
npm run test:watch                                    # watch mode (re-runs on save)
npx vitest run src/engine/__tests__/Parser.test.ts    # run a specific test file
npm run test:e2e                                      # Playwright end-to-end tests
npm run test:all                                      # vitest + playwright
```

### Test patterns

**Parser tests** -- input Ruby code, verify the transpiled JS contains expected strings:
```typescript
const { code, errors } = parseAndTranspile(`
live_loop :drums do
  sample :bd_haus
  sleep 0.5
end
`)
expect(errors).toHaveLength(0)
expect(code).toContain('b.sample("bd_haus")')
```

**ProgramBuilder tests** -- call builder methods, inspect the resulting Step array:
```typescript
const b = new ProgramBuilder()
b.play(60).sleep(0.5)
const steps = b.build()
expect(steps[0]).toMatchObject({ tag: 'play', note: 60 })
```

**RubyExamples tests** -- full end-to-end: Ruby code is transpiled, built into a Program, and executed through the VirtualTimeScheduler to verify it runs without errors:
```typescript
const { error, events } = await runCode(`
live_loop :test do
  play 60
  sleep 1
end
`)
expect(error).toBeUndefined()
```

## Build

```bash
npm run build          # standard Vite build
npm run build:single   # single HTML file (vite-plugin-singlefile)
```

The single-file build produces `dist/index.html` with all JS and CSS inlined -- zero external files except the SuperSonic CDN load. This is the primary distribution format.

Build target is ES2022 (see `vite.build.config.ts`).

## Code Style

- TypeScript strict mode
- No framework -- vanilla TypeScript throughout
- No semicolons
- Single quotes for strings
- 2-space indentation
- Inline styles in app components (no CSS files)
- Prefer `const` over `let`, avoid `var`
- Type imports: `import type { X } from '...'` when importing only types

## PR Guidelines

- One feature per commit
- Conventional commit messages: `feat(dsl): add wobble function`, `fix(transpiler): handle nested unless blocks`
- All tests must pass (`npm test` and `npm run typecheck`)
- Update both Parser.ts and RubyTranspiler.ts when adding syntax
- Update docs if adding user-facing features

## Architecture Reference

For deeper understanding of the scheduling model, free monad architecture, and design decisions, see:
- `artifacts/ref/THESIS.md` -- full build thesis
- `artifacts/ref/SESSION_PROMPT.md` -- implementation guide with phase breakdown
- `artifacts/ref/RESEARCH_SONIC_PI_INTERNALS.md` -- how desktop Sonic Pi works
- `artifacts/ref/RESEARCH_JS_SCHEDULING.md` -- JS async patterns for the scheduler

The core insight: `sleep()` returns a Promise that only the VirtualTimeScheduler can resolve. This gives JavaScript cooperative concurrency with virtual time -- no thread blocking required.
