/**
 * CodeMirror 6 editor — loaded from CDN, Sonic Pi-style dark theme.
 * Falls back to styled textarea if CDN unavailable.
 */

// Minimal types for the CodeMirror API surface we use
interface EditorState {
  doc: { toString(): string; length: number }
  selection?: { main: { from: number; to: number } }
}

interface EditorView {
  state: EditorState
  dispatch(tr: unknown): void
  destroy(): void
  dom: HTMLElement
}

interface CMModule {
  EditorView: {
    new (config: Record<string, unknown>): EditorView
    theme(spec: Record<string, unknown>): unknown
    updateListener: { of(fn: (update: unknown) => void): unknown }
  }
  EditorState: {
    create(config: Record<string, unknown>): EditorState
  }
  basicSetup: unknown
  keymap: { of(bindings: unknown[]): unknown }
  rubyLang: unknown | null
  highlightStyle: unknown | null
}

// Sonic Pi stream parser for CodeMirror — inline, no CDN dependency
const SP_KEYWORDS = new Set([
  'live_loop', 'do', 'end', 'with_fx', 'in_thread', 'define',
  'if', 'elsif', 'else', 'unless', 'loop', 'while', 'until',
  'begin', 'rescue', 'ensure', 'for', 'case', 'when', 'then',
  'and', 'or', 'not', 'true', 'false', 'nil', 'return',
])
const SP_BUILTINS = new Set([
  'play', 'sleep', 'sample', 'use_synth', 'use_bpm', 'use_random_seed',
  'sync', 'cue', 'control', 'stop', 'density', 'puts', 'print',
  'rrand', 'rrand_i', 'rand', 'rand_i', 'choose', 'dice', 'one_in',
  'ring', 'knit', 'range', 'line', 'spread', 'chord', 'scale',
  'chord_invert', 'note', 'note_range', 'tick', 'look',
])
// Block-opening keywords that increase indent on the next line
const SP_BLOCK_OPENERS = new Set(['do', 'then', 'begin', 'else', 'elsif', 'rescue', 'ensure'])

interface SonicPiParserState {
  indentLevel: number
}

