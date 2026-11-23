import { angleDelta, FISH_LENGTH, FoidSpines, SPINE_LINKS, SPINE_POINTS, type SwimCommand } from './locomotion'

export interface Pen { x: number; z: number; halfWidth: number; halfLength: number; population: number }
export const TANK_LAYOUT = { halfWidth: 2.45, halfLength: 3.25, pitchX: 5.6, pitchZ: 7.2, dockWidth: 0.6 } as const
export const PENS: readonly Pen[] = [
  { x: 0, z: 0, ...TANK_LAYOUT, population: 144 },
  { x: -TANK_LAYOUT.pitchX, z: 0, ...TANK_LAYOUT, population: 48 },
  { x: TANK_LAYOUT.pitchX, z: 0, ...TANK_LAYOUT, population: 56 },
  { x: 0, z: -TANK_LAYOUT.pitchZ, ...TANK_LAYOUT, population: 32 },
  { x: -TANK_LAYOUT.pitchX, z: -TANK_LAYOUT.pitchZ, ...TANK_LAYOUT, population: 16 },
  { x: TANK_LAYOUT.pitchX, z: -TANK_LAYOUT.pitchZ, ...TANK_LAYOUT, population: 24 },
]
export const FISH_COUNT = PENS.reduce((sum, pen) => sum + pen.population, 0)
export const MAX_BODY_CURVATURE = 2.5
/** Limit on the navigation request, not a clamp on physical angular velocity. */
export const MAX_TURN_RATE = 2.4
export const MIN_SWIM_SPEED = 0.16
export const CRUISE_SPEED = { min: 0.26, max: 0.76 } as const
export const FISH_SIZE = { min: 0.44, max: 0.8 } as const
export interface Disturbance { x: number; z: number; age: number; strength: number; kind: 'ripple' | 'food' }

export function seededRandom(seed: number) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let result = Math.imul(value ^ (value >>> 15), 1 | value)
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}
const TAU = Math.PI * 2
const CELL = 0.9, COLS = 6, ROWS = 8, CELLS = COLS * ROWS
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Foids: selective, predictive fish following coupled to body and fin actuators.
 * Steering and speed are distinct controls. No global orbit center or radial lanes are assigned.
 * A fish attends to its frontal leader and the nearest salient neighbor on each side;
 * body-space looming, headway and wall anticipation can override that social decision.
 */
export class FishSchool {
  readonly count = FISH_COUNT
  readonly x = new Float32Array(this.count)
  readonly z = new Float32Array(this.count)
  readonly depth = new Float32Array(this.count)
  /** Mass-weighted orientation of the actual articulated body. */
  readonly heading = new Float32Array(this.count)
  readonly speed = new Float32Array(this.count)
  readonly turn = new Float32Array(this.count)
  /** Navigation request, passed to muscles; it never directly changes pose. */
  readonly curvature = new Float32Array(this.count)
  readonly length = new Float32Array(this.count)
  readonly phase = new Float32Array(this.count)
  readonly frequency = new Float32Array(this.count)
  readonly effort = new Float32Array(this.count)
  readonly motorGain = new Float32Array(this.count).fill(1)
  readonly individuality = new Float32Array(this.count)
  readonly cruiseSpeed = new Float32Array(this.count)
  readonly penIndex = new Uint8Array(this.count)
  readonly attention = new Int32Array(this.count * 3).fill(-1)
  readonly spines = new FoidSpines(this.count)
  readonly disturbances: Disturbance[] = []
  private readonly command: SwimCommand = { turn: 0, effort: 0, frequency: 1, phase: 0, gain: 1, brake: 0 }
  private readonly bounds = PENS.map(p => ({ minX: p.x - p.halfWidth, maxX: p.x + p.halfWidth, minZ: p.z - p.halfLength, maxZ: p.z + p.halfLength }))
  private readonly random: () => number
  private readonly baseDepth = new Float32Array(this.count)
  private readonly headCommand = new Float32Array(this.count)
  private readonly bendMemory = new Float32Array(this.count)
  private readonly flowCenterX = new Float32Array(this.count)
  private readonly flowCenterZ = new Float32Array(this.count)
  private readonly nextFlowX = new Float32Array(this.count)
  private readonly nextFlowZ = new Float32Array(this.count)
  private readonly speedRequest = new Float32Array(this.count)
  private readonly decisionClock = new Float32Array(this.count)
  private readonly burstClock = new Float32Array(this.count)
  private readonly burstPeriod = new Float32Array(this.count)
  private readonly burstFraction = new Float32Array(this.count)
  private readonly roamPhase = new Float32Array(this.count)
  private readonly roamRate = new Float32Array(this.count)
  private readonly roamAmplitude = new Float32Array(this.count)
  private readonly brake = new Float32Array(this.count)
  private readonly alarm = new Float32Array(this.count)
  private readonly feeding = new Float32Array(this.count)
  private readonly verticalRequest = new Float32Array(this.count)
  private readonly nextCurvature = new Float32Array(this.count)
  private readonly heads = new Int32Array(PENS.length * CELLS)
  private readonly next = new Int32Array(this.count)
  time = 0

