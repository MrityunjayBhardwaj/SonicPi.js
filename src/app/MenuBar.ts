/**
 * MenuBar — Desktop Sonic Pi-style menu bar with Visuals tab.
 *
 * Provides dropdown menus for scope mode toggles and preferences,
 * matching the Desktop SP Prefs → Visuals tab experience.
 */

import { type ScopeMode, ALL_SCOPE_MODES } from './Scope'
import { SampleUploader } from './SampleUploader'

const SCOPE_LABELS: Record<ScopeMode, string> = {
  mono: 'Mono',
  stereo: 'Stereo',
  lissajous: 'Lissajous',
  mirror: 'Mirror',
  spectrum: 'Spectrum',
}

const SCOPE_COLORS: Record<ScopeMode, string> = {
  mono: '#E8527C',
  stereo: '#5EBDAB',
  lissajous: '#C792EA',
  mirror: '#82AAFF',
  spectrum: '#FF00FF',
}

export interface PrefsCallbacks {
  onPrefsChange?: (key: string, value: number | boolean) => void
  getPrefs?: () => Record<string, number | boolean>
}

export class MenuBar {
  private container: HTMLElement
  private onToggleScope: (mode: ScopeMode) => void
  private getActiveModes: () => Set<ScopeMode>
  private onTogglePanel: (panel: string, visible: boolean) => void
  private getPanelVisibility: () => Record<string, boolean>
  private onToggleHelp: (() => void) | null
  private isHelpVisible: (() => boolean) | null
  private activeDropdown: HTMLElement | null = null
  readonly sampleUploader: SampleUploader
  private prefsCallbacks: PrefsCallbacks

