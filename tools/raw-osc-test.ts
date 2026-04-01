/**
 * Raw OSC Isolation Test — BYPASSES the entire Sonic Pi Web engine.
 *
 * Purpose: Prove whether the 2.3x louder output is from SuperSonic's scsynth WASM
 * or from our engine code.
 *
 * What this does:
 *   1. Playwright launches Chromium (headed, for audio capture)
 *   2. Loads a bare HTML page that imports SuperSonic directly from CDN
 *   3. Creates group structure + mixer with DESKTOP settings (pre_amp=0.2, amp=6)
 *   4. Loads bd_tek sample + basic_stereo_player synthdef
 *   5. Plays the kick pattern: "x--x--x---x--x--" at 130 BPM, amp=1.5, cutoff=130
 *   6. Records WAV via MediaRecorder on the AudioContext destination
 *   7. Compares RMS/peak against desktop reference
 *
 * If RMS ~2.2x desktop → SuperSonic WASM is the source (file upstream issue)
 * If RMS matches desktop → our engine adds gain somewhere we missed
 *
 * Usage:
 *   npx tsx tools/raw-osc-test.ts
 *   npx tsx tools/raw-osc-test.ts --duration 10000
 */

import { chromium } from '@playwright/test'
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createServer, type Server } from 'http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = resolve(__dirname, '../tools/audio_comparison/raw_osc_test')
const DESKTOP_REF = resolve(__dirname, '../tools/audio_comparison/latest_test/only_Drums/OriginalSonicPi_only_Drums.wav')

const DURATION = parseInt(process.argv.find(a => a.startsWith('--duration='))?.split('=')[1] ?? '') || 12000

// ---------------------------------------------------------------------------
// The HTML page that loads SuperSonic directly — NO engine, NO SoundLayer
// ---------------------------------------------------------------------------