  constructor(readonly seed = 81571, private readonly activePenMask = (1 << PENS.length) - 1) {
    const random = this.random = seededRandom(seed)
    let i = 0
    PENS.forEach((pen, p) => {
      for (let j = 0; j < pen.population; j++, i++) {
        // Initial circulation is a starting condition, not a per-frame steering field.
        const theta = j * 2.399963229728653 + (random() - 0.5) * 0.12
        // Mixed age cohorts, not a small jitter around one adult size.
        const age = random()
        this.length[i] = age < 0.24 ? FISH_SIZE.min + random() * 0.1
          : age < 0.82 ? 0.54 + random() ** 1.2 * 0.14
            : 0.69 + random() * (FISH_SIZE.max - 0.69)
        const inner = 0.08 + this.length[i] * 0.18
        const radialSample = (j * 0.414213562373095 + random() * 0.28) % 1
        const radius = inner + (0.94 - inner) * radialSample ** 0.95
        this.x[i] = pen.x + Math.cos(theta) * pen.halfWidth * radius
        this.z[i] = pen.z + Math.sin(theta) * pen.halfLength * radius
        this.heading[i] = Math.atan2(Math.cos(theta) * pen.halfLength, -Math.sin(theta) * pen.halfWidth) + (random() - 0.5) * 0.13
        this.baseDepth[i] = 0.2 + random() ** 1.1 * 1.08
        this.depth[i] = this.baseDepth[i]
        this.cruiseSpeed[i] = CRUISE_SPEED.min + random() ** 1.15 * (CRUISE_SPEED.max - CRUISE_SPEED.min)
        this.speed[i] = Math.max(MIN_SWIM_SPEED, this.cruiseSpeed[i] * (0.8 + random() * 0.2))
        this.speedRequest[i] = this.speed[i]
        this.phase[i] = random() * TAU
        this.frequency[i] = clamp(0.7 + 2.3 * this.cruiseSpeed[i] / (this.length[i] * FISH_LENGTH), 0.7, 4.2)
        this.effort[i] = 0.55 + random() * 0.35
        this.individuality[i] = random()
        // A persistent turning tendency, seeded from the initial mill and learned locally.
        // It stores curvature, never an orbit center, radius target or desired position.
        const a = pen.halfWidth * radius, b = pen.halfLength * radius
        this.bendMemory[i] = a * b / ((a * Math.sin(theta)) ** 2 + (b * Math.cos(theta)) ** 2) ** 1.5
        this.headCommand[i] = this.bendMemory[i]
        this.curvature[i] = Math.min(this.bendMemory[i], MAX_BODY_CURVATURE / (this.length[i] * FISH_LENGTH))
        // An osculating-center estimate is local turning memory. Neighbor consensus
        // will reconcile these initially different estimates; no global center is read.
        this.flowCenterX[i] = this.x[i] - Math.sin(this.heading[i]) / this.bendMemory[i]
        this.flowCenterZ[i] = this.z[i] + Math.cos(this.heading[i]) / this.bendMemory[i]
        this.penIndex[i] = p
        this.decisionClock[i] = random() * 0.26
        const bodyPace = this.cruiseSpeed[i] / (this.length[i] * FISH_LENGTH)
        this.burstPeriod[i] = (0.75 + random() * 1.8) / (0.5 + Math.sqrt(bodyPace))
        this.burstFraction[i] = clamp(0.25 + bodyPace * 0.32, 0.28, 0.8)
        this.burstClock[i] = random() * this.burstPeriod[i]
        this.roamPhase[i] = random() * TAU
        this.roamRate[i] = 0.07 + random() * 0.11
        this.roamAmplitude[i] = 0.18 + random() * 0.42
        this.spines.initialize(i, this.heading[i], this.length[i], this.x[i], this.z[i], this.speed[i])
        const oldX = this.x[i], oldZ = this.z[i]
        this.placeInsidePen(i)
        this.flowCenterX[i] += this.x[i] - oldX; this.flowCenterZ[i] += this.z[i] - oldZ
        this.spines.initialize(i, this.heading[i], this.length[i], this.x[i], this.z[i], this.speed[i])
        this.flowCenterX[i] += this.spines.centroidX[i]; this.flowCenterZ[i] += this.spines.centroidZ[i]
      }
    })
  }

