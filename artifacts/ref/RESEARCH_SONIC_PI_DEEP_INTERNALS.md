# Sonic Pi Deep Internals — Complete Architecture Reference

Research from sonic-pi-net/sonic-pi dev branch source code.
Covers all gaps identified in the Sonic Pi Web implementation.

---

## 1. Message Flow: Ruby → scsynth

### Two paths exist:

**Path A — Direct UDP (immediate commands):**
```
server.rb: osc(address, args)
  → SCSynthExternal.send(address, args)
    → UDPServer.send → raw UDP to scsynth port
```
Used for: boot commands, synthdef loading, group creation, `/g_freeAll`.

**Path B — Timestamped OSC bundles (scheduled audio):**
```
server.rb: osc_bundle(ts, address, args)
  → SCSynthExternal.send_at(ts, address, args)
    → UDPServer.send_ts → OSC bundle with NTP timetag → UDP to scsynth port
```
Used for: all synth triggers, controls, frees during normal playback.

**Timestamp formula** (`server.rb`):
```ruby
ts = virtual_time + sched_ahead_time + latency + global_timewarp
```

**NTP encoding** (`oscencode.rb`):
```ruby
NTP_EPOCH = 2208988800  # seconds between 1900 and 1970
t1, fr = (time.to_f + NTP_EPOCH).divmod(1)
t2 = (fr * 2**32).to_i
[t1, t2].pack('N2')  # two 32-bit big-endian unsigned ints
```

### Tau (Erlang) role
Tau handles external OSC routing (user `osc` command), MIDI, and Link — NOT audio scheduling. Audio goes directly to scsynth via UDP bundles. Tau uses `erlang:start_timer` for delayed dispatch of non-audio messages.

---

## 2. scsynth Node Tree

```
Root Group (ID 0)
  ├── STUDIO-SYNTHS              (before FX)
  │     └── Run-{jobId}-Synths   (per-run, at tail)
  │           └── [synth nodes]
  ├── STUDIO-FX                  (before mixer)
  │     └── Run-{jobId}-FX       (per-run, at tail)
  │           └── FX Container Group   (per with_fx)
  │                 ├── FX-synths group (at head) ← inner synths go here
  │                 └── FX synth node   (at tail) ← reads in_bus, writes out_bus
  ├── STUDIO-MIXER               (at head of root)
  │     └── sonic-pi-mixer node  (at head)
  └── STUDIO-MONITOR             (after mixer)
        ├── sonic-pi-scope
        ├── sonic-pi-amp_stereo_monitor
        └── sonic-pi-recorder (when recording)
```

**Group creation** (`studio.rb`):
```ruby
@mixer_group   = create_group(:head, 0, "STUDIO-MIXER")
@fx_group      = create_group(:before, @mixer_group, "STUDIO-FX")
@synth_group   = create_group(:before, @fx_group, "STUDIO-SYNTHS")
@monitor_group = create_group(:after, @mixer_group, "STUDIO-MONITOR")
```

**Our current structure:**
```
Group 100 (synths, at head of root)  ← matches STUDIO-SYNTHS
Group 101 (FX, at tail of root)      ← matches STUDIO-FX
[no mixer group]                     ← MISSING
[no monitor group]                   ← not needed for v1
```

---

## 3. The Mixer SynthDef

**sonic-pi-mixer** signal chain (`studio.clj`):

```
in_bus + out_bus → sum
  → pre_amp (varlag slide)
    → HPF (default 22 MIDI ≈ 29Hz, bypassable)
      → LPF (default 135.5 MIDI ≈ 19912Hz, bypassable)
        → force_mono (optional)
          → invert_stereo (optional)
            → Limiter.ar(signal, 0.99, 0.01)  ← hard ceiling, 10ms lookahead
              → LeakDC.ar(signal)              ← DC offset removal
                → amp (varlag slide)
                  → clip2(signal, 1)           ← safety hard clip
                    → HPF 10Hz + LPF 20500Hz  ← safety filters
                      → ReplaceOut.ar(out_bus) ← overwrites bus 0
```

