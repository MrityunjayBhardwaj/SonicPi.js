/**
 * Toolbar — Sonic Pi-style toolbar with Run/Stop, buffer tabs, volume.
 */

import { examples, type Example } from '../engine/examples'

export interface ToolbarCallbacks {
  onPlay: () => void
  onStop: () => void
  onExample: (example: Example) => void
  onBufferSelect: (index: number) => void
  onVolumeChange: (vol: number) => void
}

const BUFFER_COUNT = 10

export class Toolbar {
  private el: HTMLElement
  private playBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private bufferBtns: HTMLButtonElement[] = []
  private activeBuffer = 0
  private playing = false

  constructor(container: HTMLElement, private callbacks: ToolbarCallbacks) {
    this.el = document.createElement('div')
    this.el.className = 'spw-toolbar'
    container.appendChild(this.el)

    // Top row: main controls
    const topRow = this.createRow()
    topRow.style.borderBottom = '1px solid rgba(255,255,255,0.06)'

    // Logo
    const logo = document.createElement('div')
    logo.style.cssText = `
      display: flex; align-items: center; gap: 0.5rem;
      margin-right: 1rem; user-select: none;
    `
    const logoIcon = document.createElement('span')
    logoIcon.textContent = '\u266B'
    logoIcon.style.cssText = `
      font-size: 1.3rem; color: #E8527C;
      text-shadow: 0 0 12px rgba(232,82,124,0.4);
    `
    const logoText = document.createElement('span')
    logoText.textContent = 'Sonic Pi'
    logoText.style.cssText = `
      font-weight: 700; font-size: 0.95rem; color: #ddd;
      letter-spacing: 0.5px;
    `
    const logoSub = document.createElement('span')
    logoSub.textContent = 'Web'
    logoSub.style.cssText = `
      font-size: 0.65rem; color: #666; font-weight: 400;
      margin-left: 0.2rem; letter-spacing: 1px; text-transform: uppercase;
    `
    logo.append(logoIcon, logoText, logoSub)
    topRow.appendChild(logo)

    // Separator
    topRow.appendChild(this.separator())

    // Run button
    this.playBtn = this.iconButton(
      '\u25B6', 'Run',
      () => this.callbacks.onPlay(),
      { bg: '#2D8B4E', hover: '#34a058' }
    )
    this.playBtn.title = 'Run (Ctrl+Enter)'
    topRow.appendChild(this.playBtn)

    // Stop button
    this.stopBtn = this.iconButton(
      '\u25A0', 'Stop',
      () => this.callbacks.onStop(),
      { bg: '#555', hover: '#777' }
    )
    this.stopBtn.title = 'Stop (Esc)'
    this.stopBtn.style.opacity = '0.4'
    topRow.appendChild(this.stopBtn)

    topRow.appendChild(this.separator())

    // Volume
    const volWrap = document.createElement('div')
    volWrap.style.cssText = 'display: flex; align-items: center; gap: 0.3rem;'
    const volIcon = document.createElement('span')
    volIcon.textContent = '\u{1F50A}'
    volIcon.style.cssText = 'font-size: 0.7rem; color: #888;'
    const volSlider = document.createElement('input')
    volSlider.type = 'range'
    volSlider.min = '0'
    volSlider.max = '100'
    volSlider.value = '80'
    volSlider.style.cssText = `
      width: 70px; height: 3px; accent-color: #E8527C;
      cursor: pointer;
    `
    volSlider.addEventListener('input', () => {
      this.callbacks.onVolumeChange(parseInt(volSlider.value) / 100)
    })
    volWrap.append(volIcon, volSlider)
    topRow.appendChild(volWrap)

    // Spacer
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    topRow.appendChild(spacer)

    // Example selector
    const select = document.createElement('select')
    select.style.cssText = `
      background: rgba(255,255,255,0.05);
      color: #999;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
      padding: 0.25rem 0.5rem;
      font-family: inherit;
      font-size: 0.7rem;
      cursor: pointer;
      outline: none;
    `
    const defaultOpt = document.createElement('option')
    defaultOpt.textContent = 'Load Example...'
    defaultOpt.value = ''
    select.appendChild(defaultOpt)
    for (const ex of examples) {
      const opt = document.createElement('option')
      opt.value = ex.name
      opt.textContent = ex.name
      select.appendChild(opt)
    }
    select.addEventListener('change', () => {
      const ex = examples.find(e => e.name === select.value)
      if (ex) {
        this.callbacks.onExample(ex)
        select.value = ''
      }
    })
    topRow.appendChild(select)

    // Bottom row: buffer tabs
    const bufRow = this.createRow()
    bufRow.style.padding = '0 0.75rem'
    bufRow.style.gap = '0'

    for (let i = 0; i < BUFFER_COUNT; i++) {
      const btn = document.createElement('button')
      btn.textContent = `${i}`
      btn.title = `Buffer ${i}`
      btn.style.cssText = `
        padding: 0.3rem 0.65rem;
        border: none;
        background: transparent;
        color: ${i === 0 ? '#E8527C' : '#555'};
        font-family: inherit;
        font-size: 0.7rem;
        font-weight: ${i === 0 ? '700' : '400'};
        cursor: pointer;
        border-bottom: 2px solid ${i === 0 ? '#E8527C' : 'transparent'};
        transition: color 0.15s, border-color 0.15s;
      `
      btn.addEventListener('click', () => this.selectBuffer(i))
      btn.addEventListener('mouseenter', () => {
        if (i !== this.activeBuffer) btn.style.color = '#999'
      })
      btn.addEventListener('mouseleave', () => {
        if (i !== this.activeBuffer) btn.style.color = '#555'
      })
      bufRow.appendChild(btn)
      this.bufferBtns.push(btn)
    }
  }

