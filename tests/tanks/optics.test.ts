import { describe, expect, it } from 'vitest'
import { MAX_REFRACTION_PIXELS, MURKINESS, refractionPixelOffset, waterTransmittance } from '../../src/tanks/optics'

describe('Silted water visibility', () => {
  it('retains shallow highlights while largely extinguishing lower and deeper fish', () => {
    const surface = waterTransmittance(0.12)
    const dorsal = waterTransmittance(0.15)
    const underside = waterTransmittance(0.35)
    expect(Math.min(...surface)).toBeGreaterThan(0.6)
    for (let channel = 0; channel < 3; channel++) expect(underside[channel]).toBeLessThan(dorsal[channel] * 0.4)
    expect(Math.max(...waterTransmittance(0.6))).toBeLessThan(0.06)
    expect(Math.max(...waterTransmittance(0.9))).toBeLessThan(0.01)
  })

  it('fades continuously with depth and increases extinction as the murk slider rises', () => {
    let previous = waterTransmittance(0)
    for (let depth = 0.05; depth <= 2; depth += 0.05) {
      const current = waterTransmittance(depth)
      for (let channel = 0; channel < 3; channel++) {
        expect(current[channel]).toBeLessThan(previous[channel])
        expect(current[channel]).toBeGreaterThanOrEqual(0)
      }
      previous = current
    }
    const clear = waterTransmittance(0.5, MURKINESS.min)
    const turbid = waterTransmittance(0.5, MURKINESS.max)
    for (let channel = 0; channel < 3; channel++) expect(turbid[channel]).toBeLessThan(clear[channel] * 0.1)
  })

  it('keeps surface refraction coherent across render resolutions', () => {
    for (const size of [[320, 240], [2560, 1600], [7680, 4320]]) {
      for (const slope of [[0, 0], [0.03, -0.02], [1.8, -1.5]]) {
        const shift = refractionPixelOffset(slope[0], slope[1], size[0], size[1])
        expect(Math.hypot(shift.x, shift.y)).toBeLessThanOrEqual(MAX_REFRACTION_PIXELS + 0.000001)
      }
    }
  })
})