**Key parameters:**
| Param | Default (Ruby) | Default (SynthDef) |
|-------|---------------|-------------------|
| pre_amp | 1 | 1 |
| amp | **6** (set at trigger) | 1 |
| hpf | 0 MIDI | 22 MIDI |
| lpf | 135.5 MIDI | 136 MIDI |
| limiter_bypass | 0 (active) | 0 |
| leak_dc_bypass | 0 (active) | 0 |

**Volume scaling:** `set_volume!` in Ruby sets `pre_amp = vol * 0.2`. Default volume = 1, so `pre_amp = 0.2`. Combined with `amp = 6`: effective gain = `0.2 * 6 = 1.2`.

**Our gap:** We have a Web Audio DynamicsCompressorNode (threshold -6dB, ratio 20:1). Sonic Pi uses `Limiter.ar(signal, 0.99, 0.01)` inside scsynth — a true brickwall limiter at 0.99 with 10ms lookahead. Very different algorithm.

---

## 4. Bus Allocation

- Hardware buses: 0-1 (output), 2-3 (input)
- First private bus: **4** (allocated in stereo pairs)
- Mixer gets the first allocated private bus
- FX chains get subsequent buses

**Our gap:** We start private buses at `NUM_OUTPUT_CHANNELS = 14`. Sonic Pi starts at 4. This doesn't affect sound but differs structurally.

---

## 5. Synth Envelope & Node Lifecycle

**Synths use non-gated envelopes with doneAction=FREE:**
```
shaped-adsr: release_node = -99 (no gate)
Envelope runs: attack → decay → sustain → release → FREE
Total duration = attack + decay + sustain + release (known at trigger time)
```

- Synths are NOT stopped via `gate=0`. They self-terminate.
- `kill_node` sends `/n_free` (immediate removal, not graceful).
- Default ADSR: `attack=0, decay=0, sustain=0, release=1` → 1 second total.

**Our implementation:** We send params to scsynth correctly. The synthdef handles its own lifecycle. No change needed here.

---

## 6. FX Container Group Structure

```
fx_container_group
  ├── fx_synth_group (head) ← inner synths added here
  │     └── [synth nodes write to new_bus]
  └── fx_synth (tail) ← reads new_bus, writes parent out_bus
```

**FX cleanup** (GC thread):
1. Wait for inner synth tracker to finish
2. `Kernel.sleep(kill_delay)` — default 1 second
3. `fx_container_group.kill(true)` — atomic group removal

**FX signal flow** (`def-fx` macro):
```
in_bus → pre_amp → pre_mix split:
  bypass path: (1-pre_mix) * signal
  fx path:     pre_mix * signal → [fx-specific DSP] → wet
→ recombine: wet + bypass
→ XFade2.ar(dry, wet+bypass, mix) → amp → Out.ar(out_bus)
```

**Our implementation:** Now uses `createFxGroup()` + `freeGroup()` with kill_delay. Close match.

---

## 7. Time-State System (set/get/sync/cue)

### CueEvent — the fundamental unit
```ruby
{time, time_r, priority, thread_id, delta, beat, bpm, path, val, meta}
```
Ordered by: `time → priority → thread_id → delta`

`delta` is a per-thread sub-tick counter that increments on every cue/set call, providing total ordering within a single virtual time tick.

### Storage: Trie-based EventHistory
- Path segments form a trie (e.g., `/cue/kick` → `cue` → `kick`)
- Events stored at leaf nodes, sorted newest-first
- Auto-trimmed: max 32 seconds old, min 20 entries

### get (non-blocking read)
1. Check thread-local cache (same-tick reads)
2. Fall back to EventHistory: find most recent event `<= current position`
3. Returns the value, does NOT advance time

