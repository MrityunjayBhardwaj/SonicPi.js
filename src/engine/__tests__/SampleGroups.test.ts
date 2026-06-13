import { describe, it, expect } from 'vitest'
import {
  getSampleNamesByGroup,
  getSampleGroupNames,
  getAllGroupedSampleNames,
  getGroupedSamples,
  getSampleNames,
} from '../SampleCatalog'

/**
 * #543 — `sample_names(group)` returned the WHOLE flat catalog (~270 names)
 * regardless of the group argument, so `choose(sample_names :ambi)` picked from
 * the wrong set and diverged from desktop (ambient_noctrl / sw_ambient).
 *
 * Desktop ground truth (sound.rb:3229-3266):
 *   sample_names(group) = grouped_samples[group][:samples].sort.ring  (raise if unknown)
 *   all_sample_names    = all_samples.sort.ring
 *   sample_groups       = grouped_samples.keys.sort.ring
 * grouped_samples is synthinfo.rb:9304-9604. The `.sort` means INSERTION order
 * never reaches user code — membership + alphabetical order are what matter.
 */
describe('sample groups (#543)', () => {
  it('sample_names(:ambi) returns the 11 ambi members, alphabetically sorted', () => {
    expect(getSampleNamesByGroup('ambi')).toEqual([
      'ambi_choir', 'ambi_dark_woosh', 'ambi_drone', 'ambi_glass_hum',
      'ambi_glass_rub', 'ambi_haunted_hum', 'ambi_lunar_land', 'ambi_piano',
      'ambi_sauna', 'ambi_soft_buzz', 'ambi_swoosh',
    ])
  })

  it('sample_names is sorted (matches desktop .sort) and group-scoped, not the full catalog', () => {
    const drums = getSampleNamesByGroup('drum')
    expect(drums).toEqual([...drums].sort())
    expect(drums).toHaveLength(20)
    // every member belongs to the group (prefix) — no leakage of other groups
    expect(drums.every(n => n.startsWith('drum_'))).toBe(true)
    // NOT the whole catalog (the bug returned ~270)
    expect(drums.length).toBeLessThan(getSampleNames().length)
  })

  it('raises on an unknown group (desktop `raise`), never silently returns all', () => {
    expect(() => getSampleNamesByGroup('not_a_group')).toThrow(/Unknown sample group/)
  })

  it('sample_groups returns the 18 group keys, sorted', () => {
    const groups = getSampleGroupNames()
    expect(groups).toEqual([...groups].sort())
    expect(groups).toEqual([
      'ambi', 'arovane', 'bass', 'bd', 'drum', 'elec', 'glitch', 'guit', 'hat',
      'loop', 'mehackit', 'misc', 'perc', 'ride', 'sn', 'tabla', 'tbd', 'vinyl',
    ])
  })

  it('all_sample_names is every grouped member, sorted, disjoint (no dupes)', () => {
    const all = getAllGroupedSampleNames()
    expect(all).toEqual([...all].sort())
    expect(new Set(all).size).toBe(all.length)
    const grouped = getGroupedSamples()
    const flatCount = Object.values(grouped).reduce((n, g) => n + g.length, 0)
    expect(all).toHaveLength(flatCount)
  })

  it('every grouped sample exists in the loadable flat catalog (consistency guard)', () => {
    const loadable = new Set(getSampleNames())
    const missing = getAllGroupedSampleNames().filter(n => !loadable.has(n))
    expect(missing).toEqual([])
  })
})
