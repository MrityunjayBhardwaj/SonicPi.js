/**
 * HelpPanel — toggleable panel showing documentation for the word under cursor.
 *
 * Renders below the CodeMirror editor. Updates when the cursor moves.
 * Dark theme matching the rest of the app.
 */

import { HELP_DB, type HelpEntry } from './helpData'

export class HelpPanel {
  private container: HTMLElement
  private handle: HTMLElement
  private dragging = false
  private visible = false
  private content: HTMLElement
  private currentWord = ''

  /** Callbacks for external wiring (e.g. cursor change from Editor). */
  onVisibilityChange: ((visible: boolean) => void) | null = null
  /** Called on show to get the current word under cursor. */
  getCurrentWord: (() => string) | null = null

  constructor(parent: HTMLElement) {
    // Restore saved height
    let savedHeight = 150
    try {
      const h = localStorage.getItem('spw-help-height')
      if (h) savedHeight = Math.max(80, Math.min(500, parseInt(h, 10)))
    } catch { /* ignore */ }

    // Drag handle (splitter)
    this.handle = document.createElement('div')
    this.handle.style.cssText = `
      height: 5px;
      cursor: ns-resize;
      background: transparent;
      flex-shrink: 0;
      display: none;
      position: relative;
    `
    // Visual indicator line
    const indicator = document.createElement('div')
    indicator.style.cssText = `
      position: absolute;
      left: 0; right: 0; top: 2px;
      height: 1px;
      background: rgba(255,255,255,0.08);
      transition: background 0.15s;
    `
    this.handle.appendChild(indicator)
    this.handle.addEventListener('mouseenter', () => { indicator.style.background = 'rgba(232,82,124,0.5)' })
    this.handle.addEventListener('mouseleave', () => { if (!this.dragging) indicator.style.background = 'rgba(255,255,255,0.08)' })

    // Drag logic
    this.handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.dragging = true
      indicator.style.background = 'rgba(232,82,124,0.7)'
      const startY = e.clientY
      const startH = this.container.getBoundingClientRect().height

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY // dragging up = bigger
        const newH = Math.max(80, Math.min(500, startH + delta))
        this.container.style.height = `${newH}px`
      }
      const onUp = () => {
        this.dragging = false
        indicator.style.background = 'rgba(255,255,255,0.08)'
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        try { localStorage.setItem('spw-help-height', String(Math.round(this.container.getBoundingClientRect().height))) } catch { /* ignore */ }
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })

    parent.appendChild(this.handle)

    this.container = document.createElement('div')
    this.container.className = 'spw-help-panel'
    this.container.style.cssText = `
      height: ${savedHeight}px;
      overflow-y: auto;
      background: #161b22;
      border-top: 1px solid rgba(255,255,255,0.08);
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      color: #c9d1d9;
      padding: 0.6rem 0.8rem;
      display: none;
      flex-shrink: 0;
    `

    this.content = document.createElement('div')
    this.container.appendChild(this.content)
    parent.appendChild(this.container)

    this.renderEmpty()
  }

  show(): void {
    this.visible = true
    this.handle.style.display = 'block'
    this.container.style.display = 'block'
    this.onVisibilityChange?.(true)
    // Immediately show help for the word under cursor
    const word = this.getCurrentWord?.() ?? ''
    if (word) this.updateWord(word)
  }

  hide(): void {
    this.visible = false
    this.handle.style.display = 'none'
    this.container.style.display = 'none'
    this.onVisibilityChange?.(false)
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** Called by the editor on cursor movement with the word under the cursor. */
  updateWord(word: string): void {
    if (!this.visible) return
    const cleaned = word.replace(/^:/, '').toLowerCase()
    if (cleaned === this.currentWord) return
    this.currentWord = cleaned

    const entry = HELP_DB[cleaned]
    if (entry) {
      this.renderEntry(cleaned, entry)
    } else {
      this.renderEmpty()
    }
  }

  private renderEntry(name: string, entry: HelpEntry): void {
    const paramRows = entry.params.map(p => {
      const dflt = p.default ? ` <span style="color:#484f58">(default: ${this.esc(p.default)})</span>` : ''
      return `<tr>
        <td style="color:#F78C6C;padding:0.15rem 0.6rem 0.15rem 0;white-space:nowrap;vertical-align:top;">:${this.esc(p.name)}</td>
        <td style="color:#484f58;padding:0.15rem 0.6rem 0.15rem 0;white-space:nowrap;vertical-align:top;">${this.esc(p.type)}</td>
        <td style="padding:0.15rem 0;vertical-align:top;">${this.esc(p.desc)}${dflt}</td>
      </tr>`
    }).join('')

    this.content.innerHTML = `
      <div style="margin-bottom:0.4rem;">
        <span style="color:#82AAFF;font-weight:bold;font-size:0.8rem;">${this.esc(name)}</span>
        <span style="color:#484f58;margin-left:0.5rem;">${this.esc(entry.signature)}</span>
      </div>
      <div style="color:#8b949e;margin-bottom:0.5rem;">${this.esc(entry.description)}</div>
      ${entry.params.length > 0 ? `
        <div style="color:#484f58;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.2rem;">Parameters</div>
        <table style="border-collapse:collapse;width:100%;margin-bottom:0.5rem;">${paramRows}</table>
      ` : ''}
      <div style="color:#484f58;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:0.2rem;">Example</div>
      <pre style="background:#0d1117;border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0.4rem 0.6rem;margin:0;color:#99C794;white-space:pre-wrap;">${this.esc(entry.example)}</pre>
    `
  }

  private renderEmpty(): void {
    this.content.innerHTML = `
      <div style="color:#484f58;text-align:center;padding:2rem 0;">
        Move cursor to a function to see help
      </div>
    `
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  dispose(): void {
    this.handle.remove()
    this.container.remove()
  }
}
