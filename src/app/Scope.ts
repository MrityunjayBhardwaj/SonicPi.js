/**
 * Waveform scope — Sonic Pi-style oscilloscope with all 5 Desktop SP modes.
 *
 * Modes: mono, stereo, lissajous, mirror, spectrum
 * Supports multiple simultaneous modes (like Desktop SP).
 * Features: phosphor trail persistence, glow effects, DPR-aware rendering.
 */

export type ScopeMode = 'mono' | 'stereo' | 'lissajous' | 'mirror' | 'spectrum'

export const ALL_SCOPE_MODES: ScopeMode[] = ['mono', 'stereo', 'lissajous', 'mirror', 'spectrum']

const SCOPE_COLORS: Record<ScopeMode, string> = {
  mono: '#E8527C',
  stereo: '#5EBDAB',
  lissajous: '#C792EA',
  mirror: '#82AAFF',
  spectrum: '#FF00FF',
}

const SCOPE_LABELS: Record<ScopeMode, string> = {
  mono: 'Mono',
  stereo: 'Stereo',
  lissajous: 'Lissajous',
  mirror: 'Mirror',
  spectrum: 'Spectrum',
}

/** Phosphor trail alpha — 0=no trail, 1=full persistence. Matches Sonic Tau. */
const DEFAULT_TRAIL_ALPHA = 0.25

export class Scope {
  private canvases = new Map<ScopeMode, HTMLCanvasElement>()
  private analyser: AnalyserNode | null = null
  private analyserL: AnalyserNode | null = null
  private analyserR: AnalyserNode | null = null
  private animFrame: number | null = null
  private dataMono: Uint8Array | null = null
  private dataL: Uint8Array | null = null
  private dataR: Uint8Array | null = null
  private freqData: Uint8Array | null = null
  private activeModes: Set<ScopeMode> = new Set(['mono'])
  private container: HTMLElement
  private canvasContainer: HTMLElement

  // Configurable visual parameters (set via Prefs panel)
  private _lineWidth = 2
  private _glow = 4
  private _trail = DEFAULT_TRAIL_ALPHA
  private _hueShift = 0

  constructor(container: HTMLElement) {
    this.container = container
    container.style.cssText += '; display: flex; flex-direction: column;'

    // Canvas container — holds all active scope canvases stacked
    this.canvasContainer = document.createElement('div')
    this.canvasContainer.style.cssText = 'flex: 1; display: flex; flex-direction: column; min-height: 0; gap: 1px;'
    container.appendChild(this.canvasContainer)

    this.rebuildCanvases()
  }

  /** Get currently active modes */
  getActiveModes(): Set<ScopeMode> {
    return new Set(this.activeModes)
  }

  /** Toggle a scope mode on/off */
  toggleMode(mode: ScopeMode): void {
    if (this.activeModes.has(mode)) {
      // Don't allow disabling ALL modes — keep at least one
      if (this.activeModes.size > 1) {
        this.activeModes.delete(mode)
      }
    } else {
      this.activeModes.add(mode)
    }
    this.rebuildCanvases()
  }

  /** Set exactly which modes are active */
  setModes(modes: ScopeMode[]): void {
    this.activeModes = new Set(modes.length > 0 ? modes : ['mono'])
    this.rebuildCanvases()
  }

  /** Set waveform line width (1-6). */
  setLineWidth(w: number): void { this._lineWidth = w }

  /** Set glow/shadow blur radius (0-20). */
  setGlow(blur: number): void { this._glow = blur }

  /** Set trail persistence (0-0.95). 0=no trail, 0.95=long persistence. */
  setTrail(alpha: number): void { this._trail = alpha }

  /** Set hue shift in degrees (0-360). Rotates all scope colors. */
  setHueShift(deg: number): void { this._hueShift = deg }

  /** Get current visual parameters. */
  getVisualParams(): { lineWidth: number; glow: number; trail: number; hueShift: number } {
    return { lineWidth: this._lineWidth, glow: this._glow, trail: this._trail, hueShift: this._hueShift }
  }

