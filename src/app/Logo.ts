/**
 * Shared logo block — used by Toolbar and Preloader so the two stay in
 * lockstep visually. If you tweak the glyph, color, or text, both
 * surfaces update together.
 */

import { theme } from './theme'

export function createLogo(): HTMLElement {
  const logo = document.createElement('div')
  logo.style.cssText = `
    display: flex; align-items: center; gap: 0.5rem;
    user-select: none;
  `
  const icon = document.createElement('span')
  icon.textContent = '♫'
  icon.style.cssText = `
    font-size: 1.3rem; color: ${theme.accent};
    text-shadow: 0 0 12px ${theme.accentHover};
  `
  const text = document.createElement('span')
  text.textContent = 'Sonic Web'
  text.style.cssText = `
    font-weight: 700; font-size: 0.95rem; color: ${theme.fg};
    letter-spacing: 0.5px;
  `
  logo.append(icon, text)
  return logo
}
