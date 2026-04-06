/**
 * CueLog — Dedicated panel for cue/sync events with timestamps.
 * Mirrors Desktop Sonic Pi's separate cue log window.
 */

interface CueEntry {
  name: string
  run: number
  time: number
}

const MAX_ENTRIES = 200

export class CueLog {
  private el: HTMLElement
  private header: HTMLElement
  private body: HTMLElement
  private entries: CueEntry[] = []
  private autoScroll = true
  private runCount = 0
  private pendingEntries: CueEntry[] = []
  private rafScheduled = false

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.style.cssText = `
      height: 100%; display: flex; flex-direction: column;
      background: #151520; overflow: hidden;
    `
    container.appendChild(this.el)

    // Header
    this.header = document.createElement('div')
    this.header.style.cssText = `
      padding: 0.35rem 0.6rem;
      font-size: 0.65rem;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    `
    this.header.innerHTML = '<span>Cue Log</span>'

    // Clear button
    const clearBtn = document.createElement('button')
    clearBtn.textContent = 'Clear'
    clearBtn.style.cssText = `
      background: none; border: none; color: #555;
      font-family: inherit; font-size: 0.6rem; cursor: pointer;
      padding: 0.1rem 0.4rem; border-radius: 3px;
      transition: color 0.15s;
    `
    clearBtn.addEventListener('click', () => this.clear())
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.color = '#C792EA' })
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.color = '#555' })
    this.header.appendChild(clearBtn)
    this.el.appendChild(this.header)

    // Body
    this.body = document.createElement('div')
    this.body.style.cssText = `
      flex: 1; overflow-y: auto; overflow-x: hidden;
      font-family: inherit; font-size: 0.72rem;
      line-height: 1.5; padding: 0.3rem 0;
      scrollbar-width: thin;
      scrollbar-color: #333 transparent;
    `
    this.el.appendChild(this.body)

    this.body.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.body
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 30
    })
  }

  /** Called when Run is pressed — increments the run counter. */
  newRun(): void {
    this.runCount++
  }

  logCue(name: string, run: number, time: number): void {
    const entry: CueEntry = { name, run, time }
    this.entries.push(entry)
    this.trimIfNeeded()
    this.scheduleFlush(entry)
  }

  clear(): void {
    this.entries = []
    this.pendingEntries.length = 0
    this.body.innerHTML = ''
  }

  getElement(): HTMLElement {
    return this.el
  }

  private trimIfNeeded(): void {
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
      if (this.body.firstChild) {
        this.body.removeChild(this.body.firstChild)
      }
    }
  }

  private scheduleFlush(entry: CueEntry): void {
    this.pendingEntries.push(entry)
    if (!this.rafScheduled) {
      this.rafScheduled = true
      requestAnimationFrame(() => {
        this.rafScheduled = false
        const fragment = document.createDocumentFragment()
        for (const e of this.pendingEntries) {
          fragment.appendChild(this.createLine(e))
        }
        this.body.appendChild(fragment)
        this.pendingEntries.length = 0
        if (this.autoScroll) {
          this.body.scrollTop = this.body.scrollHeight
        }
      })
    }
  }

  private createLine(entry: CueEntry): HTMLDivElement {
    const line = document.createElement('div')
    line.style.cssText = `
      padding: 0.1rem 0.6rem;
      display: flex;
      gap: 0.5rem;
      border-left: 2px solid #C792EA33;
    `

    const prefix = document.createElement('span')
    prefix.style.cssText = `
      color: #444; font-size: 0.65rem; min-width: 9ch;
      flex-shrink: 0;
    `
    prefix.textContent = `{run:${entry.run}, t:${(entry.time / 1000).toFixed(4)}}`
    line.appendChild(prefix)

    const content = document.createElement('span')
    content.style.cssText = `
      white-space: pre-wrap; word-break: break-word;
      color: #C792EA;
    `
    content.textContent = `cue :${entry.name}`
    line.appendChild(content)
    return line
  }

  dispose(): void {
    this.el.remove()
  }
}
