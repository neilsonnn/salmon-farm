import { describe, expect, it } from 'vitest'
import { FishSchool, PENS } from '../../src/tanks/simulation'
import { readFishState, STATE_STRIDE, writeFishState } from '../../src/tanks/physicsProtocol'

describe('Parallel fish mechanics', () => {
  it('produces identical physical trajectories when independent pens are partitioned', () => {
    const all = new FishSchool(52), main = new FishSchool(52, 1), outer = new FishSchool(52, 62)
    for (let step = 0; step < 30; step++) {
      for (const school of [all, main, outer]) {
        if (step === 12) school.disturb(0.4, 0.2)
        school.step(1 / 60)
      }
    }
    for (let i = 0; i < all.count; i++) {
      const shard = i < PENS[0].population ? main : outer
      expect(shard.x[i]).toBe(all.x[i]); expect(shard.z[i]).toBe(all.z[i])
      expect(shard.heading[i]).toBe(all.heading[i]); expect(shard.phase[i]).toBe(all.phase[i])
      for (let k = 0; k < all.spines.packed.length; k++) {
        expect(Array.from(shard.spines.packed[k].subarray(i * 4, i * 4 + 4)))
          .toEqual(Array.from(all.spines.packed[k].subarray(i * 4, i * 4 + 4)))
      }
    }
  }, 10000)

  it('transports complete centerline/fin poses while preserving the other worker\'s fish', () => {
    const source = new FishSchool(52), target = new FishSchool(52)
    source.step(1 / 60)
    const start = PENS[0].population, end = source.count
    const original = target.x.slice(0, start)
    const state = new Float32Array((end - start) * STATE_STRIDE)
    writeFishState(source, start, end, state); readFishState(target, start, end, state)
    expect(target.x.slice(0, start)).toEqual(original)
    expect(target.x.slice(start)).toEqual(source.x.slice(start))
    for (let k = 0; k < source.spines.packed.length; k++) {
      expect(target.spines.packed[k].slice(start * 4)).toEqual(source.spines.packed[k].slice(start * 4))
    }
    expect(target.spines.fins.slice(start * 4)).toEqual(source.spines.fins.slice(start * 4))
    expect(Array.from(state).every(Number.isFinite)).toBe(true)
  })
})
