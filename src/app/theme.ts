/**
 * Tokyo Night palette — single source of truth for UI chrome colors.
 * Based on https://github.com/tokyo-night/tokyo-night-vscode-theme
 *
 * Editor syntax highlighting lives in Editor.ts and uses the Desktop
 * Sonic Pi palette for parity with the canonical IDE — do not unify.
 */

export const theme = {
  // Backgrounds
  bg:          '#1a1b26',
  bgDark:      '#16161e',
  bgDarker:    '#0f0f17',
  bgHighlight: '#292e42',
  bgPanel:     '#1f2335',
  bgAlt:       '#24283b',

  // Foregrounds
  fg:        '#c0caf5',
  fgDark:    '#a9b1d6',
  fgMuted:   '#9aa5ce',
  comment:   '#565f89',
  fgFaint:   '#414868',

  // Borders (translucent so they layer cleanly on any bg)
  border:      'rgba(192,202,245,0.08)',
  borderHover: 'rgba(192,202,245,0.16)',
  borderStrong:'rgba(192,202,245,0.24)',

  // Accent (brand) — purple, Tokyo Night's signature
  accent:       '#bb9af7',
  accentMuted:  'rgba(187,154,247,0.15)',
  accentHover:  'rgba(187,154,247,0.4)',
  accentDrag:   'rgba(187,154,247,0.6)',
  accentFaint:  'rgba(187,154,247,0.08)',

  // Semantic colors
  blue:   '#7aa2f7',
  cyan:   '#7dcfff',
  purple: '#bb9af7',
  magenta:'#ff9e64',
  green:  '#9ece6a',
  red:    '#f7768e',
  orange: '#e0af68',
  yellow: '#e0af68',

  // Status-specific shortcuts
  success: '#9ece6a',
  warning: '#e0af68',
  error:   '#f7768e',
  info:    '#7aa2f7',

  // Shadow (used for tooltips/popups)
  shadow: 'rgba(0,0,0,0.4)',
  shadowStrong: 'rgba(0,0,0,0.6)',
} as const

export type Theme = typeof theme
