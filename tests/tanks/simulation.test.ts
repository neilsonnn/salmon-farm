import { describe, expect, it } from 'vitest'
import { CRUISE_SPEED, FISH_SIZE, FishSchool, FISH_COUNT, MIN_SWIM_SPEED, measureSchool, PENS, TANK_LAYOUT } from '../../src/tanks/simulation'
import { FISH_LENGTH, SPINE_LINKS, SPINE_POINTS } from '../../src/tanks/locomotion'

function isolatedFish() {
  const school = new FishSchool(427)
  for (let i = 0; i < PENS[0].population; i++) {
    school.x[i] = -1.3; school.z[i] = -2.0; school.depth[i] = 0.5
    school.spines.initialize(i, school.heading[i], school.length[i], school.x[i], school.z[i], school.speed[i])
  }
  school.x[0] = 0; school.z[0] = 0; school.depth[0] = 0.5
  school.heading[0] = Math.PI / 2; school.speed[0] = 0.45
  school.spines.initialize(0, school.heading[0], school.length[0], 0, 0, school.speed[0])
  return school
}
function putNeighbor(school: FishSchool, x: number, z: number, depth = 0.5) {
  school.depth[1] = depth; school.heading[1] = Math.PI / 2; school.speed[1] = 0.15
  school.spines.initialize(1, school.heading[1], school.length[1], 0, 0, 0.15)
  school.x[1] = school.x[0] + school.spines.centroidX[0] + x - school.spines.centroidX[1]
  school.z[1] = school.z[0] + school.spines.centroidZ[0] + z - school.spines.centroidZ[1]
  school.spines.initialize(1, school.heading[1], school.length[1], school.x[1], school.z[1], 0.15)
}

