/**
 * Waveform scope — Sonic Pi-style oscilloscope with all 5 Desktop SP modes.
 *
 * Modes: mono, stereo, lissajous, mirror, spectrum
 * Features: phosphor trail persistence, glow effects, DPR-aware rendering.
 *
 * Matches Desktop SP's scope visualization as closely as browser Canvas 2D allows.
 */

type ScopeMode = 'mono' | 'stereo' | 'lissajous' | 'mirror' | 'spectrum'

const SCOPE_COLORS: Record<ScopeMode, string> = {
  mono: '#E8527C',       // pink
  stereo: '#5EBDAB',     // teal
  lissajous: '#C792EA',  // purple
  mirror: '#82AAFF',     // blue
  spectrum: '#FFCB6B',   // gold
}

/** Phosphor trail alpha — 0=no trail (instant clear), 1=full persistence.
 *  0.25 matches Sonic Tau's default (window._scopeTrail). */
const TRAIL_ALPHA = 0.25

export class Scope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private analyser: AnalyserNode | null = null
  private analyserL: AnalyserNode | null = null
  private analyserR: AnalyserNode | null = null
  private animFrame: number | null = null
  private dataMono: Uint8Array | null = null
  private dataL: Uint8Array | null = null
  private dataR: Uint8Array | null = null
  private freqData: Uint8Array | null = null
  private mode: ScopeMode = 'mono'
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
    this.modeBtn.textContent = 'mono'
    this.modeBtn.style.cssText = `
      background: none; border: 1px solid rgba(255,255,255,0.08);
      color: #666; font-family: inherit; font-size: 0.6rem;
      padding: 0.1rem 0.4rem; border-radius: 3px; cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    `
    this.modeBtn.addEventListener('click', () => this.cycleMode())
    this.modeBtn.addEventListener('mouseenter', () => {
      this.modeBtn.style.color = SCOPE_COLORS[this.mode]
      this.modeBtn.style.borderColor = SCOPE_COLORS[this.mode]
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

  connect(analyser: AnalyserNode, analyserL?: AnalyserNode, analyserR?: AnalyserNode): void {
    this.analyser = analyser
    this.analyserL = analyserL ?? null
    this.analyserR = analyserR ?? null
    this.dataMono = new Uint8Array(analyser.fftSize)
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    if (analyserL) this.dataL = new Uint8Array(analyserL.fftSize)
    if (analyserR) this.dataR = new Uint8Array(analyserR.fftSize)
    this.start()
  }

  disconnect(): void {
    this.analyser = null
    this.analyserL = null
    this.analyserR = null
    this.dataMono = null
    this.dataL = null
    this.dataR = null
    this.freqData = null
    this.stop()
    this.clear()
  }

  private cycleMode(): void {
    const modes: ScopeMode[] = ['mono', 'stereo', 'lissajous', 'mirror', 'spectrum']
    const idx = modes.indexOf(this.mode)
    this.mode = modes[(idx + 1) % modes.length]
    this.modeBtn.textContent = this.mode
    // Clear canvas on mode switch to avoid trail artifacts
    this.clear()
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
    const { canvas, ctx, analyser } = this
    if (!analyser) return

    const dpr = devicePixelRatio
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (cw === 0 || ch === 0) return
    canvas.width = cw * dpr
    canvas.height = ch * dpr
    const w = canvas.width
    const h = canvas.height

    // Fetch waveform data
    if (this.dataMono) analyser.getByteTimeDomainData(this.dataMono as Uint8Array<ArrayBuffer>)
    if (this.analyserL && this.dataL) this.analyserL.getByteTimeDomainData(this.dataL as Uint8Array<ArrayBuffer>)
    if (this.analyserR && this.dataR) this.analyserR.getByteTimeDomainData(this.dataR as Uint8Array<ArrayBuffer>)
    if (this.freqData) analyser.getByteFrequencyData(this.freqData as Uint8Array<ArrayBuffer>)

    // Phosphor trail: blend previous frame with semi-transparent background
    ctx.globalAlpha = 1 - TRAIL_ALPHA
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(0, 0, w, h)
    ctx.globalAlpha = 1.0

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2)
    ctx.moveTo(0, h / 4); ctx.lineTo(w, h / 4)
    ctx.moveTo(0, 3 * h / 4); ctx.lineTo(w, 3 * h / 4)
    ctx.stroke()

    switch (this.mode) {
      case 'mono': this.drawMono(w, h); break
      case 'stereo': this.drawStereo(w, h); break
      case 'mirror': this.drawMirror(w, h); break
      case 'lissajous': this.drawLissajous(w, h); break
      case 'spectrum': this.drawSpectrum(w, h); break
    }
  }

  /** Mono: single mixed waveform */
  private drawMono(w: number, h: number): void {
    const data = this.dataMono
    if (!data) return
    this.drawWaveform(data, w, h, 0, h, SCOPE_COLORS.mono, 2)
  }

  /** Stereo: separate L/R channels, top half = left, bottom half = right */
  private drawStereo(w: number, h: number): void {
    const dataL = this.dataL ?? this.dataMono
    const dataR = this.dataR ?? this.dataMono
    if (!dataL || !dataR) return

    // Divider line
    this.ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    this.ctx.lineWidth = 1
    this.ctx.beginPath()
    this.ctx.moveTo(0, h / 2)
    this.ctx.lineTo(w, h / 2)
    this.ctx.stroke()

    // Left channel (top half) — teal
    this.drawWaveform(dataL, w, h / 2, 0, h / 2, '#5EBDAB', 1.5)
    // Right channel (bottom half) — coral
    this.drawWaveform(dataR, w, h / 2, h / 2, h / 2, '#F78C6C', 1.5)
  }

  /** Mirror: reflected waveform around center axis */
  private drawMirror(w: number, h: number): void {
    const data = this.dataMono
    if (!data) return
    const { ctx } = this
    const mid = h / 2
    const color = SCOPE_COLORS.mirror
    const len = data.length
    const step = w / len

    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5 * devicePixelRatio

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

  /** Lissajous: true stereo phase plot (L=X, R=Y). Falls back to mono consecutive-sample if no stereo. */
  private drawLissajous(w: number, h: number): void {
    const { ctx } = this
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(cx, cy) * 0.85
    const color = SCOPE_COLORS.lissajous

    ctx.shadowColor = color
    ctx.shadowBlur = 6
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5 * devicePixelRatio
    ctx.beginPath()

    const dataX = this.dataL ?? this.dataMono
    const dataY = this.dataR ?? this.dataMono
    if (!dataX || !dataY) return

    const len = Math.min(dataX.length, dataY.length)

    if (this.dataL && this.dataR) {
      // True stereo lissajous: L=X, R=Y
      for (let i = 0; i < len; i++) {
        const x = cx + ((dataX[i] - 128) / 128) * radius
        const y = cy + ((dataY[i] - 128) / 128) * radius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    } else {
      // Mono fallback: consecutive samples as X,Y
      for (let i = 0; i < len - 1; i++) {
        const x = cx + ((dataX[i] - 128) / 128) * radius
        const y = cy + ((dataX[i + 1] - 128) / 128) * radius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    }

    ctx.stroke()
    ctx.shadowBlur = 0
  }

  /** Spectrum: frequency domain FFT bars */
  private drawSpectrum(w: number, h: number): void {
    const data = this.freqData
    if (!data) return
    const { ctx } = this
    const color = SCOPE_COLORS.spectrum

    // Use logarithmic frequency binning — 40 bars from ~40Hz to Nyquist
    const numBars = 40
    const barWidth = w / numBars - 1
    const sampleRate = this.analyser?.context?.sampleRate ?? 44100
    const binCount = data.length
    const nyquist = sampleRate / 2
    const minFreq = 40
    const maxFreq = nyquist

    ctx.shadowColor = color
    ctx.shadowBlur = 4

    for (let i = 0; i < numBars; i++) {
      // Logarithmic frequency mapping
      const freqLow = minFreq * Math.pow(maxFreq / minFreq, i / numBars)
      const freqHigh = minFreq * Math.pow(maxFreq / minFreq, (i + 1) / numBars)
      const binLow = Math.floor(freqLow / nyquist * binCount)
      const binHigh = Math.min(Math.ceil(freqHigh / nyquist * binCount), binCount - 1)

      // Average magnitude in this frequency band
      let sum = 0
      let count = 0
      for (let b = binLow; b <= binHigh; b++) {
        sum += data[b]
        count++
      }
      const magnitude = count > 0 ? sum / count / 255 : 0

      const barHeight = magnitude * h * 0.9
      const x = (w / numBars) * i
      const y = h - barHeight

      // Gradient from base color to bright
      const alpha = 0.4 + magnitude * 0.6
      ctx.fillStyle = `rgba(255, 203, 107, ${alpha})`
      ctx.fillRect(x, y, barWidth, barHeight)
    }

    ctx.shadowBlur = 0
  }

  /** Draw a waveform line in a specified vertical region */
  private drawWaveform(
    data: Uint8Array,
    w: number,
    regionH: number,
    offsetY: number,
    totalH: number,
    color: string,
    lineWidth: number,
  ): void {
    const { ctx } = this
    ctx.shadowColor = color
    ctx.shadowBlur = 8
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth * devicePixelRatio
    ctx.beginPath()

    const len = data.length
    const step = w / len
    for (let i = 0; i < len; i++) {
      const y = offsetY + (data[i] / 255) * regionH
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(i * step, y)
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
