/**
 * Tests for the recording_* DSL surface (#228).
 *
 * Two layers:
 *   1. ProgramBuilder methods — recording_* are deferred steps. Arity guards
 *      live in the builder so they fire at build time and propagate via the
 *      runtimeErrorHandler. This mirrors the cross-engine ethic: Desktop SP
 *      signatures are fixed-arity; JS rejects extra args rather than
 *      silently swallowing them.
 *   2. Static helper — Recorder.saveBlobToDownload was extracted from
 *      stopAndDownload so the engine's recordingSave step can call it
 *      without an instance.
 *
 * Bridge-null behaviour and full audio capture are verified by the Level-3
 * capture-tool fixture, not by Vitest.
 */
import { describe, it, expect } from 'vitest'
import { ProgramBuilder } from '../ProgramBuilder'
import { Recorder } from '../Recorder'

describe('Recorder.saveBlobToDownload (#228)', () => {
  it('is exposed as a static method so recordingSave can call it without an instance', () => {
    expect(typeof Recorder.saveBlobToDownload).toBe('function')
    expect(Recorder.saveBlobToDownload.length).toBeLessThanOrEqual(2)
  })
})

describe('ProgramBuilder.recording_* (#228)', () => {
  it('recording_start pushes a recordingStart step', () => {
    const b = new ProgramBuilder()
    b.recording_start()
    const program = b.build()
    expect(program).toEqual([{ tag: 'recordingStart' }])
  })

  it('recording_stop pushes a recordingStop step', () => {
    const b = new ProgramBuilder()
    b.recording_stop()
    expect(b.build()).toEqual([{ tag: 'recordingStop' }])
  })

  it('recording_save pushes a recordingSave step with the filename', () => {
    const b = new ProgramBuilder()
    b.recording_save('out.wav')
    expect(b.build()).toEqual([{ tag: 'recordingSave', filename: 'out.wav' }])
  })

  it('recording_delete pushes a recordingDelete step', () => {
    const b = new ProgramBuilder()
    b.recording_delete()
    expect(b.build()).toEqual([{ tag: 'recordingDelete' }])
  })

  it('recording_* steps interleave with sleep so the lifecycle sequences against playback', () => {
    // The whole point of deferring: build a program where stop and save
    // come AFTER play steps, not before. Without this, recording_save
    // fires before any audio plays and lastRecording is null.
    const b = new ProgramBuilder()
    b.recording_start()
    b.play(60, {})
    b.sleep(0.25)
    b.play(64, {})
    b.sleep(0.25)
    b.recording_stop()
    b.recording_save('test.wav')
    const program = b.build()
    expect(program[0].tag).toBe('recordingStart')
    expect(program[1].tag).toBe('play')
    expect(program[2].tag).toBe('sleep')
    expect(program[3].tag).toBe('play')
    expect(program[4].tag).toBe('sleep')
    expect(program[5].tag).toBe('recordingStop')
    expect(program[6].tag).toBe('recordingSave')
  })

  // SP52 cross-engine ethic — fixed-arity matching Desktop SP. Without
  // these throws, `recording_start :foo` would silently swallow the arg
  // and the user would be mystified about why their nonsense compiled.
  it('recording_start throws on extra arguments', () => {
    const b = new ProgramBuilder()
    expect(() => b.recording_start('extra')).toThrow(/recording_start expects no arguments/)
  })

  it('recording_stop throws on extra arguments', () => {
    const b = new ProgramBuilder()
    expect(() => b.recording_stop('extra')).toThrow(/recording_stop expects no arguments/)
  })

  it('recording_delete throws on extra arguments', () => {
    const b = new ProgramBuilder()
    expect(() => b.recording_delete('extra')).toThrow(/recording_delete expects no arguments/)
  })

  it('recording_save throws on zero or extra arguments', () => {
    const b = new ProgramBuilder()
    expect(() => (b.recording_save as (...args: unknown[]) => unknown)()).toThrow(/recording_save expects 1 argument/)
    expect(() => (b.recording_save as (...args: unknown[]) => unknown)('a', 'b')).toThrow(/recording_save expects 1 argument/)
  })

  it('recording_save throws on non-string filenames', () => {
    const b = new ProgramBuilder()
    expect(() => (b.recording_save as (...args: unknown[]) => unknown)(42)).toThrow(/filename must be a string/)
  })
})
