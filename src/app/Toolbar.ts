/**
 * Toolbar — Sonic Pi-style toolbar with Run/Stop, buffer tabs, volume.
 */

import { examples, getExamplesByDifficulty, type Example } from '../engine/examples'
import { theme } from './theme'

export interface MidiDeviceInfo {
  id: string
  name: string
  type: 'input' | 'output'
  selected: boolean
}

export interface ToolbarCallbacks {
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onExample: (example: Example) => void
  onBufferSelect: (index: number) => void
  onVolumeChange: (vol: number) => void
  onMidiDeviceToggle?: (deviceId: string, type: 'input' | 'output', selected: boolean) => void
  getMidiDevices?: () => MidiDeviceInfo[]
  onOpenSampleBrowser?: () => void
  onFontSizeChange?: (delta: number) => void
  onSave?: () => void
  onLoad?: () => void
  onZen?: () => void
}

const BUFFER_COUNT = 10

export class Toolbar {
  private el: HTMLElement
  private topRow!: HTMLElement
  private bufRow!: HTMLElement
  private playBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private recBtn: HTMLButtonElement
  private bufferBtns: HTMLButtonElement[] = []
  private activeBuffer = 0
  private playing = false
  private recording = false
  private bpmLabel: HTMLElement
  private midiDropdown: HTMLElement | null = null
  private midiOutsideClickHandler: ((e: MouseEvent) => void) | null = null

