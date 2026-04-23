/**
 * SampleUploader — UI for uploading custom audio samples.
 *
 * Users upload WAV/MP3/OGG/FLAC files, which are stored in IndexedDB
 * and registered with the audio engine as `user_<filename>` samples.
 */

import {
  saveCustomSample,
  deleteCustomSample,
  loadAllCustomSamples,
  type CustomSampleRecord,
} from '../engine/CustomSampleStore'
import type { SonicPiEngine } from '../engine/SonicPiEngine'
import { theme } from './theme'

const ACCEPTED_TYPES = '.wav,.mp3,.ogg,.flac'

export class SampleUploader {
  private container: HTMLElement
  private listEl: HTMLElement
  private fileInput: HTMLInputElement
  private engine: SonicPiEngine | null = null
  private onLog: (msg: string) => void

  constructor(
    parent: HTMLElement,
    options: { onLog?: (msg: string) => void } = {},
  ) {
    this.onLog = options.onLog ?? (() => {})

    this.container = document.createElement('div')
    this.container.style.cssText = `
      padding: 0.4rem 0;
      font-size: 0.7rem;
      color: ${theme.fg};
    `

    // Upload button
    const uploadBtn = document.createElement('button')
    uploadBtn.textContent = '+ Upload Sample'
    uploadBtn.style.cssText = `
      background: ${theme.border};
      border: 1px dashed ${theme.borderStrong};
      border-radius: 4px;
      color: ${theme.fgMuted};
      font-family: inherit;
      font-size: 0.65rem;
      padding: 0.4rem 0.8rem;
      cursor: pointer;
      width: 100%;
      transition: background 0.15s, border-color 0.15s;
      margin-bottom: 0.4rem;
    `
    uploadBtn.addEventListener('mouseenter', () => {
      uploadBtn.style.background = theme.borderHover
      uploadBtn.style.borderColor = theme.borderStrong
    })
    uploadBtn.addEventListener('mouseleave', () => {
      uploadBtn.style.background = theme.border
      uploadBtn.style.borderColor = theme.borderStrong
    })

    // Hidden file input
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    this.fileInput.accept = ACCEPTED_TYPES
    this.fileInput.multiple = true
    this.fileInput.style.display = 'none'
    this.fileInput.addEventListener('change', () => this.handleFiles())

    uploadBtn.addEventListener('click', () => this.fileInput.click())

    // Sample list
    this.listEl = document.createElement('div')
    this.listEl.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 200px;
      overflow-y: auto;
    `

    this.container.appendChild(uploadBtn)
    this.container.appendChild(this.fileInput)
    this.container.appendChild(this.listEl)
    parent.appendChild(this.container)

    // Load existing samples on creation
    this.refreshList()
  }

  /** Set the engine reference — needed to register samples with the audio bridge. */
  setEngine(engine: SonicPiEngine): void {
    this.engine = engine
  }

  private async handleFiles(): Promise<void> {
    const files = this.fileInput.files
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      try {
        const audioData = await file.arrayBuffer()
        const baseName = file.name.replace(/\.[^.]+$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
        const sampleName = `user_${baseName}`

        // Store in IndexedDB
        const record: CustomSampleRecord = {
          name: sampleName,
          originalName: file.name,
          audioData,
          uploadedAt: Date.now(),
        }
        await saveCustomSample(record)

        // Register with audio engine if available
        if (this.engine) {
          try {
            await this.engine.registerCustomSample(sampleName, audioData)
            this.onLog(`  Custom sample loaded: ${sampleName}`)
          } catch {
            this.onLog(`  Stored "${sampleName}" — will be available after pressing Run`)
          }
        } else {
          this.onLog(`  Stored "${sampleName}" — will be available after pressing Run`)
        }
      } catch (err) {
        this.onLog(`  Failed to upload "${file.name}": ${err}`)
      }
    }

    // Reset the input so re-uploading the same file triggers change event
    this.fileInput.value = ''
    this.refreshList()
  }

  private async refreshList(): Promise<void> {
    this.listEl.innerHTML = ''
    try {
      const samples = await loadAllCustomSamples()
      if (samples.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = 'No custom samples uploaded'
        empty.style.cssText = `color: ${theme.fgFaint}; font-size: 0.6rem; padding: 0.2rem 0;`
        this.listEl.appendChild(empty)
        return
      }

      for (const sample of samples) {
        this.listEl.appendChild(this.createSampleRow(sample))
      }
    } catch {
      // IndexedDB unavailable
    }
  }

  private createSampleRow(sample: CustomSampleRecord): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.25rem 0.4rem;
      border-radius: 3px;
      transition: background 0.1s;
    `
    row.addEventListener('mouseenter', () => {
      row.style.background = theme.border
    })
    row.addEventListener('mouseleave', () => {
      row.style.background = 'none'
    })

    const nameEl = document.createElement('span')
    nameEl.style.cssText = `
      font-size: 0.65rem;
      color: ${theme.fg};
      font-family: 'Fira Code', monospace;
    `
    nameEl.textContent = `:${sample.name}`
    nameEl.title = `sample :${sample.name}  (from ${sample.originalName})`

    const deleteBtn = document.createElement('button')
    deleteBtn.textContent = '\u00D7'
    deleteBtn.title = 'Delete sample'
    deleteBtn.style.cssText = `
      background: none;
      border: none;
      color: ${theme.fgFaint};
      font-size: 0.8rem;
      cursor: pointer;
      padding: 0 0.3rem;
      line-height: 1;
      transition: color 0.1s;
    `
    deleteBtn.addEventListener('mouseenter', () => {
      deleteBtn.style.color = theme.red
    })
    deleteBtn.addEventListener('mouseleave', () => {
      deleteBtn.style.color = theme.fgFaint
    })
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      await deleteCustomSample(sample.name)
      this.onLog(`  Removed custom sample: ${sample.name}`)
      this.refreshList()
    })

    row.appendChild(nameEl)
    row.appendChild(deleteBtn)
    return row
  }

  dispose(): void {
    this.container.remove()
  }
}