### sync (blocking wait for future event)
1. Build lookup from current position (time + priority + thread_id + delta)
2. Check history for event strictly AFTER current position
3. If found → return immediately, teleport virtual time to cue's time
4. If not → register a Promise + EventMatcher, **BLOCK**
5. When cue fires → EventMatcher checks `ce > matcher.ce`, delivers Promise
6. After wakeup → re-check history (race protection)
7. Thread's virtual time **teleports** to the cue's time

### live_loop cues
- Use priority `-100` (lower than normal cues)
- Path: `/live_loop/name`

### Our gap
Our `waitForSync` is simpler — no event history, no multi-dimensional ordering, no delta counter. We park and wait for the next `fireCue`. This is correct for most cases but doesn't handle edge cases like same-tick ordering or chained syncs.

---

## 8. Random Number System

### 441,000 pre-generated floats from WAV files
```ruby
RANDOM_NUMBERS_WHITE = wav_from_buffer_file("rand-stream.wav")  # 441,000 floats
# Also: pink, light_pink, dark_pink, perlin distributions
```

### Per-thread state
```ruby
{seed: number, idx: number}
```

### Core algorithm
```ruby
rand!(max) = random_numbers[(seed + idx + 1) % 441000] * max
# then idx++
# The +1 matches scsynth which "swallows" the first random value
```

### use_random_seed
Resets both seed AND index to 0:
```ruby
set_seed!(seed)  # seed = offset into array, idx = 0
```

### Child thread seeds (deterministic)
```ruby
new_seed = parent.rand!(441000, threadSpawnCount) + parent.seed
# threadSpawnCount is separate from main random index
```

### Determinism guarantee
- Same WAV file → same array, always
- Seed + index is pure arithmetic
- Child threads get deterministic seeds from parent's stream
- Every Run starts with `seed: 0`

### Our gap
We use `SeededRandom` with a PRNG (likely different distribution). To match exactly, we'd need the same 441,000-float array. For approximate correctness, any seeded PRNG works.

---

## 9. Hot-Swap (Re-evaluate)

### The mechanism
```ruby
live_loop(:name) {
  define(:name_body) { block }      # update function definition
  in_thread(name: :name) {          # try to create named thread
    loop {
      __live_loop_cue(:name)
      send(:name_body, res)          # calls LATEST definition
    }
  }
}
```

### On re-run
1. `define(:name_body)` updates the method on `@user_methods`
2. `in_thread(name: :name)` tries to register a named thread
3. If name exists → **NEW thread is killed, OLD thread survives**
4. Old thread calls `send(:name_body)` → picks up new definition on next iteration

### State persistence
**Persists** (in surviving thread): virtual time, tick counters, random seed+idx, BPM, current synth, `res` value
**Changes** (from new define): loop body behavior, on next iteration

### Our gap
We use `scheduler.reEvaluate()` which does `existing.asyncFn = fn` (hot-swap). Similar mechanism but we rebuild the asyncFn closure. With `loopSynced` persistence, sync state now survives. Tick state survives via `loopTicks`. Main remaining difference: we rebuild the ProgramBuilder each iteration (correct — matches `define` + `send` pattern).

---

## 10. Timing Exception Detection

### Binary check, not time threshold
```ruby
# After every loop iteration:
slept  = __thread_locals.get(:sonic_pi_spider_slept)    # set by sleep()
synced = __thread_locals.get(:sonic_pi_spider_synced)    # set by sync()
raise ZeroTimeLoopError unless slept or synced
```

- No time threshold — just "did you call sleep or sync at least once?"
- Even `sleep 0` counts
- `live_loop` uses this same `loop` internally

### Our implementation
We have `InfiniteLoopError` detection via a max-iterations-per-tick cap. Different mechanism but same purpose.

---

## Summary: Gaps vs Sonic Pi for Audio Fidelity

