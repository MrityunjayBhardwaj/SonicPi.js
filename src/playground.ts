import { SonicPiEngine } from './engine/SonicPiEngine'

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const EXAMPLES: Record<string, string> = {
  drums: `# Classic Sonic Pi drums
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end`,

  melody: `# Arpeggiated melody
live_loop :melody do
  use_synth :prophet
  play choose([:c4, :e4, :g4, :b4]), release: 0.3
  sleep 0.25
end`,

  ambient: `# Ambient pads
live_loop :ambient do
  use_synth :dark_ambience
  use_random_seed 42
  play choose([:c3, :e3, :g3, :c4]), release: 4, amp: 0.3
  sleep 2
end`,

  multi: `# Multi-loop beat
live_loop :kick do
  sample :bd_haus
  sleep 1
end

live_loop :hat do
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end

live_loop :bass do
  use_synth :tb303
  play :c2, release: 0.2, cutoff: 80
  sleep 0.25
  play :c2, release: 0.2, cutoff: 90
  sleep 0.25
  play :e2, release: 0.2, cutoff: 70
  sleep 0.5
end`,

  random: `# Random bleeps
live_loop :bleeps do
  use_synth :beep
  use_random_seed 12345
  play rrand_i(60, 84)
  sleep choose([0.25, 0.5, 0.125])
end`,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let engine: SonicPiEngine | null = null
let playing = false
let analyser: AnalyserNode | null = null
let animFrame: number | null = null

const codeEl = document.getElementById('code') as HTMLTextAreaElement
const playBtn = document.getElementById('playBtn') as HTMLButtonElement
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const canvas = document.getElementById('viz') as HTMLCanvasElement
const ctx2d = canvas.getContext('2d')!

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------

function setStatus(msg: string, type: 'ok' | 'error' | '' = '') {
  statusEl.textContent = msg
  statusEl.className = type
}

// ---------------------------------------------------------------------------
// Play / Stop
// ---------------------------------------------------------------------------

async function handlePlay() {
  try {
    if (!engine) {
      setStatus('Loading SuperSonic (WASM synth engine)...')

      // Dynamic import from CDN — keeps GPL core unbundled
      let SuperSonicClass: unknown = undefined
      try {
        // @ts-ignore — CDN URL, no type declarations
        const mod = await import(/* @vite-ignore */ 'https://unpkg.com/supersonic-scsynth@latest')
        SuperSonicClass = mod.SuperSonic ?? mod.default
      } catch (e) {
        console.warn('SuperSonic CDN load failed:', e)
      }

      engine = new SonicPiEngine({
        bridge: SuperSonicClass ? { SuperSonicClass: SuperSonicClass as never } : {},
      })
      setStatus('Initializing audio...')

      engine.setRuntimeErrorHandler((err) => {
        setStatus(`Runtime: ${err.message}`, 'error')
      })

      await engine.init()
    }

    const code = codeEl.value
    setStatus('Evaluating...')

    const result = await engine.evaluate(code)
    if (result.error) {
      setStatus(`Error: ${result.error.message}`, 'error')
      return
    }

    engine.play()
    playing = true
    playBtn.textContent = 'Update'
    stopBtn.disabled = false

    // Grab analyser for visualization
    const audio = engine.components.audio
    if (audio) {
      analyser = audio.analyser
      startViz()
      setStatus('Playing (with audio)', 'ok')
    } else {
      setStatus('Playing (no audio — SuperSonic unavailable)', 'ok')
    }
  } catch (err) {
    setStatus(`${err}`, 'error')
  }
}

function handleStop() {
  if (!engine) return

  engine.stop()
  playing = false
  playBtn.textContent = 'Run'
  stopBtn.disabled = true
  analyser = null

  if (animFrame) {
    cancelAnimationFrame(animFrame)
    animFrame = null
  }
  clearCanvas()
  setStatus('Stopped')
}

// ---------------------------------------------------------------------------
// Visualization (scope)
// ---------------------------------------------------------------------------

function startViz() {
  if (animFrame) cancelAnimationFrame(animFrame)

  function draw() {
    animFrame = requestAnimationFrame(draw)
    if (!analyser || !ctx2d) return

    const w = canvas.width = canvas.clientWidth * devicePixelRatio
    const h = canvas.height = canvas.clientHeight * devicePixelRatio

    const bufLen = analyser.fftSize
    const data = new Float32Array(bufLen)
    analyser.getFloatTimeDomainData(data)

    ctx2d.fillStyle = '#16213e'
    ctx2d.fillRect(0, 0, w, h)

    ctx2d.strokeStyle = '#e94560'
    ctx2d.lineWidth = 2 * devicePixelRatio
    ctx2d.beginPath()

    const sliceWidth = w / bufLen
    let x = 0
    for (let i = 0; i < bufLen; i++) {
      const y = (0.5 + data[i] * 0.5) * h
      if (i === 0) ctx2d.moveTo(x, y)
      else ctx2d.lineTo(x, y)
      x += sliceWidth
    }

    ctx2d.stroke()
  }

  draw()
}

function clearCanvas() {
  const w = canvas.width = canvas.clientWidth * devicePixelRatio
  const h = canvas.height = canvas.clientHeight * devicePixelRatio
  ctx2d.fillStyle = '#16213e'
  ctx2d.fillRect(0, 0, w, h)
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

playBtn.addEventListener('click', handlePlay)
stopBtn.addEventListener('click', handleStop)

// Example buttons
document.querySelectorAll('.btn-example').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = (btn as HTMLButtonElement).dataset.example!
    if (EXAMPLES[name]) {
      codeEl.value = EXAMPLES[name]
      if (playing) handlePlay() // live re-evaluate
    }
  })
})

// Ctrl+Enter to run
codeEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    handlePlay()
  }
})

// Init canvas
clearCanvas()
setStatus('Press Run or Ctrl+Enter to start')
