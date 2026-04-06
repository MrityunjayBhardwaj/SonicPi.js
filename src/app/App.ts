/**
 * App shell — SonicPi.js.
 * Matches Sonic Pi desktop layout with welcome experience.
 */

import { SonicPiEngine } from '../engine/SonicPiEngine'
import { friendlyError } from '../engine/FriendlyErrors'
import { Recorder } from '../engine/Recorder'
import { SessionLog } from '../engine/SessionLog'
import { examples as allExamples, type Example } from '../engine/examples'
import { Editor } from './Editor'
import { Scope } from './Scope'
import { Console } from './Console'
import { Toolbar, type MidiDeviceInfo } from './Toolbar'
import { MenuBar } from './MenuBar'
import { CueLog } from './CueLog'
import { SampleBrowser } from './SampleBrowser'
import { HelpPanel } from './HelpPanel'

// Welcome buffer — the Blade Runner Ecstasy Edit
const WELCOME_CODE = `# =====================================================
#   ____              _        ____  _  __        __   _
#  / ___|  ___  _ __ (_) ___  |  _ \\(_) \\ \\      / /__| |__
#  \\___ \\ / _ \\| '_ \\| |/ __| | |_) | |  \\ \\ /\\ / / _ \\ '_ \\
#   ___) | (_) | | | | | (__  |  __/| |   \\ V  V /  __/ |_) |
#  |____/ \\___/|_| |_|_|\\___| |_|   |_|    \\_/\\_/ \\___|_.__/
#
#  Your Sonic Pi code, now portable.
# =====================================================
#
#  Press Run (Ctrl+Enter or Alt+R) to hear this piece.
#  Press Stop (Esc or Alt+S) to silence everything.
#  Edit the code while it plays — changes apply instantly!
#
#  github.com/MrityunjayBhardwaj/SonicPi.js
#  Also checkout Sonic Tau: https://sonic-pi.net/tau/
#
#  Standing on the shoulders of giants:
#    Sonic Pi & Sam Aaron  — sonic-pi.net
#    SuperCollider          — supercollider.github.io
#    Algorave community     — algorave.com
#
# =====================================================
#  BLADE RUNNER x TECHNO
#  10 synced loops: percussion + harmonic engine + synthbass
#  Techniques: define, line().mirror.tick, panslicer, sync
# =====================================================

use_bpm 115

amp_master = 1.0
c_blade    = 72
c_perc     = 115

define :pattern do |p|
  p.ring.tick == "x"
end

live_loop :met1 do
  sleep 1
end

# KICK
live_loop :kick, sync: :met1 do
  sample :bd_haus, amp: 1.5 * amp_master, cutoff: c_perc      if pattern "x-----------x---"
  sample :bd_tek,  amp: 0.5 * amp_master, cutoff: c_perc + 12 if pattern "x-----------x---"
  sleep 0.25
end

# SNARE
with_fx :reverb, mix: 0.3, room: 0.72 do
  live_loop :snare, sync: :met1 do
    sleep 1
    sample :drum_snare_hard, rate: 1.8, cutoff: c_perc, amp: 0.65 * amp_master
    sample :drum_snare_hard, rate: 1.6, start: 0.03, cutoff: c_perc, pan: 0.25, amp: 0.65 * amp_master
    sample :drum_snare_hard, rate: 1.5, start: 0.06, cutoff: c_perc, pan: -0.25, amp: 0.65 * amp_master
    sleep 1
  end
end

# HI-HATS
with_fx :panslicer, mix: 0.22 do
  with_fx :reverb, mix: 0.15 do
    live_loop :hats, sync: :met1 do
      a = rrand(0.38, 0.72) * amp_master
      sample :drum_cymbal_closed, amp: a, rate: 2.2, finish: 0.5, pan: [-0.4, 0.4].choose, cutoff: c_perc if pattern "x-x-x-x-x-x-x-x-xxx-x-x-x-"
      sleep 0.125
    end
  end
end

# CRASH
with_fx :reverb, mix: 0.75 do
  live_loop :crash, sync: :met1 do
    sleep 15.5
    sample :drum_splash_soft, amp: 0.07 * amp_master, cutoff: c_perc - 12, rate: 1.4, finish: 0.3
    sleep 0.5
  end
end

# HARMONIC ENGINE
with_fx :panslicer, mix: 0.18, phase: 8 do
  with_fx :reverb, room: 0.97, mix: 0.78, damp: 0.4 do

    # PADS
    live_loop :pads, sync: :met1 do
      use_synth :blade
      sweep = (line c_blade - 16, c_blade + 16, steps: 16).mirror.tick

      [:c3, :eb3, :g3, :b3].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.3 * amp_master, cutoff: sweep, vibrato_rate: 4.5, vibrato_depth: 0.10, vibrato_delay: 1.5, vibrato_onset: 0.8
      end
      sleep 12

      [:eb3, :g3, :bb3, :d4, :f4].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.3 * amp_master, cutoff: sweep + 8, vibrato_rate: 5.0, vibrato_depth: 0.12, vibrato_delay: 1.2, vibrato_onset: 0.7
      end
      sleep 12

      [:ab2, :c3, :eb3, :g3].each do |n|
        play n, attack: 3.0, sustain: 5.0, release: 4.0, amp: 1.4 * amp_master, cutoff: sweep + 14, vibrato_rate: 5.5, vibrato_depth: 0.15, vibrato_delay: 1.0, vibrato_onset: 0.6
      end
      sleep 12

      [:g2, :b2, :d3, :f3, :a3].each do |n|
        play n, attack: 3.5, sustain: 5.0, release: 4.5, amp: 1.4 * amp_master, cutoff: sweep + 20, vibrato_rate: 6.0, vibrato_depth: 0.18, vibrato_delay: 0.8, vibrato_onset: 0.5
      end
      sleep 12
    end

    # MELODY
    live_loop :melody, sync: :pads do
      use_synth :blade
      vib = (line 0.10, 0.30, steps: 48).mirror.tick

      play :c5, attack: 1.5, sustain: 2.5, release: 2.5, amp: 0.58 * amp_master, cutoff: c_blade + 6, vibrato_rate: 5.5, vibrato_depth: vib, vibrato_delay: 0.8, vibrato_onset: 0.5
      sleep 5
      play :eb5, attack: 0.8, sustain: 1.5, release: 1.8, amp: 0.52 * amp_master, cutoff: c_blade + 4, vibrato_rate: 5.2, vibrato_depth: vib + 0.02, vibrato_delay: 0.6, vibrato_onset: 0.4
      sleep 4
      play :g5, attack: 0.6, sustain: 1.2, release: 1.5, amp: 0.50 * amp_master, cutoff: c_blade + 8, vibrato_rate: 5.8, vibrato_depth: vib + 0.02, vibrato_delay: 0.5, vibrato_onset: 0.3
      sleep 3

      play :bb5, attack: 2.0, sustain: 3.5, release: 2.5, amp: 0.64 * amp_master, cutoff: c_blade + 12, vibrato_rate: 6.0, vibrato_depth: vib + 0.04, vibrato_delay: 0.9, vibrato_onset: 0.5
      sleep 6
      play :g5, attack: 0.8, sustain: 2.0, release: 2.0, amp: 0.56 * amp_master, cutoff: c_blade + 10, vibrato_rate: 5.8, vibrato_depth: vib + 0.02, vibrato_delay: 0.7, vibrato_onset: 0.4
      sleep 6

      play :c6, attack: 2.5, sustain: 5.5, release: 3.0, amp: 0.68 * amp_master, cutoff: c_blade + 20, vibrato_rate: 6.5, vibrato_depth: vib + 0.08, vibrato_delay: 1.2, vibrato_onset: 0.6
      sleep 12

      play :d6, attack: 3.0, sustain: 4.5, release: 3.5, amp: 0.66 * amp_master, cutoff: c_blade + 24, vibrato_rate: 7.0, vibrato_depth: vib + 0.10, vibrato_delay: 1.0, vibrato_onset: 0.7
      sleep 8
      play :b5, attack: 1.2, sustain: 1.8, release: 2.2, amp: 0.55 * amp_master, cutoff: c_blade + 18, vibrato_rate: 6.5, vibrato_depth: vib + 0.05, vibrato_delay: 0.6, vibrato_onset: 0.4
      sleep 4
    end

    # ECSTASY ARPEGGIOS
    live_loop :ecstasy, sync: :pads do
      use_synth :blade
      arp_chords = [
        [:c4, :eb4, :g4, :b4, :c5, :g4],
        [:eb4, :g4, :bb4, :d5, :f5, :bb4],
        [:ab4, :c5, :eb5, :g5, :ab5, :eb5],
        [:g4, :b4, :d5, :f5, :a5, :d5],
      ]
      4.times do |i|
        arp = arp_chords[i]
        spd = 1.2 - (i * 0.05)
        breath = 12.0 - (arp.length * spd)
        with_fx :echo, phase: 0.75, mix: (line 0.08, 0.72, steps: 128).mirror.tick do
          arp.each do |n|
            play n, attack: 0.04, sustain: spd * 0.32, release: spd * 0.58, amp: rrand(0.18, 0.32) * amp_master, cutoff: c_blade + (i * 6) + rrand(-4, 8), vibrato_rate: rrand(6, 9), vibrato_depth: rrand(0.08, 0.16), vibrato_delay: 0.12, vibrato_onset: 0.06
            sleep spd
          end
        end
        sleep [breath, 0.25].max
      end
    end

    # TEARS
    live_loop :tears, sync: :pads do
      use_synth :blade
      tear_data = [[:eb6, 12], [:g6, 12], [:c7, 12], [:b6, 12]]
      tear_data.each do |td|
        if one_in(2)
          play td[0], attack: rrand(2.5, 4.5), sustain: rrand(3.0, 5.5), release: rrand(4.0, 7.0), amp: rrand(0.12, 0.22) * amp_master, cutoff: rrand(92, 108), vibrato_rate: rrand(4.5, 7.0), vibrato_depth: rrand(0.18, 0.34), vibrato_delay: rrand(1.2, 2.5), vibrato_onset: rrand(0.5, 1.0)
        end
        sleep td[1]
      end
    end

    # SHIMMER
    live_loop :shimmer, sync: :pads do
      use_synth :blade
      pool = [:c6, :eb6, :g6, :bb6, :d7, :c7, :g6, :eb6, :ab6, :f6, :b6, :d6]
      pool.each do |n|
        unless one_in(3)
          play n, attack: rrand(1.0, 3.0), sustain: rrand(0.5, 2.0), release: rrand(3.5, 6.0), amp: rrand(0.06, 0.16) * amp_master, cutoff: rrand(94, 112), vibrato_rate: rrand(7.0, 10.0), vibrato_depth: rrand(0.14, 0.30), vibrato_delay: rrand(0.3, 0.8), vibrato_onset: rrand(0.2, 0.5)
        end
        sleep rrand(1.0, 3.0)
      end
    end

  end
end

# SYNTHBASS
with_fx :panslicer, mix: 0.28 do
  with_fx :reverb, mix: 0.28 do
    live_loop :synthbass, sync: :pads do
      use_synth :tech_saws
      bass_data = [[:c2, 56], [:eb2, 60], [:ab2, 65], [:g2, 69]]
      bass_data.each do |bd|
        play bd[0], sustain: 8.5, release: 3.0, cutoff: bd[1], amp: 0.78 * amp_master, attack: 0.1
        sleep 12
      end
    end
  end
end`

