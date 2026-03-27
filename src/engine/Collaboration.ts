/**
 * Collaborative editing — CRDT-based shared code buffer.
 *
 * Uses Yjs for conflict-free replicated data types and WebRTC
 * DataChannel for peer-to-peer sync. No server required.
 *
 * Yjs is loaded from CDN at runtime (zero npm deps).
 */

export interface Peer {
  id: string
  name: string
  color: string
  cursor?: { line: number; col: number }
}

export interface CollabCallbacks {
  onCodeChange: (code: string) => void
  onPeerJoin: (peer: Peer) => void
  onPeerLeave: (peerId: string) => void
  onPeerCursor: (peerId: string, cursor: { line: number; col: number }) => void
}

// Minimal Yjs types for CDN loading
interface YDoc {
  getText(name: string): YText
  getMap(name: string): YMap
  destroy(): void
}
interface YText {
  toString(): string
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  observe(fn: (event: unknown) => void): void
}
interface YMap {
  set(key: string, value: unknown): void
  get(key: string): unknown
  delete(key: string): void
  observe(fn: (event: unknown) => void): void
}
interface WebrtcProvider {
  awareness: {
    setLocalStateField(field: string, value: unknown): void
    getStates(): Map<number, Record<string, unknown>>
    on(event: string, fn: (args: unknown) => void): void
  }
  destroy(): void
}

const PEER_COLORS = [
  '#E8527C', '#5EBDAB', '#C792EA', '#F78C6C',
  '#82AAFF', '#FFCB6B', '#89DDFF', '#FF5370',
]

export class CollaborationSession {
  private doc: YDoc | null = null
  private provider: WebrtcProvider | null = null
  private text: YText | null = null
  private peers = new Map<string, Peer>()
  private localPeer: Peer
  private callbacks: CollabCallbacks

  constructor(callbacks: CollabCallbacks, userName?: string) {
    this.callbacks = callbacks
    this.localPeer = {
      id: crypto.randomUUID(),
      name: userName ?? `User-${Math.random().toString(36).slice(2, 6)}`,
      color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
    }
  }

  /** Join or create a room. Loads Yjs from CDN. */
  async join(roomId: string): Promise<void> {
    // Load Yjs and WebRTC provider from CDN
    // @ts-ignore
    const Y = await import(/* @vite-ignore */ 'https://esm.sh/yjs@13')
    // @ts-ignore
    const { WebrtcProvider } = await import(/* @vite-ignore */ 'https://esm.sh/y-webrtc@10')

    this.doc = new Y.Doc() as unknown as YDoc
    this.text = this.doc.getText('code')

    // WebRTC provider — peer-to-peer, no server
    this.provider = new WebrtcProvider(
      `sonicpi-${roomId}`,
      this.doc as unknown as InstanceType<typeof Y.Doc>,
      { signaling: ['wss://signaling.yjs.dev'] }
    ) as unknown as WebrtcProvider

    // Set local awareness state
    this.provider.awareness.setLocalStateField('user', {
      name: this.localPeer.name,
      color: this.localPeer.color,
      id: this.localPeer.id,
    })

    // Listen for text changes
    this.text.observe(() => {
      if (this.text) {
        this.callbacks.onCodeChange(this.text.toString())
      }
    })

    // Listen for awareness changes (peer join/leave/cursor)
    this.provider.awareness.on('change', () => {
      this.syncPeers()
    })
  }

  /** Update the shared code buffer. */
  setCode(code: string): void {
    if (!this.text || !this.doc) return
    const current = this.text.toString()
    if (current === code) return

    // Simple diff: delete all, insert new
    // (Yjs handles CRDT merging internally)
    if (current.length > 0) this.text.delete(0, current.length)
    this.text.insert(0, code)
  }

  /** Update local cursor position (shared with peers). */
  setCursor(line: number, col: number): void {
    if (!this.provider) return
    this.provider.awareness.setLocalStateField('cursor', { line, col })
  }

  /** Get current peers. */
  getPeers(): Peer[] {
    return [...this.peers.values()]
  }

  /** Get room code for sharing. */
  get localUser(): Peer {
    return this.localPeer
  }

  /** Leave the room. */
  leave(): void {
    this.provider?.destroy()
    this.doc?.destroy()
    this.provider = null
    this.doc = null
    this.text = null
    this.peers.clear()
  }

  private syncPeers(): void {
    if (!this.provider) return

    const states = this.provider.awareness.getStates()
    const currentPeerIds = new Set<string>()

    states.forEach((state) => {
      const user = state['user'] as { name: string; color: string; id: string } | undefined
      if (!user || user.id === this.localPeer.id) return

      currentPeerIds.add(user.id)
      const cursor = state['cursor'] as { line: number; col: number } | undefined

      if (!this.peers.has(user.id)) {
        const peer: Peer = { id: user.id, name: user.name, color: user.color, cursor }
        this.peers.set(user.id, peer)
        this.callbacks.onPeerJoin(peer)
      } else {
        const existing = this.peers.get(user.id)!
        existing.cursor = cursor
        if (cursor) this.callbacks.onPeerCursor(user.id, cursor)
      }
    })

    // Detect peer leaves
    for (const [id] of this.peers) {
      if (!currentPeerIds.has(id)) {
        this.peers.delete(id)
        this.callbacks.onPeerLeave(id)
      }
    }
  }
}

/** Generate a random room ID. */
export function generateRoomId(): string {
  return Math.random().toString(36).slice(2, 8)
}
