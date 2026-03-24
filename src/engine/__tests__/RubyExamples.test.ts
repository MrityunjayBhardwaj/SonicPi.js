import { describe, it, expect } from 'vitest'
import { autoTranspile } from '../RubyTranspiler'
import { VirtualTimeScheduler } from '../VirtualTimeScheduler'
import { createDSLContext } from '../DSLContext'
import { transpile, createExecutor } from '../Transpiler'

/**
 * Run transpiled code in a real scheduler to verify it's valid and executable.
 * Returns any error thrown during execution.
 */
async function runCode(rubyCode: string): Promise<{ error?: Error; events: string[] }> {
  const events: string[] = []
  const scheduler = new VirtualTimeScheduler({
    getAudioTime: () => 0,
    schedAheadTime: 100,
  })
  scheduler.onEvent((e) => events.push(`${e.type}:${e.taskId}@${e.virtualTime}`))
  const dsl = createDSLContext({ scheduler })

  // Top-level support
  let defaultBpm = 60
  let defaultSynth = 'beep'
  const wrappedLiveLoop = (name: string, asyncFn: (ctx: unknown) => Promise<void>) => {
    dsl.live_loop(name, asyncFn)
    const task = scheduler.getTask(name)
    if (task) {
      task.bpm = defaultBpm
      task.currentSynth = defaultSynth
    }
  }

  try {
    const jsCode = autoTranspile(rubyCode)
    const { code: transpiledCode } = transpile(jsCode)

    const dslNames = [
      'live_loop', 'use_bpm', 'use_synth',
      'ring', 'spread', 'noteToMidi', 'midiToFreq', 'noteToFreq',
      'console',
    ]
    const dslValues = [
      wrappedLiveLoop,
      (bpm: number) => { defaultBpm = bpm },
      (name: string) => { defaultSynth = name },
      dsl.ring, dsl.spread,
      dsl.noteToMidi, dsl.midiToFreq, dsl.noteToFreq,
      console,
    ]

    const executor = createExecutor(transpiledCode, dslNames)
    await executor(...dslValues)

    // Run a few ticks to execute the code
    for (let t = 0; t < 10; t++) {
      scheduler.tick(100)
      await new Promise((r) => setTimeout(r, 0))
    }

    scheduler.stop()
    return { events }
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)), events }
  } finally {
    scheduler.dispose()
  }
}