  disturb(x: number, z: number, kind: Disturbance['kind'] = 'ripple') {
    if (!PENS.some(p => Math.abs(x - p.x) < p.halfWidth && Math.abs(z - p.z) < p.halfLength)) return false
    if (this.disturbances.length >= 8) this.disturbances.shift()
    this.disturbances.push({ x, z, age: 0, strength: kind === 'food' ? 1.2 : 0.9, kind })
    return true
  }

  private cellX(x: number, pen: Pen) { return clamp(Math.floor((x - pen.x + pen.halfWidth) / CELL), 0, COLS - 1) }
  private cellZ(z: number, pen: Pen) { return clamp(Math.floor((z - pen.z + pen.halfLength) / CELL), 0, ROWS - 1) }

  step(dt: number) {
    dt = clamp(dt, 0, 1 / 30)
    if (dt === 0) return
    const steps = Math.ceil(dt * 60)
    for (let step = 0; step < steps; step++) this.advance(dt / steps)
  }

  advanceClock(dt: number) {
    this.time += dt
    for (let d = this.disturbances.length - 1; d >= 0; d--) {
      this.disturbances[d].age += dt
      if (this.disturbances[d].age > (this.disturbances[d].kind === 'food' ? 16 : 5)) this.disturbances.splice(d, 1)
    }
  }

  private advance(dt: number) {
    this.advanceClock(dt)
    this.heads.fill(-1)
    for (let i = 0; i < this.count; i++) {
      const p = this.penIndex[i], pen = PENS[p]
      const cell = p * CELLS + this.cellZ(this.z[i] + this.spines.centroidZ[i], pen) * COLS
        + this.cellX(this.x[i] + this.spines.centroidX[i], pen)
      this.next[i] = this.heads[cell]; this.heads[cell] = i
    }
    // All sensing reads the same snapshot. Motion, depth and motor integration happen later.
    for (let i = 0; i < this.count; i++) this.sense(i, dt)
    this.spines.beginStep(this.time)
    // All sensory clocks consume the same seeded random sequence. Unrelated
    // pens can therefore be integrated in workers with identical trajectories.
    for (let i = 0; i < this.count; i++) if (this.activePenMask & (1 << this.penIndex[i])) this.swim(i, dt)
  }