const sonicPiStreamParser = {
  startState(): SonicPiParserState {
    return { indentLevel: 0 }
  },
  copyState(s: SonicPiParserState): SonicPiParserState {
    return { indentLevel: s.indentLevel }
  },
  token(stream: { match(re: RegExp): string[] | null; next(): string; eol(): boolean; skipToEnd(): void; peek(): string; sol(): boolean }, state: SonicPiParserState) {
    // Comment
    if (stream.match(/^#.*/)) return 'comment'
    // String
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return 'string'
    // Symbol :name
    if (stream.match(/^:\w+/)) return 'atom'
    // Number
    if (stream.match(/^-?\d+\.?\d*/)) return 'number'
    // Word
    const wordMatch = stream.match(/^\w+[!?]?/)
    if (wordMatch) {
      const w = wordMatch[0]
      if (SP_KEYWORDS.has(w)) {
        // Track indent: block openers at end of line increase indent
        if (SP_BLOCK_OPENERS.has(w) && stream.eol()) {
          state.indentLevel++
        }
        // 'end' at start of meaningful content decreases indent
        if (w === 'end') {
          state.indentLevel = Math.max(0, state.indentLevel - 1)
        }
        return 'keyword'
      }
      if (SP_BUILTINS.has(w)) return 'builtin'
      return 'variable'
    }
    // Operator
    if (stream.match(/^[+\-*/%=<>!&|^~]+/)) return 'operator'
    // Skip unknown
    stream.next()
    return null
  },
  indent(state: SonicPiParserState, textAfter: string) {
    let level = state.indentLevel
    // If the line being indented starts with 'end', dedent one level
    if (/^\s*end\b/.test(textAfter)) {
      level = Math.max(0, level - 1)
    }
    return level * 2  // 2-space indent (Sonic Pi convention)
  },
}

export class Editor {
  private view: EditorView | null = null
  private container: HTMLElement
  private fallbackTextarea: HTMLTextAreaElement | null = null
  private onRunCallback: (() => void) | null = null
  private onStopCallback: (() => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.container.style.cssText = `
      height: 100%; overflow: hidden;
      background: #1B2B34;
    `
  }

  async init(initialCode: string): Promise<void> {
    try {
      const cm = await this.loadCodeMirror()
      this.createEditorView(cm, initialCode)
    } catch (err) {
      console.warn('CodeMirror load failed, using textarea fallback:', err)
      this.createFallback(initialCode)
    }
  }

  getValue(): string {
    if (this.view) return this.view.state.doc.toString()
    if (this.fallbackTextarea) return this.fallbackTextarea.value
    return ''
  }

  setValue(code: string): void {
    if (this.view) {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: code },
      })
    } else if (this.fallbackTextarea) {
      this.fallbackTextarea.value = code
    }
  }

  onRun(callback: () => void): void { this.onRunCallback = callback }
  onStop(callback: () => void): void { this.onStopCallback = callback }

  /** Highlight an error line (1-based). Call with null to clear. */
  highlightErrorLine(line: number | null): void {
    // Remove previous error highlight
    if (this.errorLineEl) {
      this.errorLineEl.remove()
      this.errorLineEl = null
    }

    if (line === null) return

    if (this.view) {
      // CodeMirror: inject a style for the error line
      const doc = this.view.state.doc.toString()
      const lines = doc.split('\n')
      if (line > 0 && line <= lines.length) {
        let charOffset = 0
        for (let i = 0; i < line - 1; i++) charOffset += lines[i].length + 1
        // Add a CSS rule targeting the line
        const style = document.createElement('style')
        style.textContent = `.cm-line:nth-child(${line}) { background: rgba(232,82,124,0.15) !important; border-left: 3px solid #E8527C !important; }`
        this.container.appendChild(style)
        this.errorLineEl = style
      }
    } else if (this.fallbackTextarea) {
      // Textarea: can't highlight lines, but we can show in console
    }
  }

  private errorLineEl: HTMLElement | null = null

  dispose(): void {
    this.view?.destroy()
    this.fallbackTextarea?.remove()
  }

  private async loadCodeMirror(): Promise<CMModule> {
    // CDN dependencies — use esm.sh with major version to avoid multiple
    // @codemirror/state instances (which break instanceof checks).
    // See src/engine/cdn-manifest.ts for the full dependency manifest.

    // @ts-ignore — CDN URLs
    const viewMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/view@6')
    // @ts-ignore
    const stateMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/state@6')
    // @ts-ignore
    const cmMod = await import(/* @vite-ignore */ 'https://esm.sh/codemirror@6')

    // Sonic Pi syntax highlighting — inline tokenizer, no CDN dependency
    let rubyLang: unknown = null
    let highlightStyle: unknown = null
    try {
      // @ts-ignore
      const langMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/language@6')
      // @ts-ignore
      const highlightMod = await import(/* @vite-ignore */ 'https://esm.sh/@lezer/highlight@1')
      if (langMod.StreamLanguage) {
        rubyLang = langMod.StreamLanguage.define(sonicPiStreamParser)
      }
      if (langMod.syntaxHighlighting && highlightMod.HighlightStyle && highlightMod.tags) {
        const t = highlightMod.tags
        highlightStyle = langMod.syntaxHighlighting(
          highlightMod.HighlightStyle.define([
            { tag: t.keyword, color: '#C792EA' },
            { tag: t.atom, color: '#F78C6C' },
            { tag: t.number, color: '#F78C6C' },
            { tag: t.string, color: '#99C794' },
            { tag: t.comment, color: '#65737E', fontStyle: 'italic' },
            { tag: t.variableName, color: '#CDD3DE' },
            { tag: t.function(t.variableName), color: '#82AAFF' },
            { tag: t.operator, color: '#89DDFF' },
          ])
        )
      }
    } catch {
      // Language module unavailable — editor still works, just no colors
    }

    const { EditorView, keymap } = viewMod
    const { EditorState } = stateMod
    const { basicSetup } = cmMod
    return { EditorView, EditorState, basicSetup, keymap, rubyLang, highlightStyle } as unknown as CMModule
  }

  private createEditorView(cm: CMModule, initialCode: string): void {
    // Build extensions array — each one is optional, skip if it fails
    const extensions: unknown[] = []

    // Basic setup (line numbers, bracket matching, etc.)
    if (cm.basicSetup) extensions.push(cm.basicSetup)

    // Dark theme
    try {
      const theme = cm.EditorView.theme({
        '&': { height: '100%', fontSize: '14px', background: '#1B2B34' },
        '.cm-scroller': {
          fontFamily: "'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
          lineHeight: '1.65',
        },
        '.cm-content': { color: '#CDD3DE', caretColor: '#E8527C', padding: '0.5rem 0' },
        '.cm-gutters': { background: '#15232D', color: '#4F5B66', border: 'none' },
        '.cm-activeLineGutter': { background: 'rgba(232,82,124,0.08)', color: '#8892B0' },
        '.cm-activeLine': { background: 'rgba(255,255,255,0.02)' },
        '&.cm-focused .cm-cursor': { borderLeftColor: '#E8527C', borderLeftWidth: '2px' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          background: 'rgba(232,82,124,0.15) !important',
        },
      } as Record<string, unknown>)
      if (theme) extensions.push(theme)
    } catch { /* theme failed — use default */ }

    // Keybindings
    try {
      const runKeymap = cm.keymap.of([
        { key: 'Mod-Enter', run: () => { this.onRunCallback?.(); return true } },
        { key: 'Escape', run: () => { this.onStopCallback?.(); return true } },
        {
          key: 'Mod-/',
          run: (view: EditorView) => {
            // Toggle Ruby # comments — only change affected lines
            const doc = view.state.doc.toString()
            const sel = view.state.selection?.main ?? { from: 0, to: 0 }
            const lines = doc.split('\n')
            const fromLine = doc.substring(0, sel.from).split('\n').length
            const toLine = doc.substring(0, sel.to).split('\n').length

            const selectedLines = lines.slice(fromLine - 1, toLine)
            const allCommented = selectedLines.every(l => l.trimStart().startsWith('#') || l.trim() === '')

            // Compute char offset of the affected line range
            let rangeStart = 0
            for (let i = 0; i < fromLine - 1; i++) rangeStart += lines[i].length + 1
            let rangeEnd = rangeStart
            for (let i = fromLine - 1; i < toLine; i++) rangeEnd += lines[i].length + (i < toLine - 1 ? 1 : 0)

            // Build replacement for only the affected lines
            const newLines: string[] = []
            for (let i = fromLine - 1; i < toLine; i++) {
              if (allCommented) {
                newLines.push(lines[i].replace(/^(\s*)#\s?/, '$1'))
              } else {
                newLines.push(lines[i].trim() !== '' ? lines[i].replace(/^(\s*)/, '$1# ') : lines[i])
              }
            }

            view.dispatch({
              changes: { from: rangeStart, to: rangeEnd, insert: newLines.join('\n') },
            })
            return true
          },
        },
      ])
      if (runKeymap) extensions.push(runKeymap)
    } catch { /* keybindings failed */ }

    // Sonic Pi language support + syntax colors
    if (cm.rubyLang) extensions.push(cm.rubyLang)
    if (cm.highlightStyle) extensions.push(cm.highlightStyle)

    const state = cm.EditorState.create({
      doc: initialCode,
      extensions: extensions.filter(Boolean),
    })

    this.view = new cm.EditorView({
      state,
      parent: this.container,
    })
  }

  private createFallback(initialCode: string): void {
    const textarea = document.createElement('textarea')
    textarea.value = initialCode
    textarea.spellcheck = false
    textarea.style.cssText = `
      width: 100%; height: 100%;
      background: #1B2B34;
      color: #CDD3DE;
      border: none;
      padding: 1rem;
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', monospace;
      font-size: 14px;
      line-height: 1.65;
      resize: none;
      outline: none;
      tab-size: 2;
    `
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        this.onRunCallback?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.onStopCallback?.()
      }
      // Tab inserts 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = textarea.selectionStart
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(textarea.selectionEnd)
        textarea.selectionStart = textarea.selectionEnd = start + 2
      }
      // Ctrl+/ toggle Ruby # comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        const val = textarea.value
        const start = val.lastIndexOf('\n', textarea.selectionStart - 1) + 1
        const end = val.indexOf('\n', textarea.selectionEnd)
        const lineEnd = end === -1 ? val.length : end
        const line = val.substring(start, lineEnd)
        const toggled = line.trimStart().startsWith('#')
          ? line.replace(/^(\s*)#\s?/, '$1')
          : line.replace(/^(\s*)/, '$1# ')
        textarea.value = val.substring(0, start) + toggled + val.substring(lineEnd)
        textarea.selectionStart = start
        textarea.selectionEnd = start + toggled.length
      }
    })
    this.container.appendChild(textarea)
    this.fallbackTextarea = textarea
  }
}