describe('20 Real Sonic Pi Examples', () => {

  // =========================================================================
  // 1. Basic melody — from Sonic Pi tutorial ch. 2
  // =========================================================================
  it('1. Basic melody', async () => {
    const { error, events } = await runCode(`
play 60
sleep 0.5
play 62
sleep 0.5
play 64
sleep 0.5
play 65
sleep 0.5
play 67
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(5)
  })

  // =========================================================================
  // 2. Simple drums — from Sonic Pi tutorial
  // =========================================================================
  it('2. Simple drum loop', async () => {
    const { error, events } = await runCode(`
live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 3. Times loop — from tutorial ch. 5
  // =========================================================================
  it('3. Times loop', async () => {
    const { error, events } = await runCode(`
3.times do
  play 75
  sleep 1.75
  play 74
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(6)
  })

  // =========================================================================
  // 4. Synth selection — from tutorial ch. 3
  // =========================================================================
  it('4. Synth selection', async () => {
    const { error, events } = await runCode(`
live_loop :synths do
  use_synth :prophet
  play 60
  sleep 0.5
  use_synth :tb303
  play 48
  sleep 0.5
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 5. Random melody — from tutorial ch. 6
  // =========================================================================
  it('5. Random melody', async () => {
    const { error, events } = await runCode(`
live_loop :random_melody do
  use_random_seed 42
  play rrand_i(50, 95)
  sleep 0.5
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  // =========================================================================
  // 6. Multiple live loops — from tutorial ch. 9
  // =========================================================================
  it('6. Multiple live loops', async () => {
    const { error, events } = await runCode(`
live_loop :bass do
  use_synth :tb303
  play 36
  sleep 1
end

live_loop :hihat do
  sample :sn_dub
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    const bassEvents = events.filter(e => e.includes('bass'))
    const hihatEvents = events.filter(e => e.includes('hihat'))
    expect(bassEvents.length).toBeGreaterThanOrEqual(1)
    expect(hihatEvents.length).toBeGreaterThanOrEqual(1)
  })

  // =========================================================================
  // 7. Use BPM — from tutorial ch. 8
  // =========================================================================
  it('7. Use BPM', async () => {
    const { error, events } = await runCode(`
use_bpm 120

live_loop :fast do
  play 60
  sleep 0.25
  play 64
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 8. Sample with opts — common Sonic Pi pattern
  // =========================================================================
  it('8. Sample with options', async () => {
    const { error, events } = await runCode(`
live_loop :breakbeat do
  sample :bd_haus, amp: 2
  sleep 0.5
  sample :sn_dub, rate: 0.8
  sleep 0.5
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 9. Ring with tick — common pattern
  // =========================================================================
  it('9. Ring with tick', async () => {
    const { error, events } = await runCode(`
live_loop :melody do
  use_synth :beep
  play ring(60, 64, 67, 72).tick
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(4)
  })

  // =========================================================================
  // 10. Choose from list — randomness
  // =========================================================================
  it('10. Choose from list', async () => {
    const { error, events } = await runCode(`
live_loop :random_notes do
  use_random_seed 1234
  play choose([60, 64, 67, 72])
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  // =========================================================================
  // 11. Sync and cue — inter-loop communication
  // =========================================================================
  it('11. Sync and cue', async () => {
    const { error, events } = await runCode(`
live_loop :metro do
  cue :tick
  sleep 1
end

live_loop :player, sync: :tick do
  play 60
  sleep 1
end
    `)
    expect(error).toBeUndefined()
    // Both loops should produce events
    expect(events.length).toBeGreaterThanOrEqual(1)
  })

  // =========================================================================
  // 12. Nested times in live_loop
  // =========================================================================
  it('12. Nested times in live_loop', async () => {
    const { error, events } = await runCode(`
live_loop :pattern do
  4.times do
    play 60
    sleep 0.25
  end
  4.times do
    play 67
    sleep 0.25
  end
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(8)
  })

  // =========================================================================
  // 13. Play with note names
  // =========================================================================
  it('13. Play with note names', async () => {
    const { error, events } = await runCode(`
play :c4
sleep 0.5
play :e4
sleep 0.5
play :g4
sleep 0.5
play :c5
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(4)
  })

  // =========================================================================
  // 14. Euclidean rhythm with spread
  // =========================================================================
  it('14. Euclidean rhythm', async () => {
    const { error, events } = await runCode(`
live_loop :euclidean do
  play 60 if spread(3, 8).tick
  sleep 0.25
end
    `)
    // spread().tick returns boolean, 'play 60 if ...' is Ruby conditional
    // This tests the transpiler handles 'if' at end of line
    expect(error).toBeUndefined()
  })

  // =========================================================================
  // 15. Multiple synths — layered sound
  // =========================================================================
  it('15. Layered synths', async () => {
    const { error, events } = await runCode(`
live_loop :layer1 do
  use_synth :saw
  play 48, release: 0.2
  sleep 0.5
end

live_loop :layer2 do
  use_synth :beep
  play 60, release: 0.1
  sleep 0.25
end

live_loop :layer3 do
  sample :bd_haus
  sleep 1
end
    `)
    expect(error).toBeUndefined()
    expect(events.filter(e => e.includes('layer1')).length).toBeGreaterThanOrEqual(1)
    expect(events.filter(e => e.includes('layer2')).length).toBeGreaterThanOrEqual(1)
    expect(events.filter(e => e.includes('layer3')).length).toBeGreaterThanOrEqual(1)
  })

  // =========================================================================
  // 16. Comments everywhere
  // =========================================================================
  it('16. Comments everywhere', async () => {
    const { error, events } = await runCode(`
# Main beat
live_loop :beat do
  sample :bd_haus  # kick
  sleep 0.5
  sample :sn_dub   # snare
  sleep 0.5        # half beat rest
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  // =========================================================================
  // 17. Complex rhythm pattern
  // =========================================================================
  it('17. Complex rhythm pattern', async () => {
    const { error, events } = await runCode(`
use_bpm 140

live_loop :kick do
  sample :bd_haus
  sleep 1
end

live_loop :snare do
  sleep 0.5
  sample :sn_dub
  sleep 0.5
end

live_loop :hat do
  sample :sn_dub, rate: 2, amp: 0.3
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(3)
  })

  // =========================================================================
  // 18. Random seed + choose — deterministic random melody
  // =========================================================================
  it('18. Deterministic random melody', async () => {
    const { error, events } = await runCode(`
live_loop :melody do
  use_synth :prophet
  use_random_seed 5678
  8.times do
    play choose([60, 62, 64, 65, 67, 69, 71, 72])
    sleep 0.25
  end
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(8)
  })

  // =========================================================================
  // 19. Times with iterator variable
  // =========================================================================
  it('19. Times with iterator', async () => {
    const { error, events } = await runCode(`
live_loop :ascending do
  8.times do |i|
    play 60 + i
    sleep 0.125
  end
end
    `)
    expect(error).toBeUndefined()
    expect(events.length).toBeGreaterThanOrEqual(8)
  })

  // =========================================================================
  // 20. Full composition — drums + bass + melody
  // =========================================================================
  it('20. Full composition', async () => {
    const { error, events } = await runCode(`
use_bpm 110

live_loop :drums do
  sample :bd_haus
  sleep 0.5
  sample :sn_dub
  sleep 0.25
  sample :bd_haus
  sleep 0.25
end

live_loop :bass do
  use_synth :tb303
  play 36, release: 0.2, cutoff: 70
  sleep 0.5
  play 36, release: 0.2, cutoff: 80
  sleep 0.25
  play 38, release: 0.2, cutoff: 90
  sleep 0.25
end

live_loop :melody do
  use_synth :prophet
  use_random_seed 42
  play choose([60, 64, 67, 72]), release: 0.3, amp: 0.5
  sleep 0.25
end
    `)
    expect(error).toBeUndefined()
    const drums = events.filter(e => e.includes('drums'))
    const bass = events.filter(e => e.includes('bass'))
    const melody = events.filter(e => e.includes('melody'))
    expect(drums.length).toBeGreaterThanOrEqual(3)
    expect(bass.length).toBeGreaterThanOrEqual(3)
    expect(melody.length).toBeGreaterThanOrEqual(1)
  })

})
