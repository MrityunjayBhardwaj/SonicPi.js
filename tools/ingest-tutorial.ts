/**
 * tools/ingest-tutorial.ts — T1 (#311), EPIC #309.
 *
 * Vendored Sonic Pi tutorial markdown  →  baked src/tutorial/tutorialData.ts
 *
 * Build-time ONLY. Deterministic + re-runnable: same vendored bytes (pinned
 * upstream commit abc844f, see src/tutorial/content/NOTICE) produce a
 * byte-identical tutorialData.ts. The runtime never parses markdown — this
 * mirrors the src/app/helpData.ts structured-data model.
 *
 * Dialect (grounded by reading the raw files at the pinned commit, #311 §1):
 *   - Line 1 is a plain-text title prefix ("2.1 Your First Beeps"), NOT
 *     CommonMark. It is the canonical (ordinal, title) source and is stripped
 *     from the rendered body.
 *   - Fenced code blocks carry no language tag; every fence in the corpus is
 *     runnable Sonic Pi  →  kind:'code', runnable:true, status:'unverified'.
 *     status transitions (verified | engine-gap | web-adapted) are owned by
 *     T2 (#312) — T1 stays engine-free (the #311 seam).
 *   - Images are relative refs into etc/doc/images/tutorial/. GUI/interface
 *     screenshots are desktop-app shots  →  desktopOnly:true.
 *
 * Run: npx tsx tools/ingest-tutorial.ts   (also: npm run ingest:tutorial)
 *
 * Input is trusted, pinned upstream content (not user input); marked output
 * is used as-is aside from a defensive <script> strip.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { marked } from 'marked'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTENT_DIR = join(HERE, '..', 'src', 'tutorial', 'content')
export const OUT_FILE = join(HERE, '..', 'src', 'tutorial', 'tutorialData.ts')
const PINNED_COMMIT = 'abc844fade22463fa6533215dc9f14ba4710079e'

/** Curated ~12 set (#311 §5, maintainer-locked). Order = chapter sequence. */
const CURATED: string[] = [
  '01-Welcome-to-Sonic-Pi',
  '01.2-Exploring-the-Interface',
  '02.1-Your-First-Beeps',
  '02.4-Durations-with-Envelopes',
  '03.1-Triggering-Samples',
  '04-Randomisation',
  '05.2-Iteration-and-Loops',
  '06.1-Adding-FX',
  '07.1-Controlling-Running-Synths',
  '08.4-Rings',
  '09.2-Live-Loops',
  '10.1-Set-and-Get',
]

/** Major-section name by leading file-prefix number (grounded from the
 *  etc/doc/tutorial/ section-root filenames at the pinned commit). */
const SECTION_NAMES: Record<string, string> = {
  '01': 'Welcome to Sonic Pi',
  '02': 'Synths',
  '03': 'Samples',
  '04': 'Randomisation',
  '05': 'Programming Structures',
  '06': 'FX',
  '07': 'Control',
  '08': 'Data Structures',
  '09': 'Live Coding',
  '10': 'State',
}

type CodeStatus = 'unverified' | 'verified' | 'engine-gap' | 'web-adapted'
type TutorialBlock =
  | { kind: 'prose'; html: string }
  | { kind: 'code'; id: string; code: string; runnable: true; status: CodeStatus }
  | { kind: 'image'; src: string; alt: string; desktopOnly: boolean }
  | { kind: 'web-note'; html: string }
interface TutorialChapter {
  id: string
  section: string
  ordinal: string
  title: string
  sourcePath: string
  blocks: TutorialBlock[]
}

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
}

/** Rewrite a vendored relative image ref to a runtime-relative path. */
function rewriteImageSrc(href: string): { src: string; file: string } {
  const file = href.split('/').filter(Boolean).pop() ?? href
  return { src: `images/tutorial/${file}`, file }
}