// Welcome log — credits and shortcuts
const WELCOME_LOG = [
  '',
  '  Sonic Pi Web v1.3.0',
  '',
  '  -------------------------------------------------------',
  '  Standing on the shoulders of giants:',
  '    Sonic Pi & Sam Aaron    sonic-pi.net',
  '    SuperCollider            supercollider.github.io',
  '    Algorave community       algorave.com',
  '  -------------------------------------------------------',
  '',
  '  Shortcuts:',
  '    Ctrl+Enter / Alt+R    Run code',
  '    Escape / Alt+S        Stop all',
  '    Ctrl+/                Toggle comment',
  '    F11                   Fullscreen',
  '',
  '  Happy live coding!',
  '',
]

const BUFFER_COUNT = 10

export class App {
  private engine: SonicPiEngine | null = null
  private editor!: Editor
  private scope!: Scope
  private console!: Console
  private cueLog!: CueLog
  private toolbar!: Toolbar
  private menuBar!: MenuBar
  private playing = false
  private root: HTMLElement
  private panelVisibility: Record<string, boolean> = {
    log: true, cueLog: true, scope: true, buttons: true, tabs: true,
  }

  // Buffer management — 10 buffers like Sonic Pi
  private buffers: string[] = Array(BUFFER_COUNT).fill('')
  private activeBuffer = 0
  private eventStreamHandler: ((event: unknown) => void) | null = null
  private recorder: Recorder | null = null
  private isRecording = false
  private sessionLog = new SessionLog()
  private helpPanel!: HelpPanel
  private sampleBrowser: SampleBrowser | null = null
  private midiInitialized = false
  /** Set of selected MIDI input device IDs (tracked locally for UI state). */
  private selectedMidiInputs = new Set<string>()
  /** Set of selected MIDI output device IDs (tracked locally for UI state). */
  private selectedMidiOutputs = new Set<string>()
  /** User preferences persisted to localStorage. */
  private prefs: Record<string, number | boolean> = {}

