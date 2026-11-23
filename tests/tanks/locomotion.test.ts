import { describe, expect, it } from 'vitest'
import { BODY_MASS, FISH_LENGTH, FoidSpines, SPINE_LINKS, SPINE_POINTS, type SwimCommand } from '../../src/tanks/locomotion'
const SCALE = 0.6, TAU = Math.PI * 2
function command(time: number, overrides: Partial<SwimCommand> = {}): SwimCommand {
  return { turn: 0, effort: 0.8, frequency: 2.3, phase: time * 2.3 * TAU, gain: 1, brake: 0, ...overrides }
}
function run(body: FoidSpines, duration: number, overrides: Partial<SwimCommand> = {}, dt = 1 / 120) {
  for (let step = 0; step < Math.round(duration / dt); step++) body.advance(0, SCALE, command((step + 1) * dt, overrides), dt)
}
function make(fluid?: { addedMass: number; resistance: number }, speed = 0.3) {
  const body = new FoidSpines(1, fluid)
  body.initialize(0, 0, SCALE, 0, 0, speed)
  return body
}

describe('Coupled fish mechanics', () => {
  it('cannot propel its mass center with internal muscle torques in a vacuum', () => {
    const body = make({ addedMass: 0, resistance: 0 })
    const startX = body.centerX[0], startZ = body.centerZ[0]
    run(body, 3, { turn: 0.7 })
    const state = body.mechanics(0, SCALE)
    expect(body.centerX[0] - startX).toBeCloseTo(0.9, 10)
    expect(body.centerZ[0]).toBeCloseTo(startZ, 10)
    expect(state.momentumX).toBeCloseTo(0.3, 10)
    expect(state.momentumZ).toBeCloseTo(0, 10)
    // Angular momentum converges with the integrator; no external yaw torque exists.
    expect(Math.abs(state.angularMomentum)).toBeLessThan(0.00015)
    expect(state.squaredBend).toBeGreaterThan(0.01)
  })

  it('keeps an unpowered stationary fish still despite arbitrary steering requests', () => {
    const body = make(undefined, 0), x = body.centerX[0]
    run(body, 3, { gain: 0, turn: 2, effort: 1.4 })
    expect(body.centerX[0]).toBe(x)
    expect(body.centerZ[0]).toBe(0)
    expect(body.heading[0]).toBe(0)
    expect(body.velocityX[0]).toBe(0)
    expect(body.mechanics(0, SCALE).kineticEnergy).toBe(0)
  })

  it('dissipates energy under passive water resistance without inventing thrust', () => {
    const body = make(), initial = body.mechanics(0, SCALE).kineticEnergy
    let energy = initial
    for (let step = 0; step < 480; step++) {
      body.advance(0, SCALE, command((step + 1) / 120, { gain: 0 }), 1 / 120)
      const next = body.mechanics(0, SCALE).kineticEnergy
      expect(next).toBeLessThanOrEqual(energy + 1e-10)
      expect(body.fluidPower[0]).toBeLessThanOrEqual(0)
      energy = next
    }
    expect(energy).toBeLessThan(initial * 0.7)
    expect(body.velocityX[0]).toBeGreaterThan(0)
  })

  it('keeps passive tissue mechanics independent of an inactive motor clock', () => {
    const slow = make(undefined, 0), fast = make(undefined, 0)
    for (const body of [slow, fast]) { body.yaw[3] = 0.12; body.updatePose(0, SCALE) }
    run(slow, 1, { gain: 0, frequency: 1.3 })
    run(fast, 1, { gain: 0, frequency: 3.6 })
    expect(slow.yaw).toEqual(fast.yaw)
    expect(slow.centerX[0]).toBe(fast.centerX[0])
    expect(slow.centerZ[0]).toBe(fast.centerZ[0])
    expect(slow.elasticEnergy[0]).toBe(fast.elasticEnergy[0])
  })

  it('accelerates from rest through water reaction, with the tail supplying most propulsion', () => {
    const full = make(undefined, 0), tail = make(undefined, 0), fins = make(undefined, 0)
    // A starting stroke recruits the axial body; the ablation isolates that
    // body's caudal propulsion from the much smaller paired-fin contribution.
    run(full, 4, { power: 1 }); run(tail, 4, { finActivity: 0, power: 1 }); run(fins, 4, { bodyActivity: 0, power: 1 })
    const forward = (body: FoidSpines) => body.velocityX[0] * Math.cos(body.heading[0]) + body.velocityZ[0] * Math.sin(body.heading[0])
    expect(forward(tail)).toBeGreaterThan(0.2)
    expect(forward(full)).toBeGreaterThan(0.2)
    expect(Math.abs(forward(fins))).toBeLessThan(Math.abs(forward(tail)) * 0.15)
    expect(Math.abs(full.fins[0])).toBeLessThan(0.04)
    expect(Math.abs(full.fins[1])).toBeLessThan(0.04)
    expect(Math.abs(full.fins[2])).toBeLessThan(0.10)
    expect(Math.abs(full.fins[3])).toBeLessThan(0.10)
  })

  it('produces mirrored physical turns with mirrored muscle activation', () => {
    const left = make(), right = make()
    for (let step = 0; step < 480; step++) {
      const time = (step + 1) / 120
      left.advance(0, SCALE, command(time, { turn: 0.4 }), 1 / 120)
      // Negating the complete wave mirrors all joint torques, including the tail beat.
      right.advance(0, SCALE, command(time, { turn: -0.4, phase: time * 2.3 * TAU + Math.PI }), 1 / 120)
    }
    expect(left.heading[0]).toBeGreaterThan(0.5)
    expect(right.heading[0]).toBeLessThan(-0.5)
    expect(left.centerX[0]).toBeCloseTo(right.centerX[0], 4)
    expect(left.centerZ[0]).toBeCloseTo(-right.centerZ[0], 4)
    for (let k = 0; k < SPINE_LINKS; k++) expect(left.yaw[k]).toBeCloseTo(-right.yaw[k], 4)
  })

  it('tracks turning through body-supported forward travel during a reversal', () => {
    const body = make()
    let backwards = 0, minForward = 1, maxBend = 0, reversalHeading = 0
    for (let step = 0; step < 960; step++) {
      if (step === 480) reversalHeading = body.heading[0]
      body.advance(0, SCALE, command((step + 1) / 120, { turn: step < 480 ? 0.45 : -0.45 }), 1 / 120)
      const forward = body.velocityX[0] * Math.cos(body.heading[0]) + body.velocityZ[0] * Math.sin(body.heading[0])
      minForward = Math.min(minForward, forward)
      if (forward < 0) backwards++
      for (let k = 1; k < SPINE_LINKS; k++) maxBend = Math.max(maxBend, Math.abs(body.yaw[k] - body.yaw[k - 1]))
      expect(Number.isFinite(body.heading[0])).toBe(true)
    }
    expect(backwards).toBe(0)
    expect(minForward).toBeGreaterThan(0.1)
    expect(maxBend).toBeLessThan(0.8)
    expect(body.heading[0]).toBeLessThan(reversalHeading - 0.4)
  })

  it('couples low-speed turns to forward travel across fish sizes and tail cadences', () => {
    for (const scale of [0.44, 0.8]) for (const frequency of [1.3, 2.3, 3.6]) {
      const body = new FoidSpines(1)
      body.initialize(0, 0, scale, 0, 0, 0.03)
      let minimumForward = 1, distance = 0, slip = 0, courseTurn = 0
      for (let step = 0; step < 1680; step++) {
        const forward = body.velocityX[0] * Math.cos(body.heading[0]) + body.velocityZ[0] * Math.sin(body.heading[0])
        body.advance(0, scale, command((step + 1) / 120, {
          turn: Math.max(0, forward), frequency, phase: (step + 1) / 120 * frequency * TAU,
          effort: 0.7, power: step < 120 ? 1 : 0,
        }), 1 / 120)
        if (step < 240) continue
        const along = body.velocityX[0] * Math.cos(body.heading[0]) + body.velocityZ[0] * Math.sin(body.heading[0])
        const across = -body.velocityX[0] * Math.sin(body.heading[0]) + body.velocityZ[0] * Math.cos(body.heading[0])
        minimumForward = Math.min(minimumForward, along)
        if (step < 720) continue
        distance += Math.hypot(body.velocityX[0], body.velocityZ[0]) / 120
        courseTurn += body.courseRate[0] / 120
        slip += Math.abs(Math.atan2(across, along)) / 960
      }
      expect(minimumForward).toBeGreaterThan(0.02)
      expect(slip).toBeLessThan(0.3)
      // Requested route curvature is 1 rad/unit; actual course rotation is
      // measured from velocity rather than inferred from the body's animation.
      expect(courseTurn / distance).toBeGreaterThan(0.7)
      expect(courseTurn / distance).toBeLessThan(1.3)
    }
  })

  it('recruits the anterior springs for power while routine propulsion stays in the tail', () => {
    const sample = (power: number) => {
      const body = make()
      let frontWork = 0, tailWork = 0, storedEnergy = 0, peakHeadRate = 0
      for (let step = 0; step < 720; step++) {
        body.advance(0, SCALE, command((step + 1) / 120, { power }), 1 / 120)
        if (step < 120) continue
        for (let k = 2; k < SPINE_LINKS / 2; k++) frontWork += Math.max(0, body.jointPower[k]) / 120
        for (let k = SPINE_LINKS / 2; k < SPINE_LINKS; k++) tailWork += Math.max(0, body.jointPower[k]) / 120
        storedEnergy = Math.max(storedEnergy, body.elasticEnergy[0])
        peakHeadRate = Math.max(peakHeadRate, Math.abs(body.angularVelocity[0]))
      }
      return { frontWork, tailWork, storedEnergy, peakHeadRate, speed: Math.hypot(body.velocityX[0], body.velocityZ[0]) }
    }
    const cruising = sample(0), burst = sample(1)
    expect(cruising.tailWork).toBeGreaterThan(cruising.frontWork * 5)
    expect(burst.frontWork).toBeGreaterThan(cruising.frontWork * 3)
    expect(burst.storedEnergy).toBeGreaterThan(cruising.storedEnergy * 1.25)
    expect(burst.speed).toBeGreaterThan(cruising.speed * 1.2)
    expect(burst.peakHeadRate).toBeGreaterThan(3)
  })

  it('converges when the timestep is halved instead of changing the maneuver', () => {
    const coarse = make(), medium = make(), fine = make()
    run(coarse, 3, { turn: 0.5 }, 1 / 120)
    run(medium, 3, { turn: 0.5 }, 1 / 240)
    run(fine, 3, { turn: 0.5 }, 1 / 480)
    const error = (body: FoidSpines) => Math.hypot(body.centerX[0] - fine.centerX[0], body.centerZ[0] - fine.centerZ[0])
    expect(error(coarse)).toBeLessThan(0.015)
    expect(error(medium)).toBeLessThan(error(coarse) * 0.4)
    expect(Math.abs(coarse.heading[0] - fine.heading[0])).toBeLessThan(0.015)
  })

  it('preserves link lengths, the tissue mass center and the GPU pose through bending', () => {
    const body = make()
    run(body, 2, { turn: 0.8 })
    let cx = 0, cz = 0
    for (let k = 0; k < SPINE_LINKS; k++) {
      const x = body.offsetX[k + 1], z = body.offsetZ[k + 1]
      expect(Math.hypot(x - body.offsetX[k], z - body.offsetZ[k])).toBeCloseTo(FISH_LENGTH * SCALE / SPINE_LINKS, 6)
      cx += (body.offsetX[k] + x) * 0.5 * BODY_MASS[k]
      cz += (body.offsetZ[k] + z) * 0.5 * BODY_MASS[k]
      const p = body.packed[Math.floor(k / 2)], at = k % 2 * 2
      const fx = Math.cos(body.heading[0]), fz = Math.sin(body.heading[0])
      expect((p[at] * fx - p[at + 1] * fz) * SCALE).toBeCloseTo(x, 6)
      expect((p[at] * fz + p[at + 1] * fx) * SCALE).toBeCloseTo(z, 6)
    }
    expect(body.headX[0] + cx).toBeCloseTo(body.centerX[0], 6)
    expect(body.headZ[0] + cz).toBeCloseTo(body.centerZ[0], 6)
    expect(Math.abs(body.yaw[1] - body.yaw[0])).toBeLessThan(0.03)
  })

  it('handles net contact with fluid and joint forces while preserving the spine', () => {
    const body = make(undefined, 0.6)
    body.initialize(0, 0, SCALE, 0.95, 0, 0.6)
    const bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }
    let contact = 0
    for (let step = 0; step < 240; step++) {
      body.advance(0, SCALE, command((step + 1) / 120, { turn: 1 }), 1 / 120, bounds)
      contact = Math.max(contact, body.contactForce[0])
      expect(Number.isFinite(body.centerX[0])).toBe(true)
      for (let k = 0; k < SPINE_POINTS; k++) {
        expect(Math.abs(body.headX[0] + body.offsetX[k])).toBeLessThan(1.01)
        expect(Math.abs(body.headZ[0] + body.offsetZ[k])).toBeLessThan(1.01)
      }
    }
    expect(contact).toBeGreaterThan(0)
  })

  it('retains actual leader trajectories across the circular history buffer', () => {
    const body = make()
    for (let step = 1; step <= 240; step++) {
      body.beginStep(step / 60); body.record(0, step / 60, -step / 30)
    }
    expect(body.trailX(0, 0.375)).toBeCloseTo(3.625, 10)
    expect(body.trailZ(0, 0.375)).toBeCloseTo(-7.25, 10)
  })
})
