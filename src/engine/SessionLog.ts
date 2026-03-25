/**
 * Session logging — records every Run/Stop/Edit action with code hashes.
 *
 * Each entry has: action, timestamp (ISO 8601), SHA-256 hash of code.
 * The full session log can be exported as JSON for teacher verification.
 *
 * Ed25519 signing uses the Web Crypto API (SubtleCrypto).
 * Note: Ed25519 support in SubtleCrypto varies by browser.
 * Falls back to HMAC-SHA256 if Ed25519 is unavailable.
 */

export interface SessionEntry {
  action: 'run' | 'stop' | 'edit' | 'load_example'
  timestamp: string
  codeHash: string
  detail?: string
}

export interface SignedSession {
  entries: SessionEntry[]
  signature: string
  algorithm: string
  publicKey?: string
}

export class SessionLog {
  private entries: SessionEntry[] = []
  private signingKey: CryptoKey | null = null
  private verifyKey: CryptoKey | null = null
  private algorithm = 'unsigned'

  /** Initialize signing keys. Tries Ed25519, falls back to HMAC-SHA256. */
  async initSigning(): Promise<void> {
    try {
      // Try Ed25519 first
      const keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' } as EcKeyGenParams,
        true,
        ['sign', 'verify']
      )
      this.signingKey = keyPair.privateKey
      this.verifyKey = keyPair.publicKey
      this.algorithm = 'Ed25519'
    } catch {
      try {
        // Fallback: HMAC-SHA256
        this.signingKey = await crypto.subtle.generateKey(
          { name: 'HMAC', hash: 'SHA-256' },
          true,
          ['sign', 'verify']
        )
        this.verifyKey = this.signingKey
        this.algorithm = 'HMAC-SHA256'
      } catch {
        // No signing available
        this.algorithm = 'unsigned'
      }
    }
  }

  /** Log a Run action. */
  async logRun(code: string): Promise<void> {
    await this.addEntry('run', code)
  }

  /** Log a Stop action. */
  async logStop(): Promise<void> {
    await this.addEntry('stop', '')
  }

  /** Log an Edit (code change) action. */
  async logEdit(code: string): Promise<void> {
    await this.addEntry('edit', code)
  }

  /** Log loading an example. */
  async logLoadExample(exampleName: string, code: string): Promise<void> {
    await this.addEntry('load_example', code, exampleName)
  }

  /** Get all entries. */
  getEntries(): SessionEntry[] {
    return [...this.entries]
  }

  /** Get entry count. */
  get length(): number {
    return this.entries.length
  }

  /** Clear the session log. */
  clear(): void {
    this.entries = []
  }

  /** Export the session as a signed JSON object. */
  async exportSigned(): Promise<SignedSession> {
    const data = JSON.stringify(this.entries)
    let signature = ''
    let publicKey: string | undefined

    if (this.signingKey) {
      const encoded = new TextEncoder().encode(data)
      const sigBuffer = await crypto.subtle.sign(
        this.algorithm === 'Ed25519' ? { name: 'Ed25519' } as EcdsaParams : { name: 'HMAC' },
        this.signingKey,
        encoded
      )
      signature = bufferToHex(sigBuffer)

      // Export public key if Ed25519
      if (this.verifyKey && this.algorithm === 'Ed25519') {
        const pubKeyBuffer = await crypto.subtle.exportKey('raw', this.verifyKey)
        publicKey = bufferToHex(pubKeyBuffer)
      }
    }

    return {
      entries: [...this.entries],
      signature,
      algorithm: this.algorithm,
      publicKey,
    }
  }

  /** Export as downloadable JSON file. */
  async exportAndDownload(): Promise<void> {
    const signed = await this.exportSigned()
    const json = JSON.stringify(signed, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sonic-pi-session-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Verify a signed session (static). */
  static async verify(session: SignedSession, publicKey?: CryptoKey): Promise<boolean> {
    if (session.algorithm === 'unsigned' || !session.signature) return false

    if (!publicKey) return false

    const data = JSON.stringify(session.entries)
    const encoded = new TextEncoder().encode(data)
    const sigBuffer = hexToBuffer(session.signature)

    return crypto.subtle.verify(
      session.algorithm === 'Ed25519' ? { name: 'Ed25519' } as EcdsaParams : { name: 'HMAC' },
      publicKey,
      sigBuffer,
      encoded
    )
  }

  private async addEntry(action: SessionEntry['action'], code: string, detail?: string): Promise<void> {
    const codeHash = code ? await sha256(code) : ''
    this.entries.push({
      action,
      timestamp: new Date().toISOString(),
      codeHash,
      detail,
    })
  }
}

// Helpers

async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return bufferToHex(hashBuffer)
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes.buffer
}
