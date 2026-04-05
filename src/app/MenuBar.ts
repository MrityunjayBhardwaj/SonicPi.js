/**
 * MenuBar — Desktop Sonic Pi-style menu bar with Visuals tab.
 *
 * Provides dropdown menus for scope mode toggles and preferences,
 * matching the Desktop SP Prefs → Visuals tab experience.
 */

import { type ScopeMode, ALL_SCOPE_MODES } from './Scope'

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
  spectrum: '#FFCB6B',
}

export class MenuBar {
  private container: HTMLElement
  private onToggleScope: (mode: ScopeMode) => void
  private getActiveModes: () => Set<ScopeMode>
  private activeDropdown: HTMLElement | null = null

  constructor(
    parent: HTMLElement,
    options: {
      onToggleScope: (mode: ScopeMode) => void
      getActiveModes: () => Set<ScopeMode>
    }
  ) {
    this.onToggleScope = options.onToggleScope
    this.getActiveModes = options.getActiveModes

    this.container = document.createElement('div')
    this.container.style.cssText = `
      display: flex;
      align-items: center;
      padding: 0 0.5rem;
      height: 24px;
      background: #161b22;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-size: 0.65rem;
      color: #8b949e;
      gap: 0;
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    `

    // Visuals menu
    this.addMenu('Visuals', () => this.buildVisualsMenu())

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (this.activeDropdown && !this.container.contains(e.target as Node)) {
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
      font-family: inherit; font-size: 0.65rem;
      padding: 0.2rem 0.6rem; cursor: pointer;
      border-radius: 3px;
      transition: background 0.1s, color 0.1s;
    `
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(255,255,255,0.06)'
      btn.style.color = '#c9d1d9'
    })
    btn.addEventListener('mouseleave', () => {
      if (this.activeDropdown?.dataset.menu !== label) {
        btn.style.background = 'none'
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
      dropdown.style.top = `${rect.bottom}px`
      document.body.appendChild(dropdown)
      this.activeDropdown = dropdown
      btn.style.background = 'rgba(255,255,255,0.08)'
      btn.style.color = '#c9d1d9'
    })
    this.container.appendChild(btn)
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove()
      this.activeDropdown = null
      // Reset all menu button styles
      for (const btn of this.container.querySelectorAll('button')) {
        (btn as HTMLElement).style.background = 'none';
        (btn as HTMLElement).style.color = '#8b949e'
      }
    }
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

    const active = this.getActiveModes()

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
      `
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255,255,255,0.06)'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none'
      })

      // Checkbox
      const check = document.createElement('span')
      check.style.cssText = `
        width: 14px; height: 14px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6rem;
        flex-shrink: 0;
        ${active.has(mode) ? `background: ${SCOPE_COLORS[mode]}; border-color: ${SCOPE_COLORS[mode]};` : ''}
      `
      check.textContent = active.has(mode) ? '✓' : ''
      check.style.color = active.has(mode) ? '#fff' : 'transparent'

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
        // Rebuild menu to reflect new state
        const parent = dropdown.parentElement
        const pos = { left: dropdown.style.left, top: dropdown.style.top }
        dropdown.remove()
        const newDropdown = this.buildVisualsMenu()
        newDropdown.dataset.menu = 'Visuals'
        newDropdown.style.left = pos.left
        newDropdown.style.top = pos.top
        if (parent) parent.appendChild(newDropdown)
        this.activeDropdown = newDropdown
      })

      dropdown.appendChild(item)
    }

    return dropdown
  }

  dispose(): void {
    this.closeDropdown()
    this.container.remove()
  }
}