  private sense(i: number, dt: number) {
    const p = this.penIndex[i], pen = PENS[p]
    const x = this.x[i] + this.spines.centroidX[i], z = this.z[i] + this.spines.centroidZ[i], heading = this.heading[i]
    const fx = Math.cos(heading), fz = Math.sin(heading)
    const course = this.speed[i] > 0.06 ? Math.atan2(this.spines.velocityZ[i], this.spines.velocityX[i]) : heading
    const bodyLength = this.length[i] * FISH_LENGTH
    const cx = this.cellX(x, pen), cz = this.cellZ(z, pen)
    let front = -1, left = -1, right = -1
    let frontScore = Infinity, leftScore = Infinity, rightScore = Infinity
    let strongestPressure = 0, avoid = 0, brake = 0, depthPressure = 0
    const paceVariation = 0.92 + Math.sin(this.time * (0.16 + this.individuality[i] * 0.07) + this.roamPhase[i]) * 0.25
      + Math.sin(this.time * 0.83 + this.roamPhase[i] * 2.3) * 0.09
    let speedCap = this.cruiseSpeed[i] * paceVariation
    // The short-range pressure field approximates near-field/lateral-line sensing;
    // social attention is forward-biased and topologically limited to three fish.
    for (let gz = Math.max(0, cz - 2); gz <= Math.min(ROWS - 1, cz + 2); gz++) {
      for (let gx = Math.max(0, cx - 2); gx <= Math.min(COLS - 1, cx + 2); gx++) {
        for (let j = this.heads[p * CELLS + gz * COLS + gx]; j !== -1; j = this.next[j]) {
          if (j === i) continue
          const dx = this.x[j] + this.spines.centroidX[j] - x, dz = this.z[j] + this.spines.centroidZ[j] - z
          const dy = this.depth[j] - this.depth[i]
          const distance2 = dx * dx + dz * dz
          if (distance2 > Math.max(1.25, bodyLength * 2.65) ** 2 || Math.abs(dy) > 0.52 || distance2 < 0.000001) continue
          const along = dx * fx + dz * fz, lateral = -dx * fz + dz * fx
          const otherLength = this.length[j] * FISH_LENGTH
          const verticalWeight = Math.exp(-dy * dy / 0.058)
          // Looming: assess the closest predicted body-space approach, not just distance now.
          const rvx = this.spines.velocityX[j] - this.spines.velocityX[i]
          const rvz = this.spines.velocityZ[j] - this.spines.velocityZ[i]
          const approachTime = clamp(-(dx * rvx + dz * rvz) / (rvx * rvx + rvz * rvz + 0.015), 0, 0.65)
          const predictedAlong = along + (rvx * fx + rvz * fz) * approachTime
          const predictedSide = lateral + (-rvx * fz + rvz * fx) * approachTime
          const longSpace = (bodyLength + otherLength) * 0.48
          const sideSpace = (bodyLength + otherLength) * 0.145
          const exclusion = (predictedAlong / longSpace) ** 2 + (predictedSide / sideSpace) ** 2 + (dy / 0.19) ** 2
          const pressure = Math.max(0, 1.35 - exclusion) * (1 - approachTime * 0.42)
          if (pressure > strongestPressure) {
            strongestPressure = pressure
            // Choose a side; a frontal obstruction primarily requests braking.
            const side = Math.abs(lateral) < 0.005 ? (i < j ? -1 : 1) : -Math.sign(lateral)
            avoid = side * pressure * (0.75 + Math.max(0, 0.4 - along) * 0.5)
          }
          if (along > 0 && along < bodyLength * 1.7 && Math.abs(lateral) < sideSpace * 0.95) {
            const gap = along - (bodyLength + otherLength) * 0.48
            const desiredGap = 0.035 + this.speed[i] * 0.12
            const closing = Math.max(0, this.speed[i] - this.speed[j])
            const obstruction = clamp((desiredGap - gap) / (bodyLength * 0.7), 0, 1) * verticalWeight
            brake = Math.max(brake, obstruction * (0.7 + closing))
            speedCap = Math.min(speedCap, this.speed[j] + Math.max(-0.15, gap - desiredGap) * verticalWeight * 0.7 + (1 - verticalWeight) * bodyLength)
          }
          if (exclusion < 1.1 && Math.abs(dy) > 0.018) depthPressure -= Math.sign(dy) * (1.1 - exclusion) * 0.09
          // Apparent size and frontal position determine salience, with no global averaging.
          const score = distance2 / (0.3 + verticalWeight) + Math.abs(lateral) * 0.45
          const compatibility = Math.cos(this.heading[j] - heading)
          const leaderScore = (score + (1 - compatibility) * bodyLength * 3 + Math.abs(lateral) * 0.8)
            * (this.attention[i * 3] === j ? 0.65 : 1)
          if (along > bodyLength * 0.5 && Math.abs(lateral) < bodyLength * 0.8 && compatibility > 0.35 && leaderScore < frontScore) {
            front = j; frontScore = leaderScore
          }
          if (along > -bodyLength * 0.45) {
            if (lateral > 0 && score < leftScore) { left = j; leftScore = score }
            if (lateral < 0 && score < rightScore) { right = j; rightScore = score }
          }
        }
      }
    }
    this.attention[i * 3] = front; this.attention[i * 3 + 1] = left; this.attention[i * 3 + 2] = right
    // Distributed flow observer: share the turning memory only with attended fish.
    // It communicates curvature geometry, not a prescribed orbit or radial lane.
    let centerX = this.flowCenterX[i] * 2, centerZ = this.flowCenterZ[i] * 2, centerWeight = 2
    for (let k = 0; k < 3; k++) {
      const j = this.attention[i * 3 + k]
      if (j < 0 || (k > 0 && j === front)) continue
      const weight = k === 0 ? 1.4 : 0.75
      centerX += this.flowCenterX[j] * weight; centerZ += this.flowCenterZ[j] * weight
      centerWeight += weight
    }
    this.nextFlowX[i] = this.flowCenterX[i] + (centerX / centerWeight - this.flowCenterX[i]) * dt * 2.4
    this.nextFlowZ[i] = this.flowCenterZ[i] + (centerZ / centerWeight - this.flowCenterZ[i]) * dt * 2.4
    this.decisionClock[i] -= dt
    if (this.decisionClock[i] <= 0) {
      this.decisionClock[i] = 0.17 + this.random() * 0.15
      // Use the learned local flow as a prediction; a neighbor's trail corrects it.
      const flowX = x - this.flowCenterX[i], flowZ = z - this.flowCenterZ[i]
      const flowRadius = Math.max(bodyLength * 1.1, Math.hypot(flowX, flowZ))
      // Slow, independent excursions carry fish across the radius instead of
      // locking everyone to the same annulus. The spine still executes every turn.
      let excursion = Math.sin(this.time * this.roamRate[i] + this.roamPhase[i]) * this.roamAmplitude[i]
      if (front >= 0 && this.cruiseSpeed[i] > this.speed[front] + 0.14
        && Math.hypot(this.x[front] + this.spines.centroidX[front] - x, this.z[front] + this.spines.centroidZ[front] - z) < bodyLength * 1.8) {
        excursion += (leftScore > rightScore ? 1 : -1) * 0.18
      }
      const flowHeading = Math.atan2(flowX, -flowZ) + excursion
      const flowCurvature = 0.65 / flowRadius + this.bendMemory[i] * 0.35
        + clamp(angleDelta(flowHeading, course), -1.1, 1.1) * 1.15 / bodyLength
      let curvature = flowCurvature
      if (front !== -1) {
        const lookAhead = bodyLength * 0.72
        const preferredHeadway = (bodyLength + this.length[front] * FISH_LENGTH) * 0.5 + 0.12
        const age = clamp((preferredHeadway - lookAhead) / Math.max(0.2, this.speed[front]), 0, 0.8)
        const trailX = this.spines.trailX(front, age), trailZ = this.spines.trailZ(front, age)
        const dx = trailX - x, dz = trailZ - z
        const bearing = Math.atan2(dz, dx)
        const turnToTrail = clamp(angleDelta(bearing, course), -0.85, 0.85)
        const pursuit = 2 * Math.sin(turnToTrail) / Math.max(bodyLength * 0.55, Math.hypot(dx, dz))
        const influence = clamp(this.speed[front] / Math.max(0.15, this.speed[i]), 0.82, 1.1)
        curvature = flowCurvature * 0.9 + pursuit * 0.1 * influence
        const observedBend = this.turn[front] / Math.max(MIN_SWIM_SPEED, this.speed[front])
        if (observedBend > 0.08 && observedBend < 1.4 / bodyLength) {
          this.bendMemory[i] += (observedBend - this.bendMemory[i]) * 0.025
        }
        // A slow neighbor weakens only social pursuit, never the fish's own turn.
      } else {
        // Regain contact with one salient lateral neighbor when the frontal path is empty.
        const companion = leftScore < rightScore ? left : right
        if (companion !== -1) {
          const dx = this.x[companion] + this.spines.centroidX[companion] - x
          const dz = this.z[companion] + this.spines.centroidZ[companion] - z
          const side = -dx * fz + dz * fx
          const distance = Math.hypot(dx, dz)
          curvature += Math.sign(side) * Math.max(0, distance / bodyLength - 1.15) * 0.22 / bodyLength
        }
      }
      curvature += (this.random() - 0.5) * 0.1 / bodyLength
      this.headCommand[i] = clamp(curvature, -2.8 / bodyLength, 2.8 / bodyLength)
    }
    // Three nose probes anticipate the enclosure; a turn begins before contact.
    const reach = bodyLength * 0.55 + this.speed[i] * 0.9
    let wallTurn = 0, wallPressure = 0
    for (const offset of [-0.32, 0, 0.32]) {
      const probeX = this.x[i] - pen.x + Math.cos(heading + offset) * reach
      const probeZ = this.z[i] - pen.z + Math.sin(heading + offset) * reach
      const inwardX = -Math.sign(probeX) * Math.max(0, Math.abs(probeX) - pen.halfWidth + 0.35)
      const inwardZ = -Math.sign(probeZ) * Math.max(0, Math.abs(probeZ) - pen.halfLength + 0.35)
      const pressure = Math.hypot(inwardX, inwardZ)
      wallTurn += (-inwardX * fz + inwardZ * fx) * 2.1
      wallPressure = Math.max(wallPressure, pressure)
    }
    if (wallPressure > 0.12 && Math.abs(wallTurn) < 0.15) wallTurn += Math.sign(this.bendMemory[i]) * wallPressure
    wallTurn = clamp(wallTurn, -1.4, 1.4)
    let disturbanceTurn = 0, alarm = 0, feeding = 0
    for (const event of this.disturbances) {
      const dx = event.x - x, dz = event.z - z, distance = Math.hypot(dx, dz) + 0.001
      if (distance > 3) continue
      const lateral = -dx * fz + dz * fx
      if (event.kind === 'food') {
        const attraction = Math.min(1, event.age * 0.8) * Math.min(1, (16 - event.age) / 5)
        disturbanceTurn += clamp(lateral / distance, -1, 1) * attraction * 1.45
        feeding = Math.max(feeding, Math.max(0, 1 - distance / 2.4) * attraction)
      } else {
        const pressure = Math.exp(-distance * 1.25 - event.age * 1.4) * event.strength * 3.2
        disturbanceTurn -= lateral / distance * pressure * 2.4
        alarm = Math.max(alarm, pressure)
      }
    }
    // Navigation requests a route, then muscle/fin execution supplies the yaw.
    let curvatureRequest = this.headCommand[i]
      + (wallTurn + avoid * 0.32 + disturbanceTurn) / Math.max(0.35, this.speed[i])
    curvatureRequest = clamp(curvatureRequest, -MAX_BODY_CURVATURE / bodyLength, MAX_BODY_CURVATURE / bodyLength)
    curvatureRequest = this.anticipateWall(i, curvatureRequest)
    // Wall/collision reflexes remain live between the asynchronous social decisions.
    this.verticalRequest[i] = clamp(depthPressure, -0.12, 0.12)
    this.brake[i] = clamp(brake + wallPressure * 0.2, 0, 1.2)
    const minimumPace = MIN_SWIM_SPEED * (1 - Math.min(0.8, this.brake[i] * 0.7))
    this.speedRequest[i] = clamp(speedCap * (1 + alarm * 0.3), minimumPace, bodyLength * (2.2 + alarm * 0.2))
    this.alarm[i] = alarm; this.feeding[i] = feeding
    // Reuse a dedicated next-state value rather than altering another fish's sensed pose.
    this.nextCurvature[i] = clamp(curvatureRequest, -MAX_BODY_CURVATURE / bodyLength, MAX_BODY_CURVATURE / bodyLength)
  }

