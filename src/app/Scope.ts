/**
 * Waveform scope — Sonic Pi-style oscilloscope with mode toggle.
 * Supports: scope (waveform), mirror (reflected), and lissajous modes.
 */

type ScopeMode = 'scope' | 'mirror' | 'lissajous'

export class Scope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private analyser: AnalyserNode | null = null
  private animFrame: number | null = null
  private data: Uint8Array | null = null
  private mode: ScopeMode = 'scope'
  private header: HTMLElement
  private modeBtn: HTMLButtonElement
  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    container.style.cssText += '; display: flex; flex-direction: column;'

    // Header with title and mode toggle
    this.header = document.createElement('div')
    this.header.style.cssText = `
      padding: 0.3rem 0.6rem;
      font-size: 0.65rem;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    `
    const title = document.createElement('span')
    title.textContent = 'Scope'
    this.header.appendChild(title)

    this.modeBtn = document.createElement('button')
    this.modeBtn.textContent = 'scope'
    this.modeBtn.style.cssText = `
      background: none; border: 1px solid rgba(255,255,255,0.08);
      color: #666; font-family: inherit; font-size: 0.6rem;
      padding: 0.1rem 0.4rem; border-radius: 3px; cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    `
    this.modeBtn.addEventListener('click', () => this.cycleMode())
    this.modeBtn.addEventListener('mouseenter', () => {
      this.modeBtn.style.color = '#E8527C'
      this.modeBtn.style.borderColor = '#E8527C'
    })
    this.modeBtn.addEventListener('mouseleave', () => {
      this.modeBtn.style.color = '#666'
      this.modeBtn.style.borderColor = 'rgba(255,255,255,0.08)'
    })
    this.header.appendChild(this.modeBtn)
    container.appendChild(this.header)

    // Canvas
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'flex: 1; width: 100%; min-height: 0;'
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    this.clear()
  }

  connect(analyser: AnalyserNode): void {
    this.analyser = analyser
    this.data = new Uint8Array(analyser.fftSize)
    this.start()
  }

  disconnect(): void {
    this.analyser = null
    this.data = null
    this.stop()
    this.clear()
  }

  private cycleMode(): void {
    const modes: ScopeMode[] = ['scope', 'mirror', 'lissajous']
    const idx = modes.indexOf(this.mode)
    this.mode = modes[(idx + 1) % modes.length]
    this.modeBtn.textContent = this.mode
  }

  private start(): void {
    if (this.animFrame) return
    const draw = () => {
      this.animFrame = requestAnimationFrame(draw)
      this.render()
    }
    draw()
  }

  private stop(): void {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame)
      this.animFrame = null
    }
  }

  private render(): void {
    const { canvas, ctx, analyser, data } = this
    if (!analyser || !data) return

    const dpr = devicePixelRatio
    const w = canvas.width = canvas.clientWidth * dpr
    const h = canvas.height = canvas.clientHeight * dpr

    analyser.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>)

    // Background
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2) // center
    ctx.moveTo(0, h / 4); ctx.lineTo(w, h / 4)
    ctx.moveTo(0, 3 * h / 4); ctx.lineTo(w, 3 * h / 4)
    ctx.stroke()

    switch (this.mode) {
      case 'scope': this.drawScope(w, h); break
      case 'mirror': this.drawMirror(w, h); break
      case 'lissajous': this.drawLissajous(w, h); break
    }
  }

  private drawScope(w: number, h: number): void {
    const { ctx, data } = this
    if (!data) return

    // Glow effect
    ctx.shadowColor = '#E8527C'
    ctx.shadowBlur = 8
    ctx.strokeStyle = '#E8527C'
    ctx.lineWidth = 2 * devicePixelRatio
    ctx.beginPath()

    const len = data.length
    const step = w / len
    for (let i = 0; i < len; i++) {
      const y = (data[i] / 255) * h
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * step, y)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  private drawMirror(w: number, h: number): void {
    const { ctx, data } = this
    if (!data) return

    const mid = h / 2

    ctx.shadowColor = '#5EBDAB'
    ctx.shadowBlur = 6
    ctx.strokeStyle = '#5EBDAB'
    ctx.lineWidth = 1.5 * devicePixelRatio

    const len = data.length
    const step = w / len

    // Top half
    ctx.beginPath()
    for (let i = 0; i < len; i++) {
      const v = (data[i] - 128) / 128
      const y = mid - Math.abs(v) * mid
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * step, y)
    }
    ctx.stroke()

    // Bottom half (mirror)
    ctx.beginPath()
    for (let i = 0; i < len; i++) {
      const v = (data[i] - 128) / 128
      const y = mid + Math.abs(v) * mid
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * step, y)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  private drawLissajous(w: number, h: number): void {
    const { ctx, data } = this
    if (!data) return

    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(cx, cy) * 0.85

    ctx.shadowColor = '#C792EA'
    ctx.shadowBlur = 6
    ctx.strokeStyle = '#C792EA'
    ctx.lineWidth = 1.5 * devicePixelRatio
    ctx.beginPath()

    const len = data.length
    for (let i = 0; i < len - 1; i++) {
      const x = cx + ((data[i] - 128) / 128) * radius
      const y = cy + ((data[i + 1] - 128) / 128) * radius
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  clear(): void {
    const dpr = devicePixelRatio
    const w = this.canvas.width = this.canvas.clientWidth * dpr
    const h = this.canvas.height = this.canvas.clientHeight * dpr
    this.ctx.fillStyle = '#0d1117'
    this.ctx.fillRect(0, 0, w, h)
  }

  dispose(): void {
    this.stop()
    this.canvas.remove()
    this.header.remove()
  }
}