  constructor(container: HTMLElement, private callbacks: ToolbarCallbacks) {
    this.el = document.createElement('div')
    this.el.className = 'spw-toolbar'
    container.appendChild(this.el)

    // Top row: main controls
    this.topRow = this.createRow()
    const topRow = this.topRow
    topRow.style.borderBottom = `1px solid ${theme.border}`

    // Logo
    const logo = document.createElement('div')
    logo.style.cssText = `
      display: flex; align-items: center; gap: 0.5rem;
      margin-right: 1rem; user-select: none;
    `
    const logoIcon = document.createElement('span')
    logoIcon.textContent = '\u266B'
    logoIcon.style.cssText = `
      font-size: 1.3rem; color: ${theme.accent};
      text-shadow: 0 0 12px ${theme.accentHover};
    `
    const logoText = document.createElement('span')
    logoText.textContent = 'Sonic Pi'
    logoText.style.cssText = `
      font-weight: 700; font-size: 0.95rem; color: ${theme.fg};
      letter-spacing: 0.5px;
    `
    const logoSub = document.createElement('span')
    logoSub.textContent = 'Web'
    logoSub.style.cssText = `
      font-size: 0.65rem; color: ${theme.comment}; font-weight: 400;
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
      { bg: theme.success, hover: theme.green }
    )
    this.playBtn.title = 'Run (Ctrl+Enter)'
    topRow.appendChild(this.playBtn)

    // Stop button
    this.stopBtn = this.iconButton(
      '\u25A0', 'Stop',
      () => this.callbacks.onStop(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    this.stopBtn.title = 'Stop (Esc)'
    this.stopBtn.style.opacity = '0.4'
    topRow.appendChild(this.stopBtn)

    // Record button
    this.recBtn = this.iconButton(
      '\u23FA', 'Rec',
      () => this.callbacks.onRecord(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    this.recBtn.title = 'Record to WAV'
    this.recBtn.style.opacity = '0.4'
    topRow.appendChild(this.recBtn)

    topRow.appendChild(this.separator())

    // Save button
    const saveBtn = this.iconButton(
      '\u{1F4BE}', 'Save',
      () => this.callbacks.onSave?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    saveBtn.title = 'Save buffer to file'
    saveBtn.style.opacity = '0.7'
    topRow.appendChild(saveBtn)

    // Load button
    const loadBtn = this.iconButton(
      '\u{1F4C2}', 'Load',
      () => this.callbacks.onLoad?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    loadBtn.title = 'Load file into buffer'
    loadBtn.style.opacity = '0.7'
    topRow.appendChild(loadBtn)

    topRow.appendChild(this.separator())

    // Volume
    const volWrap = document.createElement('div')
    volWrap.style.cssText = 'display: flex; align-items: center; gap: 0.3rem;'
    const volIcon = document.createElement('span')
    volIcon.textContent = '\u{1F50A}'
    volIcon.style.cssText = 'font-size: 0.7rem; color: ${theme.fgMuted};'
    const volSlider = document.createElement('input')
    volSlider.type = 'range'
    volSlider.min = '0'
    volSlider.max = '100'
    volSlider.value = '80'
    volSlider.style.cssText = `
      width: 70px; height: 3px; accent-color: ${theme.accent};
      cursor: pointer;
    `
    volSlider.addEventListener('input', () => {
      this.callbacks.onVolumeChange(parseInt(volSlider.value) / 100)
    })
    volWrap.append(volIcon, volSlider)
    topRow.appendChild(volWrap)

    // BPM display
    this.bpmLabel = document.createElement('span')
    this.bpmLabel.style.cssText = `
      font-size: 0.7rem; color: ${theme.fgMuted};
      user-select: none; white-space: nowrap;
      margin-left: 0.25rem;
    `
    this.bpmLabel.textContent = '120 BPM'
    topRow.appendChild(this.bpmLabel)

    topRow.appendChild(this.separator())

    // Font size buttons
    const fontWrap = document.createElement('div')
    fontWrap.style.cssText = 'display: flex; align-items: center; gap: 0.15rem;'
    const fontDown = document.createElement('button')
    fontDown.textContent = 'A\u2212'
    fontDown.title = 'Decrease font size'
    fontDown.style.cssText = `
      padding: 0.2rem 0.4rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-family: inherit; font-size: 0.65rem; cursor: pointer;
      transition: background 0.15s;
    `
    fontDown.addEventListener('mouseenter', () => { fontDown.style.background = theme.borderHover })
    fontDown.addEventListener('mouseleave', () => { fontDown.style.background = theme.border })
    fontDown.addEventListener('click', () => this.callbacks.onFontSizeChange?.(-1))
    const fontUp = document.createElement('button')
    fontUp.textContent = 'A+'
    fontUp.title = 'Increase font size'
    fontUp.style.cssText = `
      padding: 0.2rem 0.4rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-family: inherit; font-size: 0.65rem; cursor: pointer;
      transition: background 0.15s;
    `
    fontUp.addEventListener('mouseenter', () => { fontUp.style.background = theme.borderHover })
    fontUp.addEventListener('mouseleave', () => { fontUp.style.background = theme.border })
    fontUp.addEventListener('click', () => this.callbacks.onFontSizeChange?.(1))
    fontWrap.append(fontDown, fontUp)
    topRow.appendChild(fontWrap)

    topRow.appendChild(this.separator())

    // MIDI button
    const midiBtn = this.iconButton(
      '\u{1F3B9}', 'MIDI',
      () => this.toggleMidiDropdown(midiBtn),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    midiBtn.title = 'MIDI Devices'
    midiBtn.style.opacity = '0.7'
    topRow.appendChild(midiBtn)

    // Samples button
    const samplesBtn = this.iconButton(
      '\u{1F3B5}', 'Samples',
      () => this.callbacks.onOpenSampleBrowser?.(),
      { bg: theme.comment, hover: theme.fgMuted }
    )
    samplesBtn.title = 'Browse Samples'
    samplesBtn.style.opacity = '0.7'
    topRow.appendChild(samplesBtn)

    topRow.appendChild(this.separator())

    // Spacer
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    topRow.appendChild(spacer)

    // Example selector
    const select = document.createElement('select')
    select.style.cssText = `
      background: ${theme.border};
      color: ${theme.fgDark};
      border: 1px solid ${theme.borderHover};
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

    const grouped = getExamplesByDifficulty()
    for (const [level, exs] of Object.entries(grouped)) {
      if (exs.length === 0) continue
      const group = document.createElement('optgroup')
      group.label = level.charAt(0).toUpperCase() + level.slice(1)
      for (const ex of exs) {
        const opt = document.createElement('option')
        opt.value = ex.name
        opt.textContent = ex.name
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    select.addEventListener('change', () => {
      const ex = examples.find(e => e.name === select.value)
      if (ex) {
        this.callbacks.onExample(ex)
        select.value = ''
      }
    })
    topRow.appendChild(select)

    // Zen / fullscreen button
    const zenBtn = document.createElement('button')
    zenBtn.textContent = '\u26F6'
    zenBtn.title = 'Fullscreen / Zen mode (F11)'
    zenBtn.style.cssText = `
      padding: 0.2rem 0.5rem; border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      font-size: 0.85rem; cursor: pointer;
      transition: background 0.15s;
      margin-left: 0.3rem;
    `
    zenBtn.addEventListener('mouseenter', () => { zenBtn.style.background = theme.borderHover })
    zenBtn.addEventListener('mouseleave', () => { zenBtn.style.background = theme.border })
    zenBtn.addEventListener('click', () => this.callbacks.onZen?.())
    topRow.appendChild(zenBtn)

    const githubBtn = document.createElement('a')
    githubBtn.href = 'https://github.com/MrityunjayBhardwaj/SonicPi.js'
    githubBtn.target = '_blank'
    githubBtn.rel = 'noopener noreferrer'
    githubBtn.title = 'View source on GitHub'
    githubBtn.setAttribute('aria-label', 'View source on GitHub')
    githubBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'
    githubBtn.style.cssText = `
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.9rem; height: 1.8rem;
      border: none; border-radius: 3px;
      background: ${theme.border}; color: ${theme.fgMuted};
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      margin-left: 0.3rem;
      text-decoration: none;
    `
    githubBtn.addEventListener('mouseenter', () => {
      githubBtn.style.background = theme.borderHover
      githubBtn.style.color = theme.fg
    })
    githubBtn.addEventListener('mouseleave', () => {
      githubBtn.style.background = theme.border
      githubBtn.style.color = theme.fgMuted
    })
    topRow.appendChild(githubBtn)

    // Bottom row: buffer tabs
    this.bufRow = this.createRow()
    const bufRow = this.bufRow
    bufRow.style.padding = '0 0.75rem'
    bufRow.style.gap = '0'

    for (let i = 0; i < BUFFER_COUNT; i++) {
      const btn = document.createElement('button')
      btn.textContent = `${i}`
      btn.title = `Buffer ${i}`
      btn.style.cssText = `
        padding: 0.3rem 0.65rem;
        min-height: 2rem;
        border: none;
        background: transparent;
        color: ${i === 0 ? theme.accent : theme.comment};
        font-family: inherit;
        font-size: 0.7rem;
        font-weight: ${i === 0 ? '700' : '400'};
        cursor: pointer;
        border-bottom: 2px solid ${i === 0 ? theme.accent : 'transparent'};
        transition: color 0.15s, border-color 0.15s;
      `
      btn.addEventListener('click', () => this.selectBuffer(i))
      btn.addEventListener('mouseenter', () => {
        if (i !== this.activeBuffer) btn.style.color = theme.fgDark
      })
      btn.addEventListener('mouseleave', () => {
        if (i !== this.activeBuffer) btn.style.color = theme.comment
      })
      bufRow.appendChild(btn)
      this.bufferBtns.push(btn)
    }

    // Shortcut hints (right side of buffer row)
    const hintSpacer = document.createElement('span')
    hintSpacer.style.flex = '1'
    bufRow.appendChild(hintSpacer)
    const hints = document.createElement('span')
    hints.style.cssText = `color: ${theme.fgFaint}; font-size: 0.6rem; white-space: nowrap;`
    hints.textContent = 'Ctrl+Enter Run  |  Esc Stop  |  Ctrl+/ Comment'
    bufRow.appendChild(hints)
  }

  setPlaying(playing: boolean): void {
    this.playing = playing
    this.playBtn.style.background = playing ? theme.info : theme.success
    const label = this.playBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = playing ? 'Update' : 'Run'
    this.stopBtn.style.opacity = playing ? '1' : '0.4'
    if (!playing) this.setRecording(false)
  }

  setLoading(loading: boolean): void {
    const label = this.playBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = loading ? 'Loading...' : (this.playing ? 'Update' : 'Run')
    this.playBtn.style.opacity = loading ? '0.6' : '1'
  }

  /** Show a dot indicator on buffers that have content. */
  setBufferHasContent(index: number, hasContent: boolean): void {
    const btn = this.bufferBtns[index]
    if (!btn) return
    const dot = hasContent ? '\u00B7' : ''  // middle dot
    const num = `${index}`
    btn.textContent = hasContent ? `${num}${dot}` : num
  }

  setRecording(recording: boolean): void {
    this.recording = recording
    this.recBtn.style.opacity = recording ? '1' : '0.4'
    this.recBtn.style.background = recording ? theme.error : theme.comment
    const label = this.recBtn.querySelector('.spw-btn-label') as HTMLElement
    if (label) label.textContent = recording ? 'Save' : 'Rec'
  }

  setBpm(bpm: number): void {
    this.bpmLabel.textContent = `${Math.round(bpm)} BPM`
  }

  private selectBuffer(index: number): void {
    this.bufferBtns[this.activeBuffer].style.color = theme.comment
    this.bufferBtns[this.activeBuffer].style.fontWeight = '400'
    this.bufferBtns[this.activeBuffer].style.borderBottomColor = 'transparent'

    this.activeBuffer = index
    this.bufferBtns[index].style.color = theme.accent
    this.bufferBtns[index].style.fontWeight = '700'
    this.bufferBtns[index].style.borderBottomColor = theme.accent

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
      background: ${theme.border};
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
      min-height: 2.2rem;
      border: none;
      border-radius: 5px;
      background: ${colors.bg};
      color: ${theme.fg};
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

  private toggleMidiDropdown(anchor: HTMLElement): void {
    if (this.midiDropdown) {
      this.closeMidiDropdown()
      return
    }

    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: ${theme.bgAlt};
      border: 1px solid ${theme.borderHover};
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 220px;
      max-height: 320px;
      overflow-y: auto;
      box-shadow: 0 8px 24px ${theme.shadow};
      z-index: 1000;
      font-family: inherit;
    `

    const rect = anchor.getBoundingClientRect()
    dropdown.style.left = `${rect.left}px`
    dropdown.style.top = `${rect.bottom + 4}px`

    this.buildMidiDropdownContent(dropdown)

    document.body.appendChild(dropdown)
    this.midiDropdown = dropdown

    // Close on outside click
    this.midiOutsideClickHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeMidiDropdown()
      }
    }
    setTimeout(() => {
      document.addEventListener('click', this.midiOutsideClickHandler!)
    }, 0)
  }

  private closeMidiDropdown(): void {
    if (this.midiOutsideClickHandler) {
      document.removeEventListener('click', this.midiOutsideClickHandler)
      this.midiOutsideClickHandler = null
    }
    if (this.midiDropdown) {
      this.midiDropdown.remove()
      this.midiDropdown = null
    }
  }

  private buildMidiDropdownContent(dropdown: HTMLElement): void {
    dropdown.innerHTML = ''

    const getMidiDevices = this.callbacks.getMidiDevices
    if (!getMidiDevices) {
      this.addMidiMessage(dropdown, 'MIDI not available')
      return
    }

    const devices = getMidiDevices()

    // Check for Web MIDI support
    if (!navigator.requestMIDIAccess) {
      this.addMidiMessage(dropdown, 'MIDI not supported in this browser')
      return
    }

    if (devices.length === 0) {
      this.addMidiMessage(dropdown, 'No MIDI devices found')
      return
    }

    const inputs = devices.filter(d => d.type === 'input')
    const outputs = devices.filter(d => d.type === 'output')

    if (inputs.length > 0) {
      this.addMidiSectionHeader(dropdown, 'Inputs')
      for (const dev of inputs) {
        this.addMidiDeviceRow(dropdown, dev)
      }
    }

    if (outputs.length > 0) {
      if (inputs.length > 0) {
        const sep = document.createElement('div')
        sep.style.cssText = 'height: 1px; background: ${theme.border}; margin: 0.3rem 0;'
        dropdown.appendChild(sep)
      }
      this.addMidiSectionHeader(dropdown, 'Outputs')
      for (const dev of outputs) {
        this.addMidiDeviceRow(dropdown, dev)
      }
    }
  }

  private addMidiMessage(container: HTMLElement, text: string): void {
    const msg = document.createElement('div')
    msg.textContent = text
    msg.style.cssText = `
      padding: 0.8rem;
      text-align: center;
      color: ${theme.fgFaint};
      font-size: 0.7rem;
    `
    container.appendChild(msg)
  }

  private addMidiSectionHeader(container: HTMLElement, text: string): void {
    const header = document.createElement('div')
    header.textContent = text
    header.style.cssText = `
      padding: 0.3rem 0.8rem 0.2rem;
      font-size: 0.55rem;
      color: ${theme.fgFaint};
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    container.appendChild(header)
  }

  private addMidiDeviceRow(container: HTMLElement, device: MidiDeviceInfo): void {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      padding: 0.3rem 0.8rem;
      cursor: pointer;
      font-size: 0.7rem;
      color: ${theme.fg};
      gap: 0.5rem;
      transition: background 0.1s;
      user-select: none;
    `
    row.addEventListener('mouseenter', () => {
      row.style.background = theme.border
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = 'none'
    })

    // Checkbox
    const check = document.createElement('span')
    check.style.cssText = `
      width: 14px; height: 14px;
      border: 1px solid ${device.selected ? theme.accent : theme.borderStrong};
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.6rem;
      flex-shrink: 0;
      background: ${device.selected ? theme.accent : 'none'};
      color: ${device.selected ? theme.fg : 'transparent'};
      transition: all 0.15s;
    `
    check.textContent = device.selected ? '\u2713' : ''

    const label = document.createElement('span')
    label.textContent = device.name
    label.style.cssText = `
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `

    row.append(check, label)
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const newSelected = !device.selected
      this.callbacks.onMidiDeviceToggle?.(device.id, device.type, newSelected)
      // Rebuild content in place
      if (this.midiDropdown) {
        this.buildMidiDropdownContent(this.midiDropdown)
      }
    })

    container.appendChild(row)
  }

  setButtonsVisible(visible: boolean): void {
    this.topRow.style.display = visible ? 'flex' : 'none'
  }

  setTabsVisible(visible: boolean): void {
    this.bufRow.style.display = visible ? 'flex' : 'none'
  }

  dispose(): void {
    this.closeMidiDropdown()
    this.el.remove()
  }
}
