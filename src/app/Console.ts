/**
 * Console / log pane — Sonic Pi-style log with run counters and timestamps.
 */

export type LogLevel = 'info' | 'error' | 'event' | 'system' | 'cue'

interface LogEntry {
  level: LogLevel
  text: string
  time: number
  run?: number
  beat?: number
}

const MAX_ENTRIES = 500

export class Console {
  private el: HTMLElement
  private header: HTMLElement
  private body: HTMLElement
  private entries: LogEntry[] = []
  private autoScroll = true
  private runCount = 0
  private startTime = 0

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
    this.header.innerHTML = '<span>Log</span>'

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
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.color = '#E8527C' })
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
    this.startTime = performance.now()
  }

  private elapsed(): string {
    const ms = performance.now() - this.startTime
    return (ms / 1000).toFixed(4)
  }

  log(text: string, level: LogLevel = 'info'): void {
    const entry: LogEntry = { level, text, time: Date.now(), run: this.runCount }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES)
      this.rebuild()
      return
    }
    this.appendLine(entry)
  }

  logEvent(type: string, detail: string): void {
    this.log(`${detail}`, 'event')
  }

  logError(title: string, message: string): void {
    this.log(`${title}\n${message}`, 'error')
  }

  logSystem(text: string): void {
    this.log(text, 'system')
  }

  logCue(name: string): void {
    this.log(`cue :${name}`, 'cue')
  }

  clear(): void {
    this.entries = []
    this.body.innerHTML = ''
  }

  private appendLine(entry: LogEntry): void {
    const line = document.createElement('div')
    line.style.cssText = `
      padding: 0.1rem 0.6rem;
      display: flex;
      gap: 0.5rem;
      border-left: 2px solid transparent;
    `

    // Run/time prefix (Sonic Pi style)
    if (entry.level !== 'system') {
      const prefix = document.createElement('span')
      prefix.style.cssText = `
        color: #444; font-size: 0.65rem; min-width: 9ch;
        flex-shrink: 0; user-select: none;
      `
      prefix.textContent = `{run:${entry.run}, t:${this.elapsed()}}`
      line.appendChild(prefix)
    }

    const content = document.createElement('span')
    content.style.cssText = 'white-space: pre-wrap; word-break: break-word;'

    switch (entry.level) {
      case 'event':
        content.style.color = '#5EBDAB'
        line.style.borderLeftColor = '#5EBDAB33'
        break
      case 'error':
        content.style.color = '#E8527C'
        line.style.background = 'rgba(232,82,124,0.05)'
        line.style.borderLeftColor = '#E8527C'
        break
      case 'cue':
        content.style.color = '#C792EA'
        line.style.borderLeftColor = '#C792EA33'
        break
      case 'system':
        content.style.color = '#555'
        content.style.fontStyle = 'italic'
        content.style.padding = '0 0.6rem'
        break
      default:
        content.style.color = '#8892B0'
        break
    }

    content.textContent = entry.text
    line.appendChild(content)
    this.body.appendChild(line)

    if (this.autoScroll) {
      this.body.scrollTop = this.body.scrollHeight
    }
  }

  private rebuild(): void {
    this.body.innerHTML = ''
    for (const entry of this.entries) {
      this.appendLine(entry)
    }
  }

  dispose(): void {
    this.el.remove()
  }
}