  constructor(root: HTMLElement) {
    this.root = root
    this.loadBuffers()
    try {
      const saved = localStorage.getItem('spw-panel-visibility')
      if (saved) this.panelVisibility = { ...this.panelVisibility, ...JSON.parse(saved) }
    } catch { /* ignore */ }
    this.loadPrefs()
    this.buildLayout()
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  private loadPrefs(): void {
    try {
      const saved = localStorage.getItem('spw-prefs')
      if (saved) this.prefs = JSON.parse(saved)
    } catch { /* ignore */ }
  }

  private savePrefs(): void {
    try { localStorage.setItem('spw-prefs', JSON.stringify(this.prefs)) } catch { /* ignore */ }
  }

  private applyPref(key: string, value: number | boolean): void {
    this.prefs[key] = value
    this.savePrefs()

    switch (key) {
      // Audio
      case 'masterVolume':
        if (this.engine) this.engine.setVolume((value as number) / 100)
        break
      case 'mixerPreAmp':
      case 'mixerAmp':
        // These require re-sending mixer params — applied on next play
        break

      // Visuals
      case 'scopeLineWidth':
        this.scope.setLineWidth(value as number)
        break
      case 'scopeGlow':
        this.scope.setGlow(value as number)
        break
      case 'scopeTrail':
        this.scope.setTrail((value as number) / 100)
        break
      case 'scopeHue':
        this.scope.setHueShift(value as number)
        break

      // Editor
      case 'autoScrollLog':
        this.console.setAutoScroll(value as boolean)
        break
      case 'showLineNumbers':
        this.editor.setLineNumbers(value as boolean)
        break
      case 'wordWrap':
        this.editor.setWordWrap(value as boolean)
        break

      // Performance
      case 'schedAheadTime':
        // Applied on next engine init
        break
    }
  }

  private getPrefs(): Record<string, number | boolean> {
    return {
      masterVolume: 80,
      mixerPreAmp: 0.3,
      mixerAmp: 1.2,
      scopeLineWidth: 2,
      scopeGlow: 4,
      scopeTrail: 25,
      scopeHue: 0,
      fontSize: this.editor?.getFontSize?.() ?? 14,
      autoScrollLog: true,
      showLineNumbers: true,
      wordWrap: false,
      schedAheadTime: 0.3,
      ...this.prefs,
    }
  }

  /** Apply all saved prefs on startup (after UI is built). */
  private applyAllPrefs(): void {
    const p = this.getPrefs()
    // Apply visual prefs immediately
    this.scope.setLineWidth(p.scopeLineWidth as number)
    this.scope.setGlow(p.scopeGlow as number)
    this.scope.setTrail((p.scopeTrail as number) / 100)
    this.scope.setHueShift(p.scopeHue as number)
    if (p.autoScrollLog === false) this.console.setAutoScroll(false)
    if (p.showLineNumbers === false) this.editor.setLineNumbers(false)
    if (p.wordWrap === true) this.editor.setWordWrap(true)
  }

  /** Load buffers from localStorage, falling back to welcome code. */
  private loadBuffers(): void {
    try {
      const saved = localStorage.getItem('spw-buffers')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length === BUFFER_COUNT) {
          // Only use saved buffers if at least one has content
          const hasContent = parsed.some((b: string) => b.trim().length > 0)
          if (hasContent) {
            this.buffers = parsed
            return
          }
        }
      }
    } catch { /* ignore */ }
    this.buffers[0] = WELCOME_CODE
  }

  /** Save buffers to localStorage. */
  private saveBuffers(): void {
    // Don't save if editor hasn't initialized (would overwrite with empty)
    if (!this.editor) return
    const val = this.editor.getValue()
    if (val.trim().length === 0 && this.buffers[this.activeBuffer].trim().length > 0) {
      // Editor returned empty but buffer had content — editor not ready yet, skip save
      return
    }
    this.buffers[this.activeBuffer] = val
    try {
      localStorage.setItem('spw-buffers', JSON.stringify(this.buffers))
    } catch { /* storage full or unavailable */ }
  }

  async init(): Promise<void> {
    await this.editor.init(this.buffers[0] || WELCOME_CODE)
    this.editor.onRun(() => this.handlePlay())
    this.editor.onStop(() => this.handleStop())
    this.editor.onZen(() => this.toggleZen())
    this.editor.onCursorWord((word) => this.helpPanel.updateWord(word))
    this.helpPanel.getCurrentWord = () => this.editor.getCurrentWord()

    // Show buffer content indicators
    this.updateBufferIndicators()

    // Save buffers on page unload
    window.addEventListener('beforeunload', () => this.saveBuffers())

    // Tab backgrounding: warn and resume AudioContext when tab returns (#7)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.playing) {
          this.console.logSystem('  [Warning] Tab hidden — audio may be suspended by the browser.')
        }
      } else {
        // Resume AudioContext if it was suspended by the browser
        const audio = this.engine?.components?.audio
        if (audio?.audioCtx?.state === 'suspended') {
          audio.audioCtx.resume().then(() => {
            this.console.logSystem('  Audio resumed.')
          }).catch(() => {})
        }
      }
    })

    // Apply saved preferences
    this.applyAllPrefs()

    // Show welcome log
    for (const line of WELCOME_LOG) {
      this.console.logSystem(line)
    }
  }

  private buildLayout(): void {
    this.root.innerHTML = ''
    this.root.style.cssText = `
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: #0d1117;
      color: #CDD3DE;
      font-family: 'Fira Code', 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
      overflow: hidden;
    `

    // Toolbar
    const toolbarContainer = document.createElement('div')
    toolbarContainer.style.cssText = `
      background: #161B22;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    `
    this.root.appendChild(toolbarContainer)
    this.toolbar = new Toolbar(toolbarContainer, {
      onPlay: () => this.handlePlay(),
      onStop: () => this.handleStop(),
      onRecord: () => this.handleRecord(),
      onExample: (ex) => this.loadExample(ex),
      onBufferSelect: (i) => this.switchBuffer(i),
      onVolumeChange: (v) => { if (this.engine) this.engine.setVolume(v) },
      getMidiDevices: () => this.getMidiDevices(),
      onMidiDeviceToggle: (id, type, selected) => this.toggleMidiDevice(id, type, selected),
      onOpenSampleBrowser: () => this.openSampleBrowser(),
      onFontSizeChange: (delta) => this.editor.changeFontSize(delta),
      onSave: () => this.handleSave(),
      onLoad: () => this.handleLoad(),
      onZen: () => this.toggleZen(),
    })

    // Main area
    const main = document.createElement('div')
    main.className = 'spw-main'
    main.style.cssText = `
      flex: 1; display: flex;
      overflow: hidden; min-height: 0;
    `
    this.root.appendChild(main)

    // Editor panel (left)
    const editorPanel = document.createElement('div')
    editorPanel.className = 'spw-editor-panel'
    editorPanel.style.cssText = `
      flex: 1; min-width: 0; overflow: hidden;
      display: flex; flex-direction: column;
    `
    main.appendChild(editorPanel)

    // Editor header
    const editorHeader = document.createElement('div')
    editorHeader.style.cssText = `
      padding: 0.3rem 0.6rem;
      font-size: 0.65rem;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
      background: #111921;
    `
    const edTitle = document.createElement('span')
    edTitle.textContent = 'Buffer 0'
    edTitle.id = 'spw-buffer-title'
    editorHeader.appendChild(edTitle)

    const edHint = document.createElement('span')
    edHint.textContent = 'Ctrl+Enter to run'
    edHint.style.cssText = 'margin-left: auto; color: #3a4550;'
    editorHeader.appendChild(edHint)
    editorPanel.appendChild(editorHeader)

    const editorWrap = document.createElement('div')
    editorWrap.style.cssText = 'flex: 1; min-height: 0; overflow: hidden;'
    editorPanel.appendChild(editorWrap)
    this.editor = new Editor(editorWrap)

    // Help panel (below editor, hidden by default)
    this.helpPanel = new HelpPanel(editorPanel)

    // --- Reusable draggable splitter factory ---
    const self = this
    function createSplitter(
      direction: 'horizontal' | 'vertical',
      storageKey: string,
      onResize: (delta: number) => void,
    ): HTMLElement {
      const el = document.createElement('div')
      const isH = direction === 'horizontal'
      let dragging = false

      el.style.cssText = [
        isH ? 'height: 4px; cursor: row-resize;' : 'width: 4px; cursor: col-resize;',
        'background: rgba(255,255,255,0.06);',
        'flex-shrink: 0;',
        'transition: background 0.15s;',
        'position: relative;',
        'z-index: 5;',
      ].join(' ')

      const setIdle = () => {
        el.style.background = 'rgba(255,255,255,0.06)'
        el.style[isH ? 'height' : 'width'] = '4px'
      }

      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(232,82,124,0.4)'
        el.style[isH ? 'height' : 'width'] = '6px'
      })
      el.addEventListener('mouseleave', () => { if (!dragging) setIdle() })

      const startDrag = (startPos: number, getPos: (e: MouseEvent | Touch) => number) => {
        dragging = true
        el.style.background = 'rgba(232,82,124,0.6)'
        let last = startPos

        const onMove = (e: MouseEvent) => {
          const pos = getPos(e)
          onResize(pos - last)
          last = pos
        }
        const onUp = () => {
          dragging = false
          setIdle()
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        startDrag(isH ? e.clientY : e.clientX, (ev) => isH ? ev.clientY : ev.clientX)
      })

      // Touch support
      el.addEventListener('touchstart', (e) => {
        e.preventDefault()
        const t = e.touches[0]
        dragging = true
        el.style.background = 'rgba(232,82,124,0.6)'
        let last = isH ? t.clientY : t.clientX

        const onTouchMove = (ev: TouchEvent) => {
          const pos = isH ? ev.touches[0].clientY : ev.touches[0].clientX
          onResize(pos - last)
          last = pos
        }
        const onTouchEnd = () => {
          dragging = false
          setIdle()
          document.removeEventListener('touchmove', onTouchMove)
          document.removeEventListener('touchend', onTouchEnd)
        }
        document.addEventListener('touchmove', onTouchMove, { passive: false })
        document.addEventListener('touchend', onTouchEnd)
      }, { passive: false })

      return el
    }

    // --- Vertical splitter (editor <-> right panel) ---
    const mainSplitter = createSplitter('vertical', 'spw-split-main', (delta) => {
      const edW = editorPanel.getBoundingClientRect().width + delta
      const rpW = rightPanel.getBoundingClientRect().width - delta
      if (edW >= 200 && rpW >= 200) {
        editorPanel.style.flex = 'none'
        editorPanel.style.width = `${edW}px`
        rightPanel.style.width = `${rpW}px`
        rightPanel.style.maxWidth = 'none'
        try { localStorage.setItem('spw-split-main', JSON.stringify({ ed: edW, rp: rpW })) } catch {}
        self.scope?.rebuildCanvases?.()
      }
    })
    main.appendChild(mainSplitter)

    // Right panel
    const rightPanel = document.createElement('div')
    rightPanel.className = 'spw-right'
    rightPanel.style.cssText = `
      width: 40%; min-width: 280px; max-width: 520px;
      display: flex; flex-direction: column;
      overflow: hidden; background: #0d1117;
    `
    main.appendChild(rightPanel)

    // Load saved main split
    try {
      const saved = localStorage.getItem('spw-split-main')
      if (saved) {
        const { ed, rp } = JSON.parse(saved)
        editorPanel.style.flex = 'none'
        editorPanel.style.width = `${ed}px`
        rightPanel.style.width = `${rp}px`
        rightPanel.style.maxWidth = 'none'
      }
    } catch {}

    // Scope
    const scopeContainer = document.createElement('div')
    scopeContainer.className = 'spw-scope'
    scopeContainer.style.cssText = `
      height: 140px; min-height: 80px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: #0d1117;
      flex-shrink: 0;
    `
    rightPanel.appendChild(scopeContainer)
    this.scope = new Scope(scopeContainer)

    // Load saved scope height
    try {
      const savedH = localStorage.getItem('spw-split-right')
      if (savedH) scopeContainer.style.height = `${parseInt(savedH)}px`
    } catch {}

    // --- Horizontal splitter (scope <-> console) ---
    const rightSplitter = createSplitter('horizontal', 'spw-split-right', (delta) => {
      const h = scopeContainer.getBoundingClientRect().height + delta
      if (h >= 60 && h <= rightPanel.getBoundingClientRect().height - 80) {
        scopeContainer.style.height = `${h}px`
        try { localStorage.setItem('spw-split-right', String(Math.round(h))) } catch {}
        self.scope?.rebuildCanvases?.()
      }
    })
    rightPanel.appendChild(rightSplitter)

    // Menu bar — topmost element, above toolbar.
    // Must be created after Scope so toggleMode/getActiveModes are available.
    this.menuBar = new MenuBar(this.root, {
      onToggleScope: (mode) => this.scope.toggleMode(mode),
      getActiveModes: () => this.scope.getActiveModes(),
      onTogglePanel: (panel, visible) => this.togglePanel(panel, visible),
      getPanelVisibility: () => this.panelVisibility,
      onLog: (msg) => this.console.logSystem(msg),
      onToggleHelp: () => this.helpPanel.toggle(),
      isHelpVisible: () => this.helpPanel.isVisible,
      prefs: {
        onPrefsChange: (key, value) => this.applyPref(key, value),
        getPrefs: () => this.getPrefs(),
      },
    })
    // Move menu bar to the very top (before toolbar)
    const menuEl = this.root.lastElementChild!
    this.root.insertBefore(menuEl, this.root.firstElementChild!)

    // Console
    const consoleContainer = document.createElement('div')
    consoleContainer.className = 'spw-console'
    consoleContainer.style.cssText = `
      flex: 1; min-height: 0; overflow: hidden;
    `
    rightPanel.appendChild(consoleContainer)
    this.console = new Console(consoleContainer)

    // Cue Log
    const cueLogContainer = document.createElement('div')
    cueLogContainer.className = 'spw-cuelog'
    cueLogContainer.style.cssText = `
      height: 120px; min-height: 60px;
      border-top: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
    `
    rightPanel.appendChild(cueLogContainer)
    this.cueLog = new CueLog(cueLogContainer)

    // Responsive
    const mq = window.matchMedia('(max-width: 700px)')
    const apply = (mobile: boolean) => {
      main.style.flexDirection = mobile ? 'column' : 'row'
      mainSplitter.style.display = mobile ? 'none' : ''
      if (mobile) {
        editorPanel.style.flex = 'none'
        editorPanel.style.height = '50%'
        editorPanel.style.width = ''
        rightPanel.style.width = '100%'
        rightPanel.style.maxWidth = 'none'
      } else {
        // Restore saved split or defaults
        try {
          const saved = localStorage.getItem('spw-split-main')
          if (saved) {
            const { ed, rp } = JSON.parse(saved)
            editorPanel.style.flex = 'none'
            editorPanel.style.width = `${ed}px`
            editorPanel.style.height = ''
            rightPanel.style.width = `${rp}px`
            rightPanel.style.maxWidth = 'none'
          } else {
            editorPanel.style.flex = '1'
            editorPanel.style.width = ''
            editorPanel.style.height = ''
            rightPanel.style.width = '40%'
            rightPanel.style.maxWidth = '520px'
          }
        } catch {
          editorPanel.style.flex = '1'
          editorPanel.style.width = ''
          editorPanel.style.height = ''
          rightPanel.style.width = '40%'
          rightPanel.style.maxWidth = '520px'
        }
      }
      self.scope?.rebuildCanvases?.()
    }
    apply(mq.matches)
    mq.addEventListener('change', (e) => apply(e.matches))

    // Apply saved panel visibility
    this.applyPanelVisibility()

    // Window resize — keep panels within bounds
    window.addEventListener('resize', () => {
      const mainW = main.getBoundingClientRect().width
      const edW = editorPanel.getBoundingClientRect().width
      const rpW = rightPanel.getBoundingClientRect().width
      if (edW + rpW + 4 > mainW && rpW > 200) {
        rightPanel.style.width = `${Math.max(200, mainW - edW - 8)}px`
      }
      self.scope?.rebuildCanvases?.()
    })

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.handleStop()
      }
      if (e.key === 'F11') {
        e.preventDefault()
        this.toggleZen()
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault()
        this.exportSession()
      }
    })
  }

  private updateBufferIndicators(): void {
    for (let i = 0; i < BUFFER_COUNT; i++) {
      this.toolbar.setBufferHasContent(i, this.buffers[i]?.trim().length > 0)
    }
  }

  private switchBuffer(index: number): void {
    this.buffers[this.activeBuffer] = this.editor.getValue()
    this.activeBuffer = index
    this.editor.setValue(this.buffers[index])
    this.saveBuffers()
    this.updateBufferIndicators()

    const title = document.getElementById('spw-buffer-title')
    if (title) title.textContent = `Buffer ${index}`
  }

  private async handlePlay(): Promise<void> {
    try {
      if (!this.engine) {
        this.toolbar.setLoading(true)
        const t0 = performance.now()
        this.console.logSystem('  Initialising audio engine...')

        let SuperSonicClass: unknown = undefined
        try {
          this.console.logSystem('  Loading SuperSonic WASM runtime...')
          // CDN dependency. dynamic import() does not support SRI.
          // See src/engine/cdn-manifest.ts for the full dependency manifest.
          // @ts-ignore — CDN URL
          const mod = await import(/* @vite-ignore */ 'https://unpkg.com/supersonic-scsynth@latest')
          SuperSonicClass = mod.SuperSonic ?? mod.default
          this.console.logSystem('  WASM runtime loaded.')
        } catch {
          this.console.logSystem('  SuperSonic CDN unavailable.')
          this.console.logSystem('  Running without audio (events will still log).')
        }

        const savedPrefs = this.getPrefs()
        this.engine = new SonicPiEngine({
          bridge: SuperSonicClass ? { SuperSonicClass: SuperSonicClass as never } : {},
          schedAheadTime: typeof savedPrefs.schedAheadTime === 'number' ? savedPrefs.schedAheadTime as number : undefined,
        })

        this.engine.setRuntimeErrorHandler((err) => {
          const fe = friendlyError(err)
          this.console.logError(fe.title, fe.message)
        })

        this.engine.setPrintHandler((msg) => {
          this.console.log(msg, 'info')
        })

        this.console.logSystem('  Loading synthdefs + initialising scsynth...')
        await this.engine.init()
        // Apply saved volume from prefs
        if (typeof savedPrefs.masterVolume === 'number') {
          this.engine.setVolume((savedPrefs.masterVolume as number) / 100)
        }
        await this.sessionLog.initSigning()
        // Expose engine for diagnostics (thread monitor, metrics)
        ;(globalThis as Record<string, unknown>).__spw_engine = this.engine

        // Log audio latency info (#6)
        const audioInfo = this.engine.components.audio
        if (audioInfo?.audioCtx) {
          const ctx = audioInfo.audioCtx as AudioContext & { baseLatency?: number; outputLatency?: number }
          const base = (ctx.baseLatency ?? 0) * 1000
          const output = (ctx.outputLatency ?? 0) * 1000
          this.console.logSystem(`  Audio latency: ${base.toFixed(1)}ms base + ${output.toFixed(1)}ms output = ${(base + output).toFixed(1)}ms`)
        }

        // Wire custom sample uploader to the engine and load samples from IndexedDB
        if (this.menuBar) {
          this.menuBar.sampleUploader.setEngine(this.engine)
        }
        const customCount = await this.engine.loadCustomSamplesFromDB()
        if (customCount > 0) {
          this.console.logSystem(`  Loaded ${customCount} custom sample${customCount > 1 ? 's' : ''} from storage.`)
        }

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
        this.toolbar.setLoading(false)
        this.console.logSystem(`  Audio engine ready. (${elapsed}s)`)
        this.console.logSystem('  Session logging active. Ctrl+Shift+S to export.')
        this.console.logSystem('')
      }

      const code = this.editor.getValue()
      this.console.newRun()
      this.cueLog.newRun()
      this.editor.highlightErrorLine(null) // clear previous errors

      const result = await this.engine.evaluate(code)
      if (result.error) {
        const fe = friendlyError(result.error)
        this.console.logError(fe.title, fe.message)
        if (fe.line) this.editor.highlightErrorLine(fe.line)
        return
      }

      this.engine.play()
      this.playing = true
      this.toolbar.setPlaying(true)
      await this.sessionLog.logRun(code)

      // Connect scope
      const audio = this.engine.components.audio
      if (audio) {
        this.scope.connect(audio.analyser, audio.analyserL, audio.analyserR)
      }

      // Wire event stream for console logging
      const streaming = this.engine.components.streaming
      if (streaming && !this.eventStreamHandler) {
        this.eventStreamHandler = ((event: { s: string | null; midiNote: number | null; audioTime?: number }) => {
          const s = event.s ?? '?'
          const note = event.midiNote != null ? ` note:${event.midiNote}` : ''
          this.console.logEvent('synth', `${s}${note}`, event.audioTime)
        }) as (event: unknown) => void
        streaming.eventStream.on(this.eventStreamHandler as never)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const fe = friendlyError(error)
      this.console.logError(fe.title, fe.message)
    }
  }

  private handleStop(): void {
    if (!this.engine || !this.playing) return
    this.engine.stop()
    this.playing = false
    this.toolbar.setPlaying(false)
    this.scope.disconnect()
    this.sessionLog.logStop()
    this.console.logSystem('')
    this.console.logSystem('  Stopping all runs...')
    this.console.logSystem('')
  }

  private async handleRecord(): Promise<void> {
    if (this.isRecording) {
      // Stop recording and download
      if (this.recorder) {
        this.console.logSystem('  Saving recording...')
        try {
          await this.recorder.stopAndDownload()
          this.console.logSystem('  Recording saved!')
        } catch (err) {
          this.console.logError('Recording failed', String(err))
        }
      }
      this.isRecording = false
      this.toolbar.setRecording(false)
      return
    }

    // Start recording
    const audio = this.engine?.components.audio
    if (!audio) {
      this.console.logError('Cannot record', 'No audio engine available. Press Run first.')
      return
    }

    this.recorder = new Recorder(audio.audioCtx, audio.analyser)
    this.recorder.start()
    this.isRecording = true
    this.toolbar.setRecording(true)
    this.console.logSystem('  Recording... Press Rec again to save.')
  }

  private async loadExample(example: Example): Promise<void> {
    this.editor.setValue(example.ruby)
    this.buffers[this.activeBuffer] = example.ruby
    this.saveBuffers()
    this.sessionLog.logLoadExample(example.name, example.ruby)
    this.console.logSystem(`  Loaded: ${example.name} — ${example.description}`)
    if (this.playing) {
      this.engine!.stop()
      // Wait for pre-scheduled audio in the lookahead buffer to drain before
      // starting the new example — otherwise scsynth plays the tail of the old one.
      await new Promise(r => setTimeout(r, this.engine!.schedAhead * 1000 + 50))
      await this.handlePlay()
    }
  }

  private async handleSave(): Promise<void> {
    const code = this.editor.getValue()
    const name = `buffer_${this.activeBuffer}.rb`

    // Modern File System Access API
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Sonic Pi', accept: { 'text/x-ruby': ['.rb'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(code)
        await writable.close()
        this.console.logSystem('  File saved.')
        return
      } catch { /* user cancelled or API unavailable */ }
    }

    // Fallback: download link
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
    this.console.logSystem('  File downloaded.')
  }

  private handleLoad(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.rb,.txt,.spi'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      this.editor.setValue(text)
      this.saveBuffers()
      this.console.logSystem(`  Loaded: ${file.name}`)
    }
    input.click()
  }

  private toggleZen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      this.root.requestFullscreen().catch(() => {
        // Fullscreen not supported or denied
      })
    }
  }

  private async exportSession(): Promise<void> {
    if (this.sessionLog.length === 0) {
      this.console.logSystem('  No session to export.')
      return
    }
    await this.sessionLog.exportAndDownload()
    this.console.logSystem('  Session log exported.')
  }

  private togglePanel(panel: string, visible: boolean): void {
    this.panelVisibility[panel] = visible
    try { localStorage.setItem('spw-panel-visibility', JSON.stringify(this.panelVisibility)) } catch { /* ignore */ }
    this.applyPanelVisibility()
  }

  private applyPanelVisibility(): void {
    const scope = this.root.querySelector('.spw-scope') as HTMLElement
    const consoleEl = this.root.querySelector('.spw-console') as HTMLElement
    const cueLogEl = this.root.querySelector('.spw-cuelog') as HTMLElement

    if (scope) scope.style.display = this.panelVisibility.scope !== false ? '' : 'none'
    if (consoleEl) consoleEl.style.display = this.panelVisibility.log !== false ? '' : 'none'
    if (cueLogEl) cueLogEl.style.display = this.panelVisibility.cueLog !== false ? '' : 'none'
  }

  // ---------------------------------------------------------------------------
  // MIDI device management
  // ---------------------------------------------------------------------------

  private getMidiDevices(): MidiDeviceInfo[] {
    if (!this.engine) return []
    // Lazy-init MIDI on first dropdown open
    if (!this.midiInitialized) {
      this.engine.midiBridge.init().then((ok) => {
        this.midiInitialized = ok
      })
      return [] // will populate on next open
    }
    const devices = this.engine.midiBridge.getDevices()
    return devices.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      selected: d.type === 'input'
        ? this.selectedMidiInputs.has(d.id)
        : this.selectedMidiOutputs.has(d.id),
    }))
  }

  private toggleMidiDevice(deviceId: string, type: 'input' | 'output', selected: boolean): void {
    if (!this.engine) return
    const bridge = this.engine.midiBridge
    if (type === 'input') {
      if (selected) {
        bridge.selectInput(deviceId)
        this.selectedMidiInputs.add(deviceId)
      } else {
        bridge.deselectInput(deviceId)
        this.selectedMidiInputs.delete(deviceId)
      }
    } else {
      if (selected) {
        bridge.selectOutput(deviceId)
        this.selectedMidiOutputs.add(deviceId)
      } else {
        bridge.deselectOutput(deviceId)
        this.selectedMidiOutputs.delete(deviceId)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sample browser
  // ---------------------------------------------------------------------------

  private openSampleBrowser(): void {
    if (this.sampleBrowser?.isOpen) {
      this.sampleBrowser.close()
      return
    }
    this.sampleBrowser = new SampleBrowser({
      onPreviewSample: (name) => this.previewSample(name),
      onInsertText: (text) => {
        this.editor.insertAtCursor(text)
      },
    })
    this.sampleBrowser.open()
  }

  private async previewSample(name: string): Promise<void> {
    try {
      if (!this.engine) {
        this.console.logSystem('  Start the engine first to preview samples.')
        return
      }
      // Evaluate a one-shot sample play
      const code = `sample :${name}`
      const result = await this.engine.evaluate(code)
      if (result.error) {
        this.console.logError('Preview failed', result.error.message)
        return
      }
      this.engine.play()
      // If not already playing, mark as playing so stop works
      if (!this.playing) {
        this.playing = true
        this.toolbar.setPlaying(true)
      }
    } catch (err) {
      this.console.logError('Preview failed', String(err))
    }
  }

  dispose(): void {
    this.handleStop()
    this.sampleBrowser?.dispose()
    this.engine?.dispose()
    this.editor.dispose()
    this.helpPanel.dispose()
    this.scope.dispose()
    this.console.dispose()
    this.cueLog.dispose()
    this.toolbar.dispose()
    this.menuBar?.dispose()
  }
}
