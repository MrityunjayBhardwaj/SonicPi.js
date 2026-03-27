/**
 * Ableton Link bridge — tempo/beat/phase synchronization.
 *
 * Architecture:
 *   Browser (this) <--WebRTC DataChannel--> Node.js bridge <--Link--> DAW
 *
 * The Node.js bridge runs @nicholasgasior/abletonlink-addon (or similar)
 * and exposes Link state over a WebRTC DataChannel.
 *
 * Protocol (JSON over DataChannel):
 *   → { type: "get_state" }
 *   ← { type: "state", tempo: 120, beat: 4.5, phase: 0.5, peers: 2 }
 *   → { type: "set_tempo", tempo: 130 }
 *   ← { type: "tempo_changed", tempo: 130 }
 *
 * Without the bridge running, the LinkBridge provides local-only
 * tempo/beat tracking using AudioContext.currentTime.
 */

/** Default tempo when no Link peers are connected. */
const DEFAULT_TEMPO_BPM = 120
/** Link state poll interval — 50ms gives 20Hz updates, fast enough for beat-accurate UI. */
const LINK_POLL_INTERVAL_MS = 50
/** Number of beats per bar in the Link phase calculation (4/4 time). */
const BEATS_PER_BAR = 4
/** Seconds per minute — used to convert BPM to beats-per-second. */
const SECONDS_PER_MINUTE = 60

export interface LinkState {
  tempo: number
  beat: number
  phase: number
  peers: number
  connected: boolean
}

export type LinkStateHandler = (state: LinkState) => void

export class LinkBridge {
  private dc: RTCDataChannel | null = null
  private pc: RTCPeerConnection | null = null
  private handlers: LinkStateHandler[] = []
  private _state: LinkState = {
    tempo: DEFAULT_TEMPO_BPM,
    beat: 0,
    phase: 0,
    peers: 0,
    connected: false,
  }
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private startTime = 0
  private audioCtx: AudioContext | null = null

  get state(): LinkState {
    return { ...this._state }
  }

  /** Register a handler for Link state updates. */
  onStateChange(handler: LinkStateHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Connect to a Link bridge via WebRTC.
   * The bridge should be running on localhost and accept signaling
   * via a simple HTTP endpoint.
   */
  async connect(signalingUrl: string = 'http://localhost:9001/signal'): Promise<boolean> {
    try {
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })

      this.dc = this.pc.createDataChannel('link', {
        ordered: true,
        maxRetransmits: 0, // unreliable mode for low latency
      })

      this.dc.onopen = () => {
        this._state.connected = true
        this.emit()
        // Start polling for state
        this.pollTimer = setInterval(() => {
          this.dc?.send(JSON.stringify({ type: 'get_state' }))
        }, LINK_POLL_INTERVAL_MS)
      }

      this.dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'state') {
            this._state.tempo = msg.tempo
            this._state.beat = msg.beat
            this._state.phase = msg.phase
            this._state.peers = msg.peers
            this._state.connected = true
            this.emit()
          } else if (msg.type === 'tempo_changed') {
            this._state.tempo = msg.tempo
            this.emit()
          }
        } catch { /* ignore malformed messages */ }
      }

      this.dc.onclose = () => {
        this._state.connected = false
        this.emit()
        this.stopPolling()
      }

      // Create offer and send to signaling server
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)

      // Wait for ICE gathering
      await new Promise<void>((resolve) => {
        if (this.pc!.iceGatheringState === 'complete') { resolve(); return }
        this.pc!.addEventListener('icegatheringstatechange', () => {
          if (this.pc!.iceGatheringState === 'complete') resolve()
        })
      })

      // Send offer to bridge, get answer
      const response = await fetch(signalingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: this.pc.localDescription }),
      })

      if (!response.ok) throw new Error(`Signaling failed: ${response.status}`)

      const answer = await response.json()
      await this.pc.setRemoteDescription(answer.sdp)

      return true
    } catch (err) {
      console.warn('[Link] Connection failed:', err)
      this._state.connected = false
      return false
    }
  }

  /**
   * Start local-only beat tracking (no Link bridge needed).
   * Uses AudioContext time to track beats at the current tempo.
   */
  startLocal(audioCtx: AudioContext, tempo: number = DEFAULT_TEMPO_BPM): void {
    this.audioCtx = audioCtx
    this._state.tempo = tempo
    this._state.connected = false
    this._state.peers = 0
    this.startTime = audioCtx.currentTime

    this.pollTimer = setInterval(() => {
      if (!this.audioCtx) return
      const elapsed = this.audioCtx.currentTime - this.startTime
      const beatsPerSecond = this._state.tempo / SECONDS_PER_MINUTE
      this._state.beat = elapsed * beatsPerSecond
      this._state.phase = this._state.beat % BEATS_PER_BAR
      this.emit()
    }, LINK_POLL_INTERVAL_MS)
  }

  /** Set tempo (sends to bridge if connected, or updates local). */
  setTempo(tempo: number): void {
    this._state.tempo = tempo
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type: 'set_tempo', tempo }))
    }
    this.emit()
  }

  /** Get the current beat position. */
  getBeat(): number {
    return this._state.beat
  }

  /** Get the current phase (0-3 for 4/4 time). */
  getPhase(): number {
    return this._state.phase
  }

  /** Disconnect from the bridge. */
  disconnect(): void {
    this.stopPolling()
    this.dc?.close()
    this.pc?.close()
    this.dc = null
    this.pc = null
    this._state.connected = false
    this._state.peers = 0
    this.emit()
  }

  dispose(): void {
    this.disconnect()
    this.handlers = []
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private emit(): void {
    const state = this.state
    for (const handler of this.handlers) {
      try { handler(state) } catch { /* don't crash */ }
    }
  }
}