  private swim(i: number, dt: number) {
    const bodyLength = this.length[i] * FISH_LENGTH
    const bendRate = clamp((this.nextCurvature[i] - this.curvature[i]) / 0.12, -10 / bodyLength, 10 / bodyLength)
    this.curvature[i] += bendRate * dt
    this.flowCenterX[i] = this.nextFlowX[i]; this.flowCenterZ[i] = this.nextFlowZ[i]
    this.burstClock[i] += dt
    if (this.burstClock[i] >= this.burstPeriod[i]) this.burstClock[i] -= this.burstPeriod[i]
    const cycle = this.burstClock[i] / this.burstPeriod[i]
    const duty = this.burstFraction[i]
    const kick = cycle < duty ? Math.sin(Math.PI * cycle / duty) ** 0.6 : 0
    const forwardVelocity = this.spines.velocityX[i] * Math.cos(this.heading[i]) + this.spines.velocityZ[i] * Math.sin(this.heading[i])
    const speedError = (this.speedRequest[i] - forwardVelocity) / bodyLength
    const requestedPace = this.speedRequest[i] / bodyLength
    const drive = clamp(0.34 + requestedPace * 0.78 + speedError * 1.4 + this.alarm[i] * 0.22, 0.14, 1.35)
    const restartEffort = forwardVelocity < MIN_SWIM_SPEED ? 0.4 + Math.max(0, speedError) * 0.8 : 0
    const targetEffort = Math.max((0.1 + kick * 0.96) * drive, restartEffort)
      * (1 - this.brake[i] * 0.5) * this.motorGain[i]
    this.effort[i] += (targetEffort - this.effort[i]) * (1 - Math.exp(-dt / 0.09))
    const targetFrequency = clamp((0.7 + requestedPace * 2.3 + Math.max(0, speedError) * 0.8 + this.alarm[i] * 0.3)
      * (0.68 / this.length[i]) ** 0.12, 0.7, 4.2)
    this.frequency[i] += (targetFrequency - this.frequency[i]) * (1 - Math.exp(-dt / 0.22))
    this.phase[i] = (this.phase[i] + dt * this.frequency[i] * TAU) % TAU
    const command = this.command
    const forwardSpeed = Math.max(0, forwardVelocity)
    command.turn = clamp(this.curvature[i] * forwardSpeed, -MAX_TURN_RATE, MAX_TURN_RATE)
    command.effort = this.effort[i]; command.frequency = this.frequency[i]
    command.phase = this.phase[i]; command.gain = this.motorGain[i]
    command.power = clamp(Math.max(0, speedError) * 0.9 + this.alarm[i] * 0.5, 0, 1)
    command.brake = clamp(this.brake[i] + Math.max(0, -speedError) + Math.max(0, -forwardVelocity / bodyLength) * 0.5, 0, 1.5)
    this.spines.advance(i, this.length[i], command, dt, this.bounds[this.penIndex[i]])
    this.x[i] = this.spines.headX[i]; this.z[i] = this.spines.headZ[i]
    this.heading[i] = this.spines.heading[i]
    this.turn[i] += (this.spines.courseRate[i] - this.turn[i]) * (1 - Math.exp(-dt / 0.24))
    this.speed[i] = Math.hypot(this.spines.velocityX[i], this.spines.velocityZ[i])
    const targetDepth = this.baseDepth[i] + Math.sin(this.time * (0.16 + this.individuality[i] * 0.2) + this.roamPhase[i]) * 0.08
      + this.verticalRequest[i] - this.feeding[i] * 0.42
    this.depth[i] += (clamp(targetDepth, 0.18, 1.5) - this.depth[i]) * dt * 0.9
    this.spines.record(i, this.x[i] + this.spines.centroidX[i], this.z[i] + this.spines.centroidZ[i])
  }