  rebuildCanvases(): void {
    // Clear everything — canvases AND their wrapper divs
    this.canvases.clear()
    this.canvasContainer.innerHTML = ''

    // Create canvas per active mode
    for (const mode of ALL_SCOPE_MODES) {
      if (!this.activeModes.has(mode)) continue
      const wrapper = document.createElement('div')
      wrapper.style.cssText = 'flex: 1; min-height: 0; position: relative;'

      const label = document.createElement('span')
      label.textContent = SCOPE_LABELS[mode]
      label.style.cssText = `
        position: absolute; top: 2px; right: 6px; z-index: 1;
        font-size: 0.5rem; color: ${SCOPE_COLORS[mode]}; opacity: 0.5;
        font-family: inherit; text-transform: uppercase; letter-spacing: 1px;
        pointer-events: none;
      `
      wrapper.appendChild(label)

      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width: 100%; height: 100%;'
      wrapper.appendChild(canvas)
      this.canvasContainer.appendChild(wrapper)
      this.canvases.set(mode, canvas)
    }
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
    this.clearAll()
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
    if (!this.analyser) return

    // Fetch data once, shared across all canvases
    if (this.dataMono) this.analyser.getByteTimeDomainData(this.dataMono as Uint8Array<ArrayBuffer>)
    if (this.analyserL && this.dataL) this.analyserL.getByteTimeDomainData(this.dataL as Uint8Array<ArrayBuffer>)
    if (this.analyserR && this.dataR) this.analyserR.getByteTimeDomainData(this.dataR as Uint8Array<ArrayBuffer>)
    if (this.freqData) this.analyser.getByteFrequencyData(this.freqData as Uint8Array<ArrayBuffer>)

    for (const [mode, canvas] of this.canvases) {
      const dpr = devicePixelRatio
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      if (cw === 0 || ch === 0) continue
      canvas.width = cw * dpr
      canvas.height = ch * dpr
      const w = canvas.width
      const h = canvas.height
      const ctx = canvas.getContext('2d')!

      // Phosphor trail
      ctx.globalAlpha = 1 - this._trail
      ctx.fillStyle = '#0d1117'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1.0

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2)
      ctx.stroke()

      switch (mode) {
        case 'mono': this.drawMono(ctx, w, h); break
        case 'stereo': this.drawStereo(ctx, w, h); break
        case 'mirror': this.drawMirror(ctx, w, h); break
        case 'lissajous': this.drawLissajous(ctx, w, h); break
        case 'spectrum': this.drawSpectrum(ctx, w, h); break
      }
    }
  }

  /** Apply hue shift to a hex color. Returns CSS hsl() string if shifted, original if 0. */
  private shiftColor(hex: string): string {
    if (this._hueShift === 0) return hex
    // Parse hex → RGB → HSL, shift hue, return hsl()
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    const l = (max + min) / 2
    let h = 0, s = 0
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
      else if (max === g) h = ((b - r) / d + 2) / 6
      else h = ((r - g) / d + 4) / 6
    }
    const newH = ((h * 360 + this._hueShift) % 360 + 360) % 360
    return `hsl(${newH}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`
  }

  private drawMono(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.dataMono) return
    this.drawWaveform(ctx, this.dataMono, w, h, 0, h, this.shiftColor(SCOPE_COLORS.mono), this._lineWidth)
  }

  private drawStereo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const dataL = this.dataL ?? this.dataMono
    const dataR = this.dataR ?? this.dataMono
    if (!dataL || !dataR) return

    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2)
    ctx.stroke()

    this.drawWaveform(ctx, dataL, w, h / 2, 0, h / 2, this.shiftColor('#5EBDAB'), this._lineWidth * 0.75)
    this.drawWaveform(ctx, dataR, w, h / 2, h / 2, h / 2, this.shiftColor('#F78C6C'), this._lineWidth * 0.75)
  }

  private drawMirror(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const data = this.dataMono
    if (!data) return
    const mid = h / 2
    const color = this.shiftColor(SCOPE_COLORS.mirror)
    const len = data.length
    const step = w / len

    ctx.shadowColor = color
    ctx.shadowBlur = this._glow
    ctx.strokeStyle = color
    ctx.lineWidth = this._lineWidth * 0.75 * devicePixelRatio

    ctx.beginPath()
    for (let i = 0; i < len; i++) {
      const v = (data[i] - 128) / 128
      if (i === 0) ctx.moveTo(0, mid - Math.abs(v) * mid)
      else ctx.lineTo(i * step, mid - Math.abs(v) * mid)
    }
    ctx.stroke()

    ctx.beginPath()
    for (let i = 0; i < len; i++) {
      const v = (data[i] - 128) / 128
      if (i === 0) ctx.moveTo(0, mid + Math.abs(v) * mid)
      else ctx.lineTo(i * step, mid + Math.abs(v) * mid)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  private drawLissajous(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(cx, cy) * 0.85
    const color = this.shiftColor(SCOPE_COLORS.lissajous)

    ctx.shadowColor = color
    ctx.shadowBlur = this._glow
    ctx.strokeStyle = color
    ctx.lineWidth = this._lineWidth * 0.75 * devicePixelRatio
    ctx.beginPath()

    const dataX = this.dataL ?? this.dataMono
    const dataY = this.dataR ?? this.dataMono
    if (!dataX || !dataY) return

    const len = Math.min(dataX.length, dataY.length)
    if (this.dataL && this.dataR) {
      for (let i = 0; i < len; i++) {
        const x = cx + ((dataX[i] - 128) / 128) * radius
        const y = cy + ((dataY[i] - 128) / 128) * radius
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
    } else {
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

  private drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const data = this.freqData
    if (!data) return
    const color = SCOPE_COLORS.spectrum
    const numBars = 40
    const barWidth = w / numBars - 1
    const sampleRate = this.analyser?.context?.sampleRate ?? 44100
    const binCount = data.length
    const nyquist = sampleRate / 2

    ctx.shadowBlur = this._glow

    for (let i = 0; i < numBars; i++) {
      const freqLow = 40 * Math.pow(nyquist / 40, i / numBars)
      const freqHigh = 40 * Math.pow(nyquist / 40, (i + 1) / numBars)
      const binLow = Math.floor(freqLow / nyquist * binCount)
      const binHigh = Math.min(Math.ceil(freqHigh / nyquist * binCount), binCount - 1)

      let sum = 0, count = 0
      for (let b = binLow; b <= binHigh; b++) { sum += data[b]; count++ }
      const mag = count > 0 ? sum / count / 255 : 0

      // Gradient: magenta (#FF00FF) → superman blue (#0099FF)
      const t = i / numBars
      const r = Math.round(255 - t * 255)
      const g = Math.round(t * 153)
      const b2 = 255
      ctx.shadowColor = `rgb(${r}, ${g}, ${b2})`
      ctx.fillStyle = `rgba(${r}, ${g}, ${b2}, ${0.4 + mag * 0.6})`

      const barH = mag * h * 0.9
      const x = (w / numBars) * i
      ctx.fillRect(x, h - barH, barWidth, barH)
    }
    ctx.shadowBlur = 0
  }

  private drawWaveform(
    ctx: CanvasRenderingContext2D,
    data: Uint8Array, w: number, regionH: number,
    offsetY: number, _totalH: number,
    color: string, lineWidth: number,
  ): void {
    ctx.shadowColor = color
    ctx.shadowBlur = this._glow
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

  clearAll(): void {
    for (const canvas of this.canvases.values()) {
      const dpr = devicePixelRatio
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#0d1117'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }

  dispose(): void {
    this.stop()
    this.canvasContainer.remove()
  }
}
