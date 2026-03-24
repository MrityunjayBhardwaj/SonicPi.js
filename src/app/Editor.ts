/**
 * CodeMirror 6 editor — loaded from CDN, Sonic Pi-style dark theme.
 * Falls back to styled textarea if CDN unavailable.
 */

// Minimal types for the CodeMirror API surface we use
interface EditorState {
  doc: { toString(): string; length: number }
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

  dispose(): void {
    this.view?.destroy()
    this.fallbackTextarea?.remove()
  }

  private async loadCodeMirror(): Promise<CMModule> {
    // @ts-ignore — CDN URLs
    const viewMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/view@6')
    // @ts-ignore
    const stateMod = await import(/* @vite-ignore */ 'https://esm.sh/@codemirror/state@6')
    // @ts-ignore
    const cmMod = await import(/* @vite-ignore */ 'https://esm.sh/codemirror@6')
    const { EditorView, keymap } = viewMod
    const { EditorState } = stateMod
    const { basicSetup } = cmMod
    return { EditorView, EditorState, basicSetup, keymap } as unknown as CMModule
  }

  private createEditorView(cm: CMModule, initialCode: string): void {
    // Sonic Pi dark theme — based on Oceanic Next
    const theme = cm.EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '14px',
        background: '#1B2B34',
      },
      '.cm-scroller': {
        fontFamily: "'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace",
        lineHeight: '1.65',
      },
      '.cm-content': {
        color: '#CDD3DE',
        caretColor: '#E8527C',
        padding: '0.5rem 0',
      },
      '.cm-gutters': {
        background: '#15232D',
        color: '#4F5B66',
        border: 'none',
        paddingRight: '0.5rem',
      },
      '.cm-activeLineGutter': {
        background: 'rgba(232,82,124,0.08)',
        color: '#8892B0',
      },
      '.cm-activeLine': {
        background: 'rgba(255,255,255,0.02)',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: '#E8527C',
        borderLeftWidth: '2px',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        background: 'rgba(232,82,124,0.15) !important',
      },
      '.cm-matchingBracket': {
        background: 'rgba(94,189,171,0.2)',
        outline: '1px solid rgba(94,189,171,0.4)',
      },
      '.cm-searchMatch': {
        background: 'rgba(232,82,124,0.2)',
      },
      '.cm-tooltip': {
        background: '#1B2B34',
        border: '1px solid rgba(255,255,255,0.1)',
      },
    } as Record<string, unknown>)

    // Keybindings
    const runKeymap = cm.keymap.of([
      {
        key: 'Mod-Enter',
        run: () => { this.onRunCallback?.(); return true },
      },
      {
        key: 'Escape',
        run: () => { this.onStopCallback?.(); return true },
      },
    ])

    const state = cm.EditorState.create({
      doc: initialCode,
      extensions: [cm.basicSetup, theme, runKeymap],
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
    })
    this.container.appendChild(textarea)
    this.fallbackTextarea = textarea
  }
}