  private anticipateWall(i: number, requested: number) {
    const pen = PENS[this.penIndex[i]], length = this.length[i] * FISH_LENGTH
    const horizon = length * 0.85 + this.speed[i] * 0.9
    if (Math.min(pen.halfWidth - Math.abs(this.x[i] - pen.x), pen.halfLength - Math.abs(this.z[i] - pen.z)) > horizon + 0.4) return requested
    const clearance = this.length[i] * 0.22 + 0.065 + length / SPINE_LINKS
    const score = (target: number) => {
      let x = this.x[i] - pen.x, z = this.z[i] - pen.z, heading = this.heading[i], curvature = this.curvature[i], worst = 0
      const distance = horizon / 8
      const response = 1 - Math.exp(-distance / (0.28 * Math.max(0.12, this.speed[i])))
      for (let probe = 0; probe < 8; probe++) {
        curvature += (target - curvature) * response
        const change = curvature * distance
        x += Math.cos(heading + change * 0.5) * distance; z += Math.sin(heading + change * 0.5) * distance
        heading += change
        worst = Math.max(worst, Math.abs(x) - pen.halfWidth + clearance, Math.abs(z) - pen.halfLength + clearance)
      }
      return worst
    }
    const original = score(requested)
    if (original <= 0) return requested
    const left = MAX_BODY_CURVATURE / length, right = -left
    const leftRisk = score(left), rightRisk = score(right)
    if (Math.min(leftRisk, rightRisk) >= original) return requested
    const safest = leftRisk <= rightRisk ? left : right
    if (Math.min(leftRisk, rightRisk) > 0) return safest
    // Use the smallest safe correction, preserving outer routes and overtaking
    // room instead of committing to the tightest possible turn near every net.
    let unsafe = 0, safe = 1
    for (let probe = 0; probe < 5; probe++) {
      const mix = (unsafe + safe) * 0.5
      if (score(requested + (safest - requested) * mix) > 0) unsafe = mix
      else safe = mix
    }
    return requested + (safest - requested) * safe
  }