  constructor(
    parent: HTMLElement,
    options: {
      onToggleScope: (mode: ScopeMode) => void
      getActiveModes: () => Set<ScopeMode>
      onTogglePanel: (panel: string, visible: boolean) => void
      getPanelVisibility: () => Record<string, boolean>
      onLog?: (msg: string) => void
      onToggleHelp?: () => void
      isHelpVisible?: () => boolean
      prefs?: PrefsCallbacks
    }
  ) {
    this.onToggleScope = options.onToggleScope
    this.getActiveModes = options.getActiveModes
    this.onTogglePanel = options.onTogglePanel
    this.getPanelVisibility = options.getPanelVisibility
    this.onToggleHelp = options.onToggleHelp ?? null
    this.isHelpVisible = options.isHelpVisible ?? null
    this.prefsCallbacks = options.prefs ?? {}

    this.container = document.createElement('div')
    this.container.style.cssText = `
      display: flex;
      align-items: stretch;
      padding: 0;
      height: 32px;
      background: #0d1117;
      border-bottom: 2px solid rgba(255,255,255,0.08);
      font-size: 0.72rem;
      color: #8b949e;
      gap: 0;
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    `

    // Tab bar — prominent tabs above everything (Desktop SP style)
    this.addMenu('View', () => this.buildViewMenu())
    this.addMenu('Visuals', () => this.buildVisualsMenu())

    // Samples menu (custom sample upload)
    this.sampleUploader = new SampleUploader(
      document.createElement('div'), // placeholder parent — real parent is the dropdown
      { onLog: options.onLog },
    )
    this.addMenu('Samples', () => this.buildSamplesMenu())
    this.addMenu('Prefs', () => this.buildPrefsMenu())

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (this.activeDropdown &&
          !this.container.contains(e.target as Node) &&
          !this.activeDropdown.contains(e.target as Node)) {
        this.closeDropdown()
      }
    })

    parent.appendChild(this.container)
  }

  private addMenu(label: string, buildContent: () => HTMLElement): void {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = `
      background: none; border: none; color: #8b949e;
      font-family: inherit; font-size: 0.72rem;
      padding: 0 1rem; cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
      height: 100%;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      font-weight: 500;
    `
    btn.addEventListener('mouseenter', () => {
      btn.style.color = '#c9d1d9'
      if (this.activeDropdown?.dataset.menu !== label) {
        btn.style.borderBottomColor = 'rgba(232,82,124,0.3)'
      }
    })
    btn.addEventListener('mouseleave', () => {
      if (this.activeDropdown?.dataset.menu !== label) {
        btn.style.borderBottomColor = 'transparent'
        btn.style.color = '#8b949e'
      }
    })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.activeDropdown?.dataset.menu === label) {
        this.closeDropdown()
        return
      }
      this.closeDropdown()
      const dropdown = buildContent()
      dropdown.dataset.menu = label
      const rect = btn.getBoundingClientRect()
      dropdown.style.left = `${rect.left}px`
      dropdown.style.top = `${rect.bottom + 2}px`
      document.body.appendChild(dropdown)
      this.activeDropdown = dropdown
      btn.style.borderBottomColor = '#E8527C'
      btn.style.color = '#c9d1d9'
    })
    this.container.appendChild(btn)
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove()
      this.activeDropdown = null
      // Reset all tab button styles
      for (const btn of this.container.querySelectorAll('button')) {
        (btn as HTMLElement).style.borderBottomColor = 'transparent';
        (btn as HTMLElement).style.color = '#8b949e'
      }
    }
  }

  private buildViewMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: #1c2128;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 180px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 1000;
      font-family: inherit;
    `

    const panelItems: Array<{ key: string; label: string }> = [
      { key: 'log', label: 'Show Log' },
      { key: 'cueLog', label: 'Show Cue Log' },
      { key: 'scope', label: 'Show Scope' },
    ]

    const uiItems: Array<{ key: string; label: string }> = [
      { key: 'buttons', label: 'Show Buttons' },
      { key: 'tabs', label: 'Show Tabs' },
    ]

    const checkboxes = new Map<string, HTMLSpanElement>()

    const updateCheckboxes = () => {
      const vis = this.getPanelVisibility()
      for (const [key, check] of checkboxes) {
        const isOn = vis[key] !== false
        check.textContent = isOn ? '✓' : ''
        check.style.color = isOn ? '#fff' : 'transparent'
        check.style.background = isOn ? '#5EBDAB' : 'none'
        check.style.borderColor = isOn ? '#5EBDAB' : 'rgba(255,255,255,0.2)'
      }
    }

    const addItem = (key: string, label: string) => {
      const vis = this.getPanelVisibility()
      const isOn = vis[key] !== false
      const item = document.createElement('div')
      item.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.3rem 0.8rem;
        cursor: pointer;
        font-size: 0.7rem;
        color: #c9d1d9;
        gap: 0.5rem;
        transition: background 0.1s;
        user-select: none;
      `
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255,255,255,0.06)'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? '#5EBDAB' : 'rgba(255,255,255,0.2)'};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? '#5EBDAB' : 'none'};
        color: ${isOn ? '#fff' : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '✓' : ''
      checkboxes.set(key, check)

      const labelEl = document.createElement('span')
      labelEl.textContent = label

      item.appendChild(check)
      item.appendChild(labelEl)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        const currentVis = this.getPanelVisibility()
        const newState = !(currentVis[key] !== false)
        this.onTogglePanel(key, newState)
        updateCheckboxes()
      })

      dropdown.appendChild(item)
    }

    for (const { key, label } of panelItems) addItem(key, label)

    // Separator
    const sep = document.createElement('div')
    sep.style.cssText = `
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 0.3rem 0.6rem;
    `
    dropdown.appendChild(sep)

    for (const { key, label } of uiItems) addItem(key, label)

    // Separator before Help
    const sep2 = document.createElement('div')
    sep2.style.cssText = `
      height: 1px;
      background: rgba(255,255,255,0.08);
      margin: 0.3rem 0.6rem;
    `
    dropdown.appendChild(sep2)

    // Help panel toggle
    {
      const isOn = this.isHelpVisible?.() ?? false
      const item = document.createElement('div')
      item.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.3rem 0.8rem;
        cursor: pointer;
        font-size: 0.7rem;
        color: #c9d1d9;
        gap: 0.5rem;
        transition: background 0.1s;
        user-select: none;
      `
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255,255,255,0.06)'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? '#82AAFF' : 'rgba(255,255,255,0.2)'};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? '#82AAFF' : 'none'};
        color: ${isOn ? '#fff' : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '\u2713' : ''

      const labelEl = document.createElement('span')
      labelEl.textContent = 'Show Help'

      item.appendChild(check)
      item.appendChild(labelEl)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onToggleHelp?.()
        const nowOn = this.isHelpVisible?.() ?? false
        check.textContent = nowOn ? '\u2713' : ''
        check.style.color = nowOn ? '#fff' : 'transparent'
        check.style.background = nowOn ? '#82AAFF' : 'none'
        check.style.borderColor = nowOn ? '#82AAFF' : 'rgba(255,255,255,0.2)'
      })

      dropdown.appendChild(item)
    }

    return dropdown
  }

  private buildVisualsMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: #1c2128;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 0.4rem 0;
      min-width: 180px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 1000;
      font-family: inherit;
    `

    // Section header
    const header = document.createElement('div')
    header.textContent = 'Scope Modes'
    header.style.cssText = `
      padding: 0.3rem 0.8rem 0.2rem;
      font-size: 0.55rem;
      color: #484f58;
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    dropdown.appendChild(header)

    // Store checkbox refs for in-place updates (no rebuild flicker)
    const checkboxes = new Map<ScopeMode, HTMLSpanElement>()

    const updateCheckboxes = () => {
      const active = this.getActiveModes()
      for (const [mode, check] of checkboxes) {
        const isOn = active.has(mode)
        check.textContent = isOn ? '✓' : ''
        check.style.color = isOn ? '#fff' : 'transparent'
        check.style.background = isOn ? SCOPE_COLORS[mode] : 'none'
        check.style.borderColor = isOn ? SCOPE_COLORS[mode] : 'rgba(255,255,255,0.2)'
      }
    }

    for (const mode of ALL_SCOPE_MODES) {
      const item = document.createElement('div')
      item.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.3rem 0.8rem;
        cursor: pointer;
        font-size: 0.7rem;
        color: #c9d1d9;
        gap: 0.5rem;
        transition: background 0.1s;
        user-select: none;
      `
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255,255,255,0.06)'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      // Checkbox
      const check = document.createElement('span')
      const active = this.getActiveModes()
      const isOn = active.has(mode)
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? SCOPE_COLORS[mode] : 'rgba(255,255,255,0.2)'};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? SCOPE_COLORS[mode] : 'none'};
        color: ${isOn ? '#fff' : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '✓' : ''
      checkboxes.set(mode, check)

      // Color dot + label
      const dot = document.createElement('span')
      dot.style.cssText = `
        width: 6px; height: 6px;
        border-radius: 50%;
        background: ${SCOPE_COLORS[mode]};
        flex-shrink: 0;
      `

      const label = document.createElement('span')
      label.textContent = SCOPE_LABELS[mode]

      item.appendChild(check)
      item.appendChild(dot)
      item.appendChild(label)

      item.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onToggleScope(mode)
        updateCheckboxes()
      })

      dropdown.appendChild(item)
    }

    return dropdown
  }

  private buildSamplesMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: #1c2128;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 0.4rem 0.6rem;
      min-width: 220px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 1000;
      font-family: inherit;
    `

    // Section header
    const header = document.createElement('div')
    header.textContent = 'Custom Samples'
    header.style.cssText = `
      padding: 0.2rem 0.2rem 0.3rem;
      font-size: 0.55rem;
      color: #484f58;
      text-transform: uppercase;
      letter-spacing: 1px;
    `
    dropdown.appendChild(header)

    // Hint
    const hint = document.createElement('div')
    hint.textContent = 'Upload audio files to use as sample :user_<name>'
    hint.style.cssText = `
      font-size: 0.6rem;
      color: #484f58;
      padding: 0 0.2rem 0.3rem;
    `
    dropdown.appendChild(hint)

    // Re-parent the SampleUploader into this dropdown
    const uploaderContainer = this.sampleUploader['container'] as HTMLElement
    dropdown.appendChild(uploaderContainer)

    return dropdown
  }

  private buildPrefsMenu(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.style.cssText = `
      position: fixed;
      background: #1c2128;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 0.4rem 0;
      width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 1000;
      font-family: inherit;
    `

    const prefs = this.prefsCallbacks.getPrefs?.() ?? {}
    const onChange = (key: string, value: number | boolean) => {
      this.prefsCallbacks.onPrefsChange?.(key, value)
    }

    const addSection = (title: string) => {
      const header = document.createElement('div')
      header.textContent = title
      header.style.cssText = `
        padding: 0.4rem 0.8rem 0.2rem;
        font-size: 0.55rem;
        color: #484f58;
        text-transform: uppercase;
        letter-spacing: 1px;
      `
      dropdown.appendChild(header)
    }

    const addSlider = (label: string, key: string, min: number, max: number, step: number, defaultVal: number, unit?: string) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        font-size: 0.68rem;
        color: #c9d1d9;
        gap: 0.4rem;
      `
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'flex: 1; white-space: nowrap;'

      const valLabel = document.createElement('span')
      const currentVal = typeof prefs[key] === 'number' ? prefs[key] as number : defaultVal
      valLabel.textContent = `${currentVal}${unit ?? ''}`
      valLabel.style.cssText = 'font-size: 0.6rem; color: #8b949e; min-width: 32px; text-align: right;'

      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(currentVal)
      input.style.cssText = 'width: 120px; height: 3px; accent-color: #E8527C; cursor: pointer;'

      input.addEventListener('input', () => {
        const v = parseFloat(input.value)
        valLabel.textContent = `${v}${unit ?? ''}`
        onChange(key, v)
      })

      row.appendChild(lbl)
      row.appendChild(valLabel)
      row.appendChild(input)
      dropdown.appendChild(row)
    }

    const addCheckbox = (label: string, key: string, defaultVal: boolean) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        cursor: pointer;
        font-size: 0.68rem;
        color: #c9d1d9;
        gap: 0.5rem;
        transition: background 0.1s;
        user-select: none;
      `
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.06)' })
      row.addEventListener('mouseleave', () => { row.style.background = 'none' })

      const isOn = typeof prefs[key] === 'boolean' ? prefs[key] as boolean : defaultVal

      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid ${isOn ? '#E8527C' : 'rgba(255,255,255,0.2)'};
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        background: ${isOn ? '#E8527C' : 'none'};
        color: ${isOn ? '#fff' : 'transparent'};
        transition: all 0.15s;
      `
      check.textContent = isOn ? '\u2713' : ''

      const lbl = document.createElement('span')
      lbl.textContent = label

      row.addEventListener('click', (e) => {
        e.stopPropagation()
        const nowOn = check.textContent !== '\u2713'
        check.textContent = nowOn ? '\u2713' : ''
        check.style.color = nowOn ? '#fff' : 'transparent'
        check.style.background = nowOn ? '#E8527C' : 'none'
        check.style.borderColor = nowOn ? '#E8527C' : 'rgba(255,255,255,0.2)'
        onChange(key, nowOn)
      })

      row.appendChild(check)
      row.appendChild(lbl)
      dropdown.appendChild(row)
    }

    const addReadonly = (label: string, value: string) => {
      const row = document.createElement('div')
      row.style.cssText = `
        display: flex;
        align-items: center;
        padding: 0.25rem 0.8rem;
        font-size: 0.68rem;
        color: #8b949e;
        gap: 0.4rem;
      `
      const lbl = document.createElement('span')
      lbl.textContent = label
      lbl.style.cssText = 'flex: 1;'
      const val = document.createElement('span')
      val.textContent = value
      val.style.cssText = 'font-size: 0.6rem; color: #484f58;'
      row.appendChild(lbl)
      row.appendChild(val)
      dropdown.appendChild(row)
    }

    // --- Audio ---
    addSection('Audio')
    addSlider('Master Volume', 'masterVolume', 0, 100, 1, 80, '%')
    addSlider('Mixer Pre-Amp', 'mixerPreAmp', 0.1, 1.0, 0.05, 0.3)
    addSlider('Mixer Amp', 'mixerAmp', 0.5, 3.0, 0.1, 1.2)

    // --- Visuals ---
    addSection('Visuals')
    addSlider('Scope Line Width', 'scopeLineWidth', 1, 6, 0.5, 2, 'px')
    addSlider('Scope Glow', 'scopeGlow', 0, 20, 1, 4, 'px')
    addSlider('Scope Trail', 'scopeTrail', 0, 95, 5, 25, '%')
    addSlider('Scope Hue Shift', 'scopeHue', 0, 360, 5, 0, '\u00B0')

    // --- Editor ---
    addSection('Editor')
    addReadonly('Font Size', `${typeof prefs['fontSize'] === 'number' ? prefs['fontSize'] : 14}px (use A\u2212/A+ buttons)`)
    addCheckbox('Auto-scroll log', 'autoScrollLog', true)
    addCheckbox('Show line numbers', 'showLineNumbers', true)
    addCheckbox('Word wrap', 'wordWrap', false)

    // --- Performance ---
    addSection('Performance')
    addSlider('Schedule Ahead', 'schedAheadTime', 0.05, 0.5, 0.05, 0.3, 's')
    addReadonly('Max Loop Budget', '100,000 iterations')

    return dropdown
  }

  dispose(): void {
    this.closeDropdown()
    this.sampleUploader.dispose()
    this.container.remove()
  }
}