function ingestChapter(slug: string): TutorialChapter {
  const raw = readFileSync(join(CONTENT_DIR, `${slug}.md`), 'utf8')
  const nlIdx = raw.indexOf('\n')
  const titleLine = raw.slice(0, nlIdx).trim()
  const body = raw.slice(nlIdx + 1)

  // Line 1: "<ordinal> <title>" — ordinal is "N" or "N.M".
  const m = titleLine.match(/^([\d.]+)\s+(.*)$/)
  if (!m) throw new Error(`${slug}: line 1 is not a "<ordinal> <title>" prefix: ${JSON.stringify(titleLine)}`)
  const ordinal = m[1]
  const title = m[2].trim()

  const major = slug.slice(0, 2)
  const section = SECTION_NAMES[major]
  if (!section) throw new Error(`${slug}: no SECTION_NAMES entry for major "${major}"`)

  const id = slug.toLowerCase()
  const tokens = marked.lexer(body)
  const blocks: TutorialBlock[] = []
  let proseBuf: string[] = []
  let codeN = 0

  const flushProse = () => {
    const srcMd = proseBuf.join('').trim()
    proseBuf = []
    if (!srcMd) return
    const html = stripScripts(marked.parse(srcMd, { async: false }) as string).trim()
    if (html) blocks.push({ kind: 'prose', html })
  }

  // A standalone image = a paragraph whose children are only image/space/empty-text.
  const imageChildren = (tok: any): any[] | null => {
    if (tok.type !== 'paragraph' || !Array.isArray(tok.tokens)) return null
    const imgs = tok.tokens.filter((t: any) => t.type === 'image')
    if (imgs.length === 0) return null
    const onlyImgs = tok.tokens.every(
      (t: any) =>
        t.type === 'image' ||
        t.type === 'space' ||
        (t.type === 'text' && !String(t.raw).trim()),
    )
    return onlyImgs ? imgs : null
  }

  for (const tok of tokens as any[]) {
    // 'space' tokens carry the blank-line separators between blocks. They
    // must stay in the prose buffer or marked re-parses "# H\nNext para"
    // as one lazy-continuation heading. Harmless when the buffer is empty
    // (leading whitespace is trimmed at flush).
    if (tok.type === 'space') {
      proseBuf.push(tok.raw)
      continue
    }
    if (tok.type === 'code') {
      flushProse()
      blocks.push({
        kind: 'code',
        id: `${id}#${codeN++}`,
        code: String(tok.text),
        runnable: true,
        status: 'unverified',
      })
      continue
    }
    const imgs = imageChildren(tok)
    if (imgs) {
      flushProse()
      for (const img of imgs) {
        const { src, file } = rewriteImageSrc(String(img.href))
        blocks.push({
          kind: 'image',
          src,
          alt: String(img.text ?? ''),
          desktopOnly: /gui|interface/i.test(file),
        })
      }
      continue
    }
    proseBuf.push(tok.raw)
  }
  flushProse()

  return {
    id,
    section,
    ordinal,
    title,
    sourcePath: `etc/doc/tutorial/${slug}.md`,
    blocks,
  }
}

/**
 * Build the full text of tutorialData.ts from the vendored corpus, WITHOUT
 * writing it. Pure + deterministic — same vendored bytes produce the same
 * `content` every call. Exported so the drift guard (#333,
 * tools/__tests__/ingest-tutorial-drift.test.ts) can assert the committed
 * file is byte-identical to a fresh ingest, in-process, with no temp files.
 */
export function buildTutorialData(): {
  content: string
  chapterCount: number
  codeBlocks: number
} {
  const onDisk = new Set(
    readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
  )
  for (const slug of CURATED) {
    if (!onDisk.has(slug)) throw new Error(`Curated chapter not vendored: ${slug}.md`)
  }

  const chapters = CURATED.map(ingestChapter)

  const header = `/**
 * src/tutorial/tutorialData.ts — GENERATED by tools/ingest-tutorial.ts. DO NOT EDIT.
 *
 * Curated Sonic Pi tutorial, baked at build time (T1 / #311, EPIC #309).
 * Source: Sonic Pi tutorial © Sam Aaron, CC BY-SA 4.0, pinned upstream
 * commit ${PINNED_COMMIT} (see src/tutorial/content/NOTICE).
 *
 * code.status is 'unverified' for every block here — T2 (#312) owns the
 * verified | engine-gap | web-adapted transitions. Re-run the ingester
 * (npm run ingest:tutorial) to regenerate; the prose carried here is
 * CC BY-SA 4.0 and does not relicense engine/app code.
 */
export type CodeStatus = 'unverified' | 'verified' | 'engine-gap' | 'web-adapted'

export type TutorialBlock =
  | { kind: 'prose'; html: string }
  | { kind: 'code'; id: string; code: string; runnable: true; status: CodeStatus }
  | { kind: 'image'; src: string; alt: string; desktopOnly: boolean }
  | { kind: 'web-note'; html: string }

export interface TutorialChapter {
  id: string
  section: string
  ordinal: string
  title: string
  sourcePath: string
  blocks: TutorialBlock[]
}

export const TUTORIAL: TutorialChapter[] = `

  const codeBlocks = chapters.reduce(
    (n, c) => n + c.blocks.filter((b) => b.kind === 'code').length,
    0,
  )
  return {
    content: header + JSON.stringify(chapters, null, 2) + '\n',
    chapterCount: chapters.length,
    codeBlocks,
  }
}

function main() {
  const { content, chapterCount, codeBlocks } = buildTutorialData()
  writeFileSync(OUT_FILE, content, 'utf8')
  console.log(
    `ingest-tutorial: ${chapterCount} chapters, ${codeBlocks} code blocks → ${OUT_FILE}`,
  )
}

// Only run the ingester when executed directly (`tsx tools/ingest-tutorial.ts`),
// NOT when imported (e.g. by the #333 drift guard) — importing must not
// overwrite the committed tutorialData.ts.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