| Area | Sonic Pi | Ours | Impact on Sound |
|------|----------|------|----------------|
| **Mixer/Limiter** | `Limiter.ar(0.99, 0.01)` inside scsynth | Web Audio DynamicsCompressor outside | **HIGH** — different limiting, causes clipping |
| **Mixer amp** | `amp: 6, pre_amp: vol*0.2` | `gain: 0.8` | **HIGH** — different gain staging |
| **Message batching** | Single bundle per sleep | Single bundle per sleep (fixed) | **Fixed** |
| **FX groups** | Container group + atomic kill | Container group + atomic kill (fixed) | **Fixed** |
| **sync/cue** | Event history + multi-dim ordering + delta | Simple wait-for-next-cue | **LOW** — works for common patterns |
| **Random** | 441k pre-gen floats from WAV | Seeded PRNG | **LOW** — affects `choose`/`shuffle` sequences |
| **NTP encoding** | `(time + 2208988800).pack('N2')` | Same formula in osc.ts | **None** — matches |
| **Synth lifecycle** | Non-gated, self-freeing | Same (uses same synthdefs) | **None** |
| **Hot-swap** | kill-new-thread, old survives | asyncFn replacement + loopSynced | **Fixed** — close match |

**#1 priority for audio fidelity: Move the limiter inside scsynth (issue #45).**

---

## 11. SuperSonic NTP Timetag Handling

**Confirmed: SuperSonic fully respects NTP timetags.** The raw OSC bundle bytes (including timetag header) are passed through to scsynth WASM in the AudioWorklet.

### Two-level scheduling
1. **JS Prescheduler** (Web Worker): holds bundles >500ms in the future, dispatches ~500ms before target
2. **scsynth internal scheduler** (WASM): receives raw bundle, processes NTP timetag, executes at sample-accurate time