  setPlaying(playing: boolean): void {
    this.playing = playing
    this.playBtn.style.background = playing ? '#3a6ea5' : '#2D8B4E'
    const label = this.playBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = playing ? 'Update' : 'Run'
    this.stopBtn.style.opacity = playing ? '1' : '0.4'
  }

  private selectBuffer(index: number): void {
    this.bufferBtns[this.activeBuffer].style.color = '#555'
    this.bufferBtns[this.activeBuffer].style.fontWeight = '400'
    this.bufferBtns[this.activeBuffer].style.borderBottomColor = 'transparent'

    this.activeBuffer = index
    this.bufferBtns[index].style.color = '#E8527C'
    this.bufferBtns[index].style.fontWeight = '700'
    this.bufferBtns[index].style.borderBottomColor = '#E8527C'

    this.callbacks.onBufferSelect(index)
  }

  private createRow(): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.75rem;
    `
    this.el.appendChild(row)
    return row
  }

  private separator(): HTMLElement {
    const sep = document.createElement('div')
    sep.style.cssText = `
      width: 1px; height: 20px;
      background: rgba(255,255,255,0.08);
      margin: 0 0.25rem;
    `
    return sep
  }

  private iconButton(
    icon: string,
    label: string,
    onClick: () => void,
    colors: { bg: string; hover: string }
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.style.cssText = `
      display: flex; align-items: center; gap: 0.35rem;
      padding: 0.3rem 0.75rem;
      border: none;
      border-radius: 5px;
      background: ${colors.bg};
      color: #fff;
      font-family: inherit;
      font-size: 0.75rem;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      user-select: none;
    `
    const iconEl = document.createElement('span')
    iconEl.textContent = icon
    iconEl.style.fontSize = '0.6rem'
    const labelEl = document.createElement('span')
    labelEl.className = 'spw-btn-label'
    labelEl.textContent = label
    btn.append(iconEl, labelEl)

    btn.addEventListener('mouseenter', () => { btn.style.background = colors.hover })
    btn.addEventListener('mouseleave', () => { btn.style.background = colors.bg })
    btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.96)' })
    btn.addEventListener('mouseup', () => { btn.style.transform = '' })
    btn.addEventListener('click', onClick)
    return btn
  }

  dispose(): void {
    this.el.remove()
  }
}