const ISOLATION_HTML = `<!DOCTYPE html>
<html>
<head><title>Raw OSC Isolation Test</title></head>
<body>
<pre id="log">Loading SuperSonic from CDN...</pre>
<script type="module">
const log = document.getElementById('log');
function addLog(msg) {
  log.textContent += '\\n' + msg;
  console.log('[RAW-OSC] ' + msg);
}

// ---- CDN URLs (same versions as our engine) ----
const PKG_BASE = 'https://unpkg.com/supersonic-scsynth@latest/dist/';
const CORE_BASE = 'https://unpkg.com/supersonic-scsynth-core@latest/';
const SYNTHDEF_BASE = 'https://unpkg.com/supersonic-scsynth-synthdefs@latest/synthdefs/';
const SAMPLE_BASE = 'https://unpkg.com/supersonic-scsynth-samples@latest/samples/';

try {
  // 1. Import SuperSonic
  const mod = await import('https://unpkg.com/supersonic-scsynth@latest');
  const SuperSonic = mod.SuperSonic ?? mod.default;
  addLog('SuperSonic module loaded');

  // 2. Create instance — 14 output channels matching our engine
  const NUM_OUTPUT_CHANNELS = 14;
  const sonic = new SuperSonic({
    baseURL: PKG_BASE,
    workerBaseURL: PKG_BASE + 'workers/',
    wasmBaseURL: CORE_BASE + 'wasm/',
    coreBaseURL: CORE_BASE,
    synthdefBaseURL: SYNTHDEF_BASE,
    sampleBaseURL: SAMPLE_BASE,
    autoConnect: false,
    scsynthOptions: { numOutputBusChannels: NUM_OUTPUT_CHANNELS },
  });

  await sonic.init();
  addLog('scsynth WASM initialized (sampleRate=' + sonic.audioContext.sampleRate + ')');

  // 3. Load synthdefs — ONLY basic_stereo_player + mixer
  await sonic.loadSynthDef('sonic-pi-basic_stereo_player');
  await sonic.loadSynthDef('sonic-pi-mixer');
  addLog('Synthdefs loaded: basic_stereo_player, mixer');

  // 4. Load bd_tek sample
  const bufNum = 0;
  await sonic.loadSample(bufNum, 'bd_tek.flac');
  addLog('Sample loaded: bd_tek (buf=' + bufNum + ')');

  await sonic.sync();
  addLog('scsynth synced');

  // 5. Create group structure — EXACTLY matching desktop Sonic Pi
  //    Root(0) → mixerGroup(head) → fxGroup(before mixer) → synthGroup(before fx)
  //    Execution order: synths → fx → mixer
  const mixerGroupId = sonic.nextNodeId();
  sonic.send('/g_new', mixerGroupId, 0, 0);   // mixer group at head of root
  sonic.send('/g_new', 101, 2, mixerGroupId);  // FX group before mixer
  sonic.send('/g_new', 100, 2, 101);           // synths group before FX
  addLog('Group structure created: synths(100) → fx(101) → mixer(' + mixerGroupId + ')');

  // 6. Create mixer with DESKTOP settings — NOT compensated
  //    Desktop Sonic Pi: pre_amp=0.2, amp=6 (set_volume!(1) → vol * 0.2)
  //    in_bus = private bus (silence), out_bus = 0
  const mixerBus = NUM_OUTPUT_CHANNELS; // first private bus — nothing writes here
  const mixerNodeId = sonic.nextNodeId();
  sonic.send('/s_new', 'sonic-pi-mixer', mixerNodeId, 0, mixerGroupId,
    'out_bus', 0,
    'in_bus', mixerBus,
    'amp', 6,
    'pre_amp', 0.2,  // DESKTOP value — the whole point of this test
  );
  await sonic.sync();
  addLog('Mixer created: pre_amp=0.2, amp=6 (desktop identical)');

  // 7. Route audio — same as our engine but minimal
  const audioCtx = sonic.audioContext;
  const workletNode = sonic.node?.input ?? sonic.node;

  const splitter = audioCtx.createChannelSplitter(NUM_OUTPUT_CHANNELS);
  workletNode.connect(splitter);

  const merger = audioCtx.createChannelMerger(2);
  splitter.connect(merger, 0, 0);  // bus 0 left
  splitter.connect(merger, 1, 1);  // bus 0 right

  // NO additional gain — direct to destination
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.0;
  merger.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  addLog('Audio routing: splitter → merger(bus 0 L+R) → gain(1.0) → destination');

  // 8. Set up MediaRecorder to capture audio output
  const destNode = audioCtx.createMediaStreamDestination();
  gainNode.connect(destNode);
  const recorder = new MediaRecorder(destNode.stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  // Store results globally for Playwright to extract
  window.__rawOscTestDone = false;
  window.__rawOscTestAudio = null;

  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    // Convert to ArrayBuffer for extraction
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const cs = 8192;
    for (let i = 0; i < bytes.length; i += cs) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + cs, bytes.length)));
    }
    window.__rawOscTestAudio = btoa(binary);
    window.__rawOscTestDone = true;
    addLog('Recording saved (' + Math.round(blob.size / 1024) + ' KB)');
  };

  // 9. Also set up WAV recording via ScriptProcessor for accurate level analysis
  //    (WebM/Opus has its own normalization; raw PCM is what we need)
  const BUFFER_SIZE = 4096;
  const scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 2, 2);
  const pcmChunks = [];
  let pcmSampleCount = 0;
  scriptNode.onaudioprocess = (e) => {
    const left = e.inputBuffer.getChannelData(0);
    const right = e.inputBuffer.getChannelData(1);
    // Store interleaved float32
    const interleaved = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      interleaved[i * 2] = left[i];
      interleaved[i * 2 + 1] = right[i];
    }
    pcmChunks.push(interleaved);
    pcmSampleCount += left.length;
  };
  gainNode.connect(scriptNode);
  scriptNode.connect(audioCtx.destination); // must connect to keep it alive

  addLog('WAV recorder ready (ScriptProcessor, float32 PCM)');

  // 10. Play kick pattern: "x--x--x---x--x--" at 130 BPM
  //     Each step = 0.25 beats = 0.25 * 60/130 seconds
  const BPM = 130;
  const STEP_SEC = 0.25 * 60 / BPM; // ~0.1154 seconds
  const PATTERN = 'x--x--x---x--x--';
  const LOOPS = 4; // play 4 loops of the pattern

  // Start recording
  recorder.start();
  addLog('Recording started');

  // Schedule kicks using setTimeout — simple, reliable, no OSC bundle timing issues.
  // Each kick fires sonic.send() which goes to scsynth immediately.
  // Timing precision: setTimeout has ~4ms jitter, but we're measuring LEVEL not timing.
  const startDelay = 1000; // 1s lead time for recording to stabilize
  let noteCount = 0;

  for (let loop = 0; loop < LOOPS; loop++) {
    for (let step = 0; step < PATTERN.length; step++) {
      if (PATTERN[step] !== 'x') continue;

      const delayMs = startDelay + (loop * PATTERN.length + step) * STEP_SEC * 1000;
      const nodeId = sonic.nextNodeId();

      setTimeout(() => {
        sonic.send('/s_new',
          'sonic-pi-basic_stereo_player', nodeId, 0, 100,
          'buf', bufNum,
          'amp', 1.5,
          'lpf', 130,
          'out_bus', 0,
        );
      }, delayMs);
      noteCount++;
    }
  }

  const totalDuration = LOOPS * PATTERN.length * STEP_SEC;
  addLog('Scheduled ' + noteCount + ' kicks (' + LOOPS + ' loops of pattern)');
  addLog('Pattern: ' + PATTERN + ' at ' + BPM + ' BPM');
  addLog('Params: amp=1.5, lpf=130, out_bus=0 (desktop identical)');
  addLog('Total playback: ' + totalDuration.toFixed(2) + 's + 1s lead');

  // Let Playwright control when to stop via __rawOscTestStopSignal
  window.__rawOscTestStopSignal = false;
  window.__rawOscTestStopRecording = () => {
    recorder.stop();
    scriptNode.disconnect();

    // Build WAV from PCM chunks
    const totalSamples = pcmSampleCount;
    const sampleRate = audioCtx.sampleRate;
    const numChannels = 2;
    const bitsPerSample = 16;
    const dataSize = totalSamples * numChannels * (bitsPerSample / 8);
    const wavSize = 44 + dataSize;
    const wavBuf = new ArrayBuffer(wavSize);
    const view = new DataView(wavBuf);

    // WAV header
    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeString(0, 'RIFF');
    view.setUint32(4, wavSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // Write interleaved PCM samples (float32 → int16)
    let offset = 44;
    for (const chunk of pcmChunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
        offset += 2;
      }
    }

    // Convert to base64
    const wavBytes = new Uint8Array(wavBuf);
    let binary = '';
    const cs = 8192;
    for (let i = 0; i < wavBytes.length; i += cs) {
      binary += String.fromCharCode(...wavBytes.subarray(i, Math.min(i + cs, wavBytes.length)));
    }
    window.__rawOscTestWav = btoa(binary);
    addLog('WAV built: ' + totalSamples + ' samples, ' + sampleRate + 'Hz, ' + (totalSamples / sampleRate).toFixed(2) + 's');
  };

} catch (err) {
  document.getElementById('log').textContent += '\\nERROR: ' + err.message + '\\n' + err.stack;
  console.error('[RAW-OSC] Fatal:', err);
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Playwright driver
// ---------------------------------------------------------------------------

/** Start a minimal HTTP server to serve the isolation HTML (AudioWorklet requires http/https) */
function startServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('=== Raw OSC Isolation Test ===')
  console.log(`Purpose: Bypass entire engine, send OSC directly to SuperSonic`)
  console.log(`Settings: pre_amp=0.2, amp=6 (desktop identical, NO WASM compensation)`)
  console.log(`Duration: ${DURATION}ms`)
  console.log()

  // Start local HTTP server (AudioWorklet needs http, not file://)
  const { server, port } = await startServer(ISOLATION_HTML)
  console.log(`Serving isolation test on http://127.0.0.1:${port}`)

  // Write the HTML for reference
  const htmlPath = resolve(OUTPUT_DIR, 'isolation-test.html')
  writeFileSync(htmlPath, ISOLATION_HTML)

  // Launch Chromium headed (needed for audio)
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=AudioServiceOutOfProcess',
    ],
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  // Capture console
  const logs: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    logs.push(text)
    if (text.startsWith('[RAW-OSC]')) {
      console.log(text)
    }
  })
  page.on('pageerror', (err) => {
    console.error('[PAGE ERROR]', err.message)
  })

  // Navigate to the local server
  await page.goto(`http://127.0.0.1:${port}`)

  // Wait for playback to finish
  console.log(`\nWaiting ${DURATION}ms for playback...`)
  await page.waitForTimeout(DURATION)

  // Stop recording and build WAV
  console.log('Stopping recording, building WAV...')
  await page.evaluate(() => {
    (window as any).__rawOscTestStopRecording?.()
  })
  await page.waitForTimeout(3000) // wait for WAV to build

  // Extract WAV
  const wavBase64 = await page.evaluate(() => (window as any).__rawOscTestWav as string | null)
  const webmBase64 = await page.evaluate(() => (window as any).__rawOscTestAudio as string | null)

  // Extract page log
  const pageLog = await page.evaluate(() => document.getElementById('log')?.textContent ?? '')

  // Screenshot
  const screenshotPath = resolve(OUTPUT_DIR, 'screenshot.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })

  await browser.close()
  server.close()

  // Save results
  const logPath = resolve(OUTPUT_DIR, 'log.txt')
  writeFileSync(logPath, pageLog)
  console.log(`\nPage log saved: ${logPath}`)

  let wavPath: string | null = null
  if (wavBase64) {
    wavPath = resolve(OUTPUT_DIR, 'raw_osc_output.wav')
    writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'))
    console.log(`WAV saved: ${wavPath}`)
  } else {
    console.error('WARNING: No WAV captured!')
  }

  if (webmBase64) {
    const webmPath = resolve(OUTPUT_DIR, 'raw_osc_output.webm')
    writeFileSync(webmPath, Buffer.from(webmBase64, 'base64'))
    console.log(`WebM saved: ${webmPath}`)
  }

  // ---------------------------------------------------------------------------
  // Analyze WAV and compare with desktop reference
  // ---------------------------------------------------------------------------

  if (wavPath) {
    console.log('\n=== Audio Analysis ===')
    const stats = analyzeWav(wavPath)
    console.log(`\nRaw OSC Test (WASM, desktop settings):`)
    console.log(`  Duration: ${stats.duration.toFixed(2)}s`)
    console.log(`  Peak:     ${stats.peak.toFixed(4)}`)
    console.log(`  RMS:      ${stats.rms.toFixed(4)}`)
    console.log(`  Clipping: ${stats.clipping.toFixed(2)}%`)

    // Compare with desktop reference
    try {
      const desktopStats = analyzeWav(DESKTOP_REF)
      console.log(`\nDesktop Reference (original Sonic Pi):`)
      console.log(`  Duration: ${desktopStats.duration.toFixed(2)}s`)
      console.log(`  Peak:     ${desktopStats.peak.toFixed(4)}`)
      console.log(`  RMS:      ${desktopStats.rms.toFixed(4)}`)
      console.log(`  Clipping: ${desktopStats.clipping.toFixed(2)}%`)

      const rmsRatio = stats.rms / desktopStats.rms
      const peakRatio = stats.peak / desktopStats.peak
      console.log(`\n=== COMPARISON ===`)
      console.log(`  RMS ratio:  ${rmsRatio.toFixed(2)}x (WASM / desktop)`)
      console.log(`  Peak ratio: ${peakRatio.toFixed(2)}x (WASM / desktop)`)

      if (rmsRatio > 1.5) {
        console.log(`\n  VERDICT: SuperSonic WASM IS the source of the ${rmsRatio.toFixed(1)}x louder output.`)
        console.log(`  Our engine is NOT adding gain — the 2.3x factor is in scsynth WASM itself.`)
        console.log(`  → File issue on samaaron/supersonic with this A/B data.`)
      } else if (rmsRatio > 1.1) {
        console.log(`\n  VERDICT: Partial match — WASM is somewhat louder (${rmsRatio.toFixed(1)}x).`)
        console.log(`  Investigate both WASM internals AND engine for contributing factors.`)
      } else {
        console.log(`\n  VERDICT: RMS matches desktop (${rmsRatio.toFixed(2)}x).`)
        console.log(`  The 2.3x factor is NOT in SuperSonic — our engine adds gain somewhere.`)
        console.log(`  → Re-investigate engine signal path.`)
      }

      // Write detailed report
      const report = buildReport(stats, desktopStats, rmsRatio, peakRatio, pageLog)
      const reportPath = resolve(OUTPUT_DIR, 'RESULTS.md')
      writeFileSync(reportPath, report)
      console.log(`\nDetailed report: ${reportPath}`)
    } catch (e) {
      console.error(`\nCould not read desktop reference: ${(e as Error).message}`)
      console.log('Compare manually against: tools/audio_comparison/latest_test/only_Drums/')
    }
  }
}