describe('Foids schooling with physical swimmers', () => {
  it('preserves the doubled population, compact pens, size cohorts and individual cruising speeds', () => {
    expect(FISH_COUNT).toBe(320)
    expect(PENS.map(p => p.population)).toEqual([144, 48, 56, 32, 16, 24])
    expect(TANK_LAYOUT.halfWidth * TANK_LAYOUT.halfLength / (2.65 * 3.55)).toBeLessThan(0.9)
    const school = new FishSchool(), metrics = measureSchool(school)
    expect(Math.min(...school.length)).toBeGreaterThanOrEqual(FISH_SIZE.min)
    expect(Math.max(...school.length)).toBeLessThanOrEqual(FISH_SIZE.max)
    expect(Math.min(...school.cruiseSpeed)).toBeGreaterThanOrEqual(CRUISE_SPEED.min)
    expect(Math.min(...school.speed)).toBeGreaterThanOrEqual(MIN_SWIM_SPEED)
    expect(metrics.sizeP90 / metrics.sizeP10).toBeGreaterThan(1.4)
    expect(metrics.sizeP90 / metrics.sizeP10).toBeLessThan(1.9)
    expect(metrics.radiusP90 - metrics.radiusP10).toBeGreaterThan(0.58)
  })

  it('sustains a moving mill for a minute without net crossings, backwards wriggling or broken bodies', async () => {
    const school = new FishSchool()
    let reverse = 0, samples = 0, angularTravel = 0, slip = 0, maxResidual = 0
    let straightSlip = 0, straightSamples = 0, tailCruise = 0
    const lastAngles = Array.from(school.x, (x, i) => Math.atan2(school.z[i] - PENS[school.penIndex[i]].z, x - PENS[school.penIndex[i]].x))
    for (let step = 0; step < 3600; step++) {
      school.step(1 / 60)
      if (step % 60 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      for (let i = 0; i < PENS[0].population; i++) {
        const angle = Math.atan2(school.z[i], school.x[i])
        angularTravel += Math.atan2(Math.sin(angle - lastAngles[i]), Math.cos(angle - lastAngles[i]))
        lastAngles[i] = angle
      }
      for (let i = 0; i < school.count; i++) {
        if (!Number.isFinite(school.x[i] + school.z[i] + school.heading[i] + school.speed[i])) throw new Error('Nonfinite fish ' + i)
        maxResidual = Math.max(maxResidual, school.spines.solverResidual[i])
        if (step > 180) {
          const forward = school.spines.velocityX[i] * Math.cos(school.heading[i]) + school.spines.velocityZ[i] * Math.sin(school.heading[i])
          const lateral = -school.spines.velocityX[i] * Math.sin(school.heading[i]) + school.spines.velocityZ[i] * Math.cos(school.heading[i])
          reverse += forward < -0.025 ? 1 : 0; samples++
          const slipAngle = Math.abs(Math.atan2(lateral, forward))
          slip += slipAngle
          let torsoBend = 0
          for (let k = 1; k <= Math.floor(SPINE_LINKS * 0.55); k++) {
            torsoBend += Math.abs(school.spines.yaw[i * SPINE_LINKS + k] - school.spines.yaw[i * SPINE_LINKS + k - 1])
          }
          if (torsoBend < 0.22) { straightSlip += slipAngle; straightSamples++ }
          if (school.spines.recruitment[i] < 0.3) tailCruise++
        }
        if (step % 30 !== 0) continue
        const pen = PENS[school.penIndex[i]]
        for (let k = 0; k < SPINE_POINTS; k++) {
          const x = school.x[i] + school.spines.offsetX[i * SPINE_POINTS + k]
          const z = school.z[i] + school.spines.offsetZ[i * SPINE_POINTS + k]
          if (Math.abs(x - pen.x) > pen.halfWidth || Math.abs(z - pen.z) > pen.halfLength) throw new Error('Fish crossed its net: ' + i)
        }
        if (school.depth[i] < 0.179 || school.depth[i] > 1.501) throw new Error('Invalid depth: ' + i)
      }
    }
    const metrics = measureSchool(school)
    expect(metrics.rotation).toBeGreaterThan(0.85)
    expect(metrics.polarization).toBeLessThan(0.4)
    expect(metrics.meanSpeed).toBeGreaterThan(0.2)
    expect(metrics.speedP10).toBeGreaterThan(0.1)
    expect(metrics.speedP90 - metrics.speedP10).toBeGreaterThan(0.16)
    expect(metrics.radiusP90 - metrics.radiusP10).toBeGreaterThan(0.35)
    expect(metrics.meanRadius).toBeLessThan(0.95)
    expect(angularTravel / PENS[0].population / (2 * Math.PI)).toBeGreaterThan(0.85)
    expect(reverse / samples).toBeLessThan(0.0001)
    // A bent power stroke pushes laterally. Guard straight-torso drift directly,
    // while allowing those supported transient angles in the complete population.
    expect(straightSamples / samples).toBeGreaterThan(0.1)
    expect(straightSlip / straightSamples).toBeLessThan(0.22)
    expect(slip / samples).toBeLessThan(0.35)
    expect(tailCruise / samples).toBeGreaterThan(0.1)
    expect(maxResidual).toBeLessThanOrEqual(0.001)
    expect(school.time).toBeCloseTo(60, 5)
  }, 180000)

  it('changes muscle navigation for a close neighbor while ignoring a fish below its sensing volume', () => {
    const baseline = isolatedFish(), neighbor = isolatedFish(), deep = isolatedFish()
    const headway = (neighbor.length[0] + neighbor.length[1]) * FISH_LENGTH * 0.36
    putNeighbor(neighbor, 0.08, headway); putNeighbor(deep, 0.08, headway, 1.5)
    // Inspect decisions before the differently positioned neighbors can move.
    baseline.step(1 / 60); neighbor.step(1 / 60); deep.step(1 / 60)
    expect(neighbor.curvature[0]).toBeGreaterThan(baseline.curvature[0])
    expect(deep.curvature[0]).toBeCloseTo(baseline.curvature[0], 5)
  })

  it('uses physical braking when a slower fish obstructs its path', () => {
    const clear = isolatedFish(), blocked = isolatedFish()
    putNeighbor(blocked, 0, (blocked.length[0] + blocked.length[1]) * FISH_LENGTH * 0.36)
    for (let step = 0; step < 20; step++) { clear.step(1 / 60); blocked.step(1 / 60) }
    expect(blocked.speed[0]).toBeLessThan(clear.speed[0])
  })

  it('makes different navigation decisions for a threatening ripple and food', () => {
    const baseline = isolatedFish(), startled = isolatedFish(), feeding = isolatedFish()
    startled.disturb(0.3, 0.2, 'ripple'); feeding.disturb(0.3, 0.2, 'food')
    for (let step = 0; step < 20; step++) { baseline.step(1 / 60); startled.step(1 / 60); feeding.step(1 / 60) }
    expect(startled.curvature[0]).toBeGreaterThan(baseline.curvature[0])
    expect(feeding.curvature[0]).toBeLessThan(baseline.curvature[0])
  })

  it('coasts down when muscles stop, without a hidden speed floor or yaw servo', () => {
    const swimming = new FishSchool(72), coasting = new FishSchool(72)
    coasting.motorGain.fill(0)
    for (let step = 0; step < 180; step++) { swimming.step(1 / 60); coasting.step(1 / 60) }
    const mean = (values: Float32Array) => values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean(coasting.speed)).toBeLessThan(mean(swimming.speed) * 0.65)
    // Passive fish can rotate when their bodies contact a net; disabling motors
    // must remove propulsion, without suppressing that external torque.
  }, 20000)

  it('bounds disturbance storage and expires old events', () => {
    const school = new FishSchool()
    expect(school.disturb(TANK_LAYOUT.pitchX / 2, 0)).toBe(false)
    expect(school.disturb(100, 100)).toBe(false)
    for (let i = 0; i < 12; i++) school.disturb(i * 0.1, 0)
    expect(school.disturbances).toHaveLength(8)
    school.disturbances.forEach(event => { event.age = 5 })
    school.step(1 / 60)
    expect(school.disturbances).toHaveLength(0)
  })

  it('reproduces seeded mechanics and attention while bounding interruption catch-up', () => {
    const a = new FishSchool(72), b = new FishSchool(72)
    a.step(10); b.step(1 / 30)
    expect(a.time).toBeCloseTo(1 / 30)
    expect(a.x).toEqual(b.x)
    expect(a.spines.packed).toEqual(b.spines.packed)
    expect(a.attention).toEqual(b.attention)
    expect(new FishSchool(73).x).not.toEqual(new FishSchool(72).x)
  })
})
