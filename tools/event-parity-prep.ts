/**
 * event-parity-prep.ts — build the work manifest for the event-parity sweep
 * (`event-parity-sweep.sh`). The event-diff dashboard (`build-event-diff.ts`)
 * reads `.captures/eventparity_*.json`, which are written ONLY by
 * `event-parity.ts` run per-fixture — the compare sweep never writes them
 * (SP151). So to truly refresh event-diff you must re-run event-parity over the
 * whole corpus first. This prep extracts the latest capture per fixture name
 * and emits, for each, the exact `code` + `duration` it was last captured with
 * → a temp `.rb` + a TSV manifest the sweep loop consumes.
 *
 * The corpus = whatever fixtures already have an `eventparity_*.json` capture
 * (the same set the dashboard renders). New fixtures enter the corpus the first
 * time they are event-parity'd directly; this refresh re-captures the existing
 * set so the dashboard reflects the current engine.
 *
 * Output dir: `.captures/.ep-sweep/` (under the gitignored `.captures/`).
 *   fixtures/<name>.rb   — the source for each fixture
 *   manifest.tsv         — <name>\t<duration_ms>\t<rb_path>, one per line
 *
 * NAME PARSING (SP151 trap): capture files are
 * `eventparity_<TS>_<name>.json` where the ISO-ish timestamp `<TS>` contains NO
 * underscores (it uses dashes) but `<name>` MAY contain underscores
 * (`sw_e2e_05_data_structures`, `10_idm_breakbeat`). So the name is everything
 * after the SECOND `_`-delimited token. A naive `*_<name>.json` glob
 * suffix-collides (`idm_breakbeat` would match `10_idm_breakbeat`); the sweep's
 * resume check uses an exact `eventparity_[^_]+_<name>.json` regex to match.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CAPTURES = resolve(ROOT, '.captures')
const OUT = resolve(CAPTURES, '.ep-sweep')
const FIXTURES = resolve(OUT, 'fixtures')

// Fresh fixtures dir each prep so a renamed/removed fixture doesn't linger.
rmSync(FIXTURES, { recursive: true, force: true })
mkdirSync(FIXTURES, { recursive: true })

/** Parse `eventparity_<TS>_<name>.json` → name, honoring underscores in name. */
function parseName(file: string): string | null {
  if (!file.startsWith('eventparity_') || !file.endsWith('.json')) return null
  const stem = file.slice('eventparity_'.length, -'.json'.length)
  const us = stem.indexOf('_') // end of the underscore-free timestamp
  if (us < 0) return null
  return stem.slice(us + 1)
}

const latest: Record<string, { mtime: number; path: string }> = {}
for (const f of readdirSync(CAPTURES)) {
  const name = parseName(f)
  if (!name) continue
  const p = resolve(CAPTURES, f)
  const mt = statSync(p).mtimeMs
  if (!latest[name] || mt > latest[name].mtime) latest[name] = { mtime: mt, path: p }
}

const rows: string[] = []
let skipped = 0
for (const name of Object.keys(latest).sort()) {
  const d = JSON.parse(readFileSync(latest[name].path, 'utf8'))
  const code: string = d.code ?? ''
  const duration: number = d.duration ?? 15000
  if (!code.trim()) { console.error('SKIP (no code):', name); skipped++; continue }
  const rb = resolve(FIXTURES, `${name}.rb`)
  writeFileSync(rb, code)
  rows.push(`${name}\t${duration}\t${rb}`)
}

writeFileSync(resolve(OUT, 'manifest.tsv'), rows.join('\n') + '\n')
const totalSec = rows.reduce((a, r) => a + Number(r.split('\t')[1]) / 1000, 0)
console.log(`prepared ${rows.length} fixtures (${skipped} skipped) → ${resolve(OUT, 'manifest.tsv')}`)
console.log(`sum of durations: ${Math.round(totalSec)}s (desktop+web run sequentially → ~2× + analysis)`)