// ---------------------------------------------------------------------------
// WAV analysis (matches capture.ts logic)
// ---------------------------------------------------------------------------

function analyzeWav(path: string): { duration: number; peak: number; rms: number; clipping: number; perSecondRms: number[] } {
  const buf = readFileSync(path)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  const numChannels = buf.readUInt16LE(22)
  const dataOffset = 44
  const bytesPerSample = bitsPerSample / 8
  const numSamples = Math.floor((buf.length - dataOffset) / (numChannels * bytesPerSample))

  let sumSq = 0
  let peak = 0
  let clipCount = 0

  // Per-second RMS
  const samplesPerSec = sampleRate
  const perSecondSums: number[] = []
  const perSecondCounts: number[] = []

  for (let i = 0; i < numSamples; i++) {
    const off = dataOffset + i * numChannels * bytesPerSample
    let val: number
    if (bitsPerSample === 16) {
      val = buf.readInt16LE(off) / 32768.0
    } else if (bitsPerSample === 32) {
      val = buf.readFloatLE(off)
    } else {
      val = buf.readInt16LE(off) / 32768.0
    }
    sumSq += val * val
    const a = Math.abs(val)
    if (a > peak) peak = a
    if (a > 0.95) clipCount++

    const sec = Math.floor(i / samplesPerSec)
    if (!perSecondSums[sec]) { perSecondSums[sec] = 0; perSecondCounts[sec] = 0 }
    perSecondSums[sec] += val * val
    perSecondCounts[sec]++
  }

  const rms = Math.sqrt(sumSq / numSamples)
  const perSecondRms = perSecondSums.map((s, i) => Math.sqrt(s / perSecondCounts[i]))

  return {
    duration: numSamples / sampleRate,
    peak: Math.round(peak * 10000) / 10000,
    rms: Math.round(rms * 10000) / 10000,
    clipping: Math.round((clipCount / numSamples) * 10000) / 100,
    perSecondRms,
  }
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function buildReport(
  wasmStats: ReturnType<typeof analyzeWav>,
  desktopStats: ReturnType<typeof analyzeWav>,
  rmsRatio: number,
  peakRatio: number,
  pageLog: string,
): string {
  const now = new Date().toISOString()
  return `# Raw OSC Isolation Test Results

**Date:** ${now}
**Branch:** feat/osc-bundle-timestamps

## Purpose

This test BYPASSES the entire Sonic Pi Web engine (no SonicPiEngine, no SoundLayer,
no AudioInterpreter, no ProgramBuilder). It loads SuperSonic directly from CDN and
sends raw OSC commands with desktop-identical settings.

If the output is still ~2.3x louder, SuperSonic WASM is the source.
If the output matches desktop, our engine is adding gain.

## Test Configuration

| Setting | Value | Notes |
|---------|-------|-------|
| pre_amp | 0.2 | Desktop default (NOT compensated) |
| amp | 6 | Desktop default |
| Sample | bd_tek | Same as desktop reference |
| Synthdef | basic_stereo_player | Same as desktop |
| BPM | 130 | Same as desktop |
| Pattern | x--x--x---x--x-- | Same as desktop |
| amp (synth) | 1.5 | Same as desktop |
| lpf (cutoff) | 130 | Same as desktop |
| out_bus | 0 | Same as desktop |

## Results

### Raw OSC Test (WASM, desktop settings)

| Metric | Value |
|--------|-------|
| Duration | ${wasmStats.duration.toFixed(2)}s |
| Peak | ${wasmStats.peak.toFixed(4)} |
| RMS | ${wasmStats.rms.toFixed(4)} |
| Clipping (>0.95) | ${wasmStats.clipping.toFixed(2)}% |

### Desktop Reference (original Sonic Pi)

| Metric | Value |
|--------|-------|
| Duration | ${desktopStats.duration.toFixed(2)}s |
| Peak | ${desktopStats.peak.toFixed(4)} |
| RMS | ${desktopStats.rms.toFixed(4)} |
| Clipping (>0.95) | ${desktopStats.clipping.toFixed(2)}% |

### Comparison

| Metric | Ratio (WASM / Desktop) |
|--------|----------------------|
| RMS | **${rmsRatio.toFixed(2)}x** |
| Peak | **${peakRatio.toFixed(2)}x** |

### Per-Second RMS

| Second | WASM RMS | Desktop RMS | Ratio |
|--------|----------|-------------|-------|
${wasmStats.perSecondRms.map((r, i) => {
  const d = desktopStats.perSecondRms[i] ?? 0
  const ratio = d > 0 ? (r / d).toFixed(2) : 'N/A'
  return `| ${i + 1} | ${r.toFixed(4)} | ${d.toFixed(4)} | ${ratio}x |`
}).join('\n')}

## Verdict

${rmsRatio > 1.5
  ? `**SuperSonic WASM IS the source of the ${rmsRatio.toFixed(1)}x louder output.**

Our engine code is NOT adding gain. With desktop-identical settings (pre_amp=0.2, amp=6)
and direct OSC to SuperSonic (bypassing SoundLayer, AudioInterpreter, ProgramBuilder),
the output is still ${rmsRatio.toFixed(1)}x louder than desktop scsynth.

This confirms the finding in artifacts/ref/RESEARCH_WASM_OUTPUT_LEVEL.md:
scsynth WASM produces hotter raw output than desktop scsynth.

**Action:** File issue on samaaron/supersonic with this A/B data.`
  : rmsRatio > 1.1
  ? `**Partial match — WASM is somewhat louder (${rmsRatio.toFixed(1)}x) but not the full 2.3x.**

Investigate both WASM internals AND engine for contributing factors.`
  : `**RMS matches desktop (${rmsRatio.toFixed(2)}x).**

The 2.3x factor is NOT in SuperSonic — our engine adds gain somewhere.
Re-investigate engine signal path.`}

## Console Log

\`\`\`
${pageLog}
\`\`\`
`
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