  private placeInsidePen(i: number) {
    const pen = PENS[this.penIndex[i]]
    // Initialization only. Live contact acts through forces in the body solver.
    let minX = 0, maxX = 0, minZ = 0, maxZ = 0
    const base = i * SPINE_POINTS
    for (let k = 1; k < SPINE_POINTS; k++) {
      minX = Math.min(minX, this.spines.offsetX[base + k]); maxX = Math.max(maxX, this.spines.offsetX[base + k])
      minZ = Math.min(minZ, this.spines.offsetZ[base + k]); maxZ = Math.max(maxZ, this.spines.offsetZ[base + k])
    }
    const clearance = this.length[i] * 0.22 + 0.045
    const headClearance = clearance + this.length[i] * FISH_LENGTH / SPINE_LINKS
    this.x[i] = clamp(this.x[i], pen.x - pen.halfWidth + Math.max(headClearance, clearance - minX), pen.x + pen.halfWidth - Math.max(headClearance, clearance + maxX))
    this.z[i] = clamp(this.z[i], pen.z - pen.halfLength + Math.max(headClearance, clearance - minZ), pen.z + pen.halfLength - Math.max(headClearance, clearance + maxZ))
  }
}

/** Order parameters used to check that local decisions retain a moving mill. */
export function measureSchool(school: FishSchool, penIndex = 0) {
  let count = 0, rotation = 0, polarizationX = 0, polarizationZ = 0, speed = 0, radius = 0
  const speeds: number[] = [], radii: number[] = [], sizes: number[] = []
  const pen = PENS[penIndex]
  for (let i = 0; i < school.count; i++) {
    if (school.penIndex[i] !== penIndex) continue
    const dx = school.x[i] + school.spines.centroidX[i] - pen.x
    const dz = school.z[i] + school.spines.centroidZ[i] - pen.z, r = Math.hypot(dx, dz) || 1
    const pace = Math.hypot(school.spines.velocityX[i], school.spines.velocityZ[i])
    const vx = pace > 0.001 ? school.spines.velocityX[i] / pace : 0
    const vz = pace > 0.001 ? school.spines.velocityZ[i] / pace : 0
    rotation += (dx * vz - dz * vx) / r
    polarizationX += vx; polarizationZ += vz
    speed += school.speed[i]
    const normalizedRadius = Math.hypot(dx / pen.halfWidth, dz / pen.halfLength)
    radius += normalizedRadius
    speeds.push(school.speed[i]); radii.push(normalizedRadius); sizes.push(school.length[i])
    count++
  }
  speeds.sort((a, b) => a - b); radii.sort((a, b) => a - b); sizes.sort((a, b) => a - b)
  const quantile = (values: number[], fraction: number) => values[Math.floor((values.length - 1) * fraction)]
  return { rotation: Math.abs(rotation / count), polarization: Math.hypot(polarizationX, polarizationZ) / count,
    meanSpeed: speed / count, meanRadius: radius / count,
    speedP10: quantile(speeds, 0.1), speedP90: quantile(speeds, 0.9),
    radiusP10: quantile(radii, 0.1), radiusP90: quantile(radii, 0.9),
    sizeP10: quantile(sizes, 0.1), sizeP90: quantile(sizes, 0.9) }
}