### Bundle classification
- `timetag = 0 or 1` → "immediate" (execute now)
- `delta < 0` → "late" (already past, execute immediately)
- `delta < 500ms` → "nearFuture" (bypass prescheduler, go direct to scsynth)
- `delta > 500ms` → "farFuture" (held in prescheduler's min-heap)

All categories send raw bundle bytes to scsynth — the timetag is always intact.

### Our `audioTimeToNTP()` is correct
Algebraically equivalent to SuperSonic's internal `ntpStartTime + audioTime`:
```
audioTimeToNTP(t, ctx) = wallNow + (t - ctx) + NTP_EPOCH
                       = (wallNow - ctx + NTP_EPOCH) + t
                       = ntpStartTime + t  ✓
```

No `setClockOffset()` needed (that's for multi-system sync only).

---

## 12. SuperSonic Clock Model

### Clock synchronization at init
```js
ntpStartTime = (performance.timeOrigin + outputTimestamp.performanceTime) / 1000
               + 2208988800 - outputTimestamp.contextTime
```
Establishes: `NTP = ntpStartTime + audioContext.currentTime`

### Three SAB values shared with AudioWorklet
| Value | Type | Purpose |
|-------|------|---------|
| ntpStartTime | Float64 | NTP time when audioCtx.currentTime === 0 |
| driftOffsetMs | Int32 | Wall clock vs audio clock drift (updated every 1s) |
| clockOffsetMs | Int32 | Manual multi-system offset (default 0) |

### Worklet computes current NTP as:
```
currentNTP = ntpStartTime + (sampleCount / sampleRate) + drift/1000 + clockOffset/1000
```

---

## 13. SuperSonic Sample Comparison

### Samples are byte-identical
- SuperSonic `bd_tek.flac`: 21,858 bytes, MD5 `f748d5d8894b9fd1d80ecd096fddecf4`
- Sonic Pi `bd_tek.flac`: 21,858 bytes, MD5 `f748d5d8894b9fd1d80ecd096fddecf4`
- **100% identical** — same bytes, same hash. No re-encoding, no re-normalization.
- `drum_snare_hard.flac` also exists in SuperSonic's pack.
- `PROVENANCE.md` is identical — same CC0 Freesound sources.

### No normalization in SuperSonic's sample pipeline
- `loadSample()` calls `prepareFromFile()` → `b_allocPtr` — straight file-to-buffer, no gain processing.
- Zero references to "normalize", "gainMul", or "ampScale" in SuperSonic's JS source.
- Our `translateSampleOpts` passes `amp` directly to scsynth with no scaling.

### Volume difference is NOT from samples — see section 14 for the real cause.

---

## 14. Sample Parameter Dispatch — Critical Bug Found

### How Sonic Pi picks the sample player
- **Simple opts** (amp, pan, cutoff/lpf, hpf, rate, beat_stretch, rpitch, ADSR): → `basic_stereo_player` (no envelope)
- **Complex opts** (pitch, compress, norm, window_size, start, finish): → `stereo_player` (full envelope + pitch shift)

### Sonic Pi does NOT send all defaults
`normalise_args!` only processes keys already in the hash. The synthdef's compiled defaults handle everything else. For `sample :bd_tek, amp: 1.5, cutoff: 130`, Sonic Pi sends:
```
/s_new "sonic-pi-basic_stereo_player" nodeId 0 groupId
  "out_bus" <bus>
  "buf" <bufId>
  "amp" 1.5
  "lpf" 130.0       ← cutoff ALIASED to lpf by munge_opts
```

### BUG: `cutoff` not aliased to `lpf` in our engine
Sonic Pi's `BasicMonoPlayer.munge_opts` aliases `cutoff` → `lpf`:
```ruby
def munge_opts(studio, args_h)
  alias_opts!(:cutoff, :lpf, args_h)
  alias_opts!(:cutoff_slide, :lpf_slide, args_h)
  # ...
end
```

The synthdef parameter is named `lpf`, NOT `cutoff`. When we send `cutoff: 130`, scsynth ignores it (unrecognized param name). **The low-pass filter never activates on samples.**

This means `cmaster1 = 130` and `cmaster2 = 130` in the DJ Dave code have NO effect on our samples — drums play unfiltered.

### BasicMonoPlayer `arg_defaults`
```ruby
:amp => 1, :pan => 0, :rate => 1, :lpf => -1, :hpf => -1
# lpf=-1 means bypass (no filter). cutoff must be aliased to lpf to work.
```

### MonoPlayer/StereoPlayer `arg_defaults` (envelope player)
```ruby
:amp => 1, :pre_amp => 1, :pan => 0,
:attack => 0, :decay => 0, :sustain => -1, :release => 0,
:attack_level => 1, :decay_level => :sustain_level, :sustain_level => 1,
:env_curve => 2, :rate => 1, :start => 0, :finish => 1,
:lpf => -1, :hpf => -1,
# sustain: -1 means "play full sample duration"
```

### Gaps to fix
| Issue | Severity | Detail |
|-------|----------|--------|
| **`cutoff` → `lpf` aliasing** | **HIGH** | Samples with `cutoff:` send unrecognized param. Filter never activates. |
| **No synthdef selection** | MEDIUM | Complex opts (`pitch`, `start`, `finish`) need `stereo_player`, not `basic_stereo_player` |
| **`hpf` aliasing missing** | LOW | Same issue — if user sends `hpf:`, synthdef expects `hpf` (this one happens to match) |

---

## Updated Summary: All Gaps

| Area | Impact | Status |
|------|--------|--------|
| **`cutoff` → `lpf` aliasing for samples** | **HIGH** — filters don't work on samples | **NEW — needs fix** |
| **Mixer/Limiter inside scsynth** | **HIGH** — clipping, wrong gain staging | Open (#45) |
| **Synthdef selection (basic vs stereo player)** | MEDIUM — `start`/`finish`/`pitch` broken on samples | Needs issue |
| Message batching | Fixed | ✓ |
| FX groups | Fixed | ✓ |
| sync/cue | Fixed (simple model) | ✓ |
| Hot-swap phase | Fixed | ✓ |
| NTP timetags | Verified correct | ✓ |
| Clock model | Verified correct | ✓ |
| Sample files | Verified identical | ✓ |
