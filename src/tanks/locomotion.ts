/** Mesh and mechanics use the same snout, caudal fork and fixed-length links. */
export const FISH_HEAD = 0.49
export const FISH_TAIL = -0.72
export const FISH_LENGTH = FISH_HEAD - FISH_TAIL
export const SPINE_LINKS = 12
export const SPINE_POINTS = SPINE_LINKS + 1
export const PHYSICS_STEP = 1 / 120
const N = SPINE_LINKS, D = N + 2, HISTORY = 96, TAU = Math.PI * 2, SEG = 1 / N
const STATE_YAW = 11, STATE_OMEGA = STATE_YAW + N, STATE_VELOCITY = STATE_OMEGA + N
const STATE_FIN = STATE_VELOCITY + D, STATE_ACCEL = STATE_FIN + 4
const STATE_ACTIVATION = STATE_ACCEL + D, STATE_RECRUITMENT = STATE_ACTIVATION + N
const STATE_SIZE = STATE_RECRUITMENT + 1
const FIN_ROOT_LINK = Math.floor((FISH_HEAD - 0.20) / FISH_LENGTH * N)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
export function fishSection(x: number) {
  const t = clamp((x + 0.45) / 0.94, 0, 1)
  const profile = Math.sin(Math.PI * t) ** 0.82 * (0.75 + 0.42 * t)
  return { width: 0.078 * profile + 0.008, height: 0.092 * profile + 0.009 }
}
// Dynamics use body lengths and unit tissue mass: force mL/s², torque mL²/s².
// Geometry scales with actual length. A thin caudal membrane has little tissue
// but appreciable projected area and cross-flow added water mass.
export const BODY_MASS = new Float64Array(N)
const WIDTH = new Float64Array(N), HEIGHT = new Float64Array(N), CENTER = new Float64Array(N)
const ADDED_N = new Float64Array(N), ADDED_T = new Float64Array(N)
const DRAG_N = new Float64Array(N), DRAG_T = new Float64Array(N), INERTIA = new Float64Array(N)
let volume = 0
for (let k = 0; k < N; k++) {
  const x = FISH_HEAD - FISH_LENGTH * (k + 0.5) / N, section = fishSection(x)
  WIDTH[k] = (x > -0.45 ? section.width : 0.003) / FISH_LENGTH
  HEIGHT[k] = (x > -0.45 ? section.height : 0.045 + (-x - 0.45) * 0.40) / FISH_LENGTH
  BODY_MASS[k] = Math.PI * WIDTH[k] * HEIGHT[k] * SEG
  volume += BODY_MASS[k]
}
for (let k = 0; k < N; k++) BODY_MASS[k] /= volume
for (let k = 0; k < N; k++) {
  ADDED_N[k] = Math.PI * HEIGHT[k] ** 2 * SEG / volume
  ADDED_T[k] = BODY_MASS[k] * 0.025
  DRAG_N[k] = 0.5 * 1.1 * 2 * HEIGHT[k] * SEG / volume
  DRAG_T[k] = 0.5 * 0.008 * 2 * Math.PI * Math.sqrt((WIDTH[k] ** 2 + HEIGHT[k] ** 2) / 2) * SEG / volume
  INERTIA[k] = BODY_MASS[k] * (SEG ** 2 + 3 * WIDTH[k] ** 2) / 12
  CENTER[k] = BODY_MASS[k] * 0.5
  for (let j = k + 1; j < N; j++) CENTER[k] += BODY_MASS[j]
}
DRAG_T[0] += 0.5 * 0.10 * Math.PI * Math.max(...WIDTH) * Math.max(...HEIGHT) / volume
const MASS_CENTER_DISTANCE = CENTER.reduce((sum, coefficient) => sum + coefficient * SEG, 0)
const CONTACT_REACH = Math.max(MASS_CENTER_DISTANCE, 1 - MASS_CENTER_DISTANCE) + Math.max(...WIDTH)
export interface SwimCommand { turn: number; effort: number; frequency: number; phase: number; gain: number; brake: number; finActivity?: number; bodyActivity?: number; power?: number }
export interface SwimBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface FluidModel { addedMass: number; resistance: number; circulation?: number }

/**
 * Free articulated swimmer: COM translation + twelve absolute rigid-link angles.
 * Equal/opposite muscle torques, tissue inertia, local anisotropic added mass,
 * distributed fluid resistance and compliant contact share one Lagrangian solve.
 * No assigned forward speed, yaw motor, head gesture, pose projection or thrust
 * proxy. Inextensibility is exact in these generalized coordinates. See docs/foids.md.
 */
export class FoidSpines {
  readonly yaw: Float64Array
  readonly angularVelocity: Float64Array
  readonly offsetX: Float32Array
  readonly offsetZ: Float32Array
  readonly centroidX: Float32Array
  readonly centroidZ: Float32Array
  readonly centerX: Float64Array
  readonly centerZ: Float64Array
  readonly headX: Float64Array
  readonly headZ: Float64Array
  readonly velocityX: Float64Array
  readonly velocityZ: Float64Array
  readonly heading: Float64Array
  readonly turnRate: Float64Array
  readonly courseRate: Float64Array
  /** Actual sweep left/right, then feather left/right; also the GPU's fin pose. */
  readonly fins: Float32Array
  readonly musclePower: Float64Array
  readonly jointPower: Float64Array
  readonly elasticEnergy: Float64Array
  readonly fluidPower: Float64Array
  readonly contactForce: Float64Array
  readonly solverResidual: Float64Array
  readonly integrationSubsteps: Uint16Array
  readonly packed: readonly Float32Array[]
  private readonly velocities: Float64Array
  private readonly acceleration: Float64Array
  private readonly steering: Float64Array
  private readonly integral: Float64Array
  private readonly meanTurn: Float64Array
  private readonly finPhase: Float64Array
  private readonly steeringActivation: Float64Array
  readonly recruitment: Float64Array
  private readonly xHistory: Float64Array
  private readonly zHistory: Float64Array
  private readonly times = new Float64Array(HISTORY)
  private cursor = HISTORY - 1
  private time = 0
  // Reused work buffers: no allocations per fish or mechanical substep.
  private readonly matrix = new Float64Array(D * D)
  private readonly lift = new Float64Array(D * D)
  private readonly rhs = new Float64Array(D)
  private readonly velocity = new Float64Array(D)
  private readonly old = new Float64Array(D)
  private readonly guess = new Float64Array(D)
  private readonly finPrevious = new Float64Array(4)
  private readonly neuralPrior = new Float64Array(N)
  private readonly rollback = new Float64Array(STATE_SIZE * 6)
  private acceptedResidual = 0
  private buildingJacobian = true
  private readonly jx = new Float64Array(D)
  private readonly jz = new Float64Array(D)
  private readonly tx = new Float64Array(N)
  private readonly tz = new Float64Array(N)
  private readonly motor = new Float64Array(N)
  private readonly stiffness = new Float64Array(N)
  private bx = 0; private bz = 0; private px = 0; private pz = 0; private active = 0

  constructor(readonly count: number, readonly fluid: FluidModel = { addedMass: 1, resistance: 1 }) {
    this.yaw = new Float64Array(count * N); this.angularVelocity = new Float64Array(count * N)
    this.offsetX = new Float32Array(count * SPINE_POINTS); this.offsetZ = new Float32Array(count * SPINE_POINTS)
    this.centroidX = new Float32Array(count); this.centroidZ = new Float32Array(count)
    this.centerX = new Float64Array(count); this.centerZ = new Float64Array(count)
    this.headX = new Float64Array(count); this.headZ = new Float64Array(count)
    this.velocityX = new Float64Array(count); this.velocityZ = new Float64Array(count)
    this.heading = new Float64Array(count); this.turnRate = new Float64Array(count); this.courseRate = new Float64Array(count)
    this.fins = new Float32Array(count * 4)
    this.musclePower = new Float64Array(count); this.jointPower = new Float64Array(count * N); this.elasticEnergy = new Float64Array(count); this.fluidPower = new Float64Array(count)
    this.contactForce = new Float64Array(count); this.solverResidual = new Float64Array(count); this.integrationSubsteps = new Uint16Array(count); this.velocities = new Float64Array(count * D); this.acceleration = new Float64Array(count * D)
    this.steering = new Float64Array(count); this.integral = new Float64Array(count); this.meanTurn = new Float64Array(count); this.finPhase = new Float64Array(count); this.steeringActivation = new Float64Array(count * N); this.recruitment = new Float64Array(count)
    this.packed = Array.from({ length: Math.ceil(N / 2) }, () => new Float32Array(count * 4))
    this.xHistory = new Float64Array(count * HISTORY); this.zHistory = new Float64Array(count * HISTORY)
    for (let h = 0; h < HISTORY; h++) this.times[h] = (h - HISTORY + 1) / 60
  }

  initialize(i: number, heading: number, scale: number, x: number, z: number, speed = 0) {
    const length = scale * FISH_LENGTH
    this.yaw.fill(heading, i * N, (i + 1) * N); this.angularVelocity.fill(0, i * N, (i + 1) * N)
    this.velocities.fill(0, i * D, (i + 1) * D); this.acceleration.fill(0, i * D, (i + 1) * D)
    this.velocities[i * D] = Math.cos(heading) * speed / length
    this.velocities[i * D + 1] = Math.sin(heading) * speed / length
    this.velocityX[i] = Math.cos(heading) * speed; this.velocityZ[i] = Math.sin(heading) * speed
    this.heading[i] = heading; this.turnRate[i] = 0; this.courseRate[i] = 0
    this.steering[i] = 0; this.steeringActivation.fill(0, i * N, (i + 1) * N); this.recruitment[i] = 0; this.integral[i] = 0; this.meanTurn[i] = 0; this.finPhase[i] = 0; this.fins.fill(0, i * 4, i * 4 + 4)
    let distance = 0
    for (let k = 0; k < N; k++) distance += CENTER[k] * SEG * length
    this.centerX[i] = x - Math.cos(heading) * distance; this.centerZ[i] = z - Math.sin(heading) * distance
    this.updatePose(i, scale)
    this.xHistory.fill(this.centerX[i], i * HISTORY, (i + 1) * HISTORY)
    this.zHistory.fill(this.centerZ[i], i * HISTORY, (i + 1) * HISTORY)
  }
  beginStep(time: number) { this.time = time; this.cursor = (this.cursor + 1) % HISTORY; this.times[this.cursor] = time }
  record(i: number, x: number, z: number) { this.xHistory[i * HISTORY + this.cursor] = x; this.zHistory[i * HISTORY + this.cursor] = z }
  private sample(buffer: Float64Array, i: number, secondsAgo: number) {
    const target = this.time - secondsAgo
    let newer = this.cursor
    for (let h = 1; h < HISTORY; h++) {
      const older = (this.cursor - h + HISTORY) % HISTORY
      if (this.times[older] <= target) {
        const duration = this.times[newer] - this.times[older]
        const mix = duration > 0 ? clamp((target - this.times[older]) / duration, 0, 1) : 0
        return buffer[i * HISTORY + older] * (1 - mix) + buffer[i * HISTORY + newer] * mix
      }
      newer = older
    }
    return buffer[i * HISTORY + newer]
  }
  trailX(i: number, secondsAgo: number) { return this.sample(this.xHistory, i, secondsAgo) }
  trailZ(i: number, secondsAgo: number) { return this.sample(this.zHistory, i, secondsAgo) }

  /** Position, Jacobian and centrifugal acceleration of a point along link k. */
  private point(k: number, along: number, acceleration = false) {
    this.jx[0] = 1; this.jx[1] = 0; this.jz[0] = 0; this.jz[1] = 1
    this.bx = 0; this.bz = 0; this.px = 0; this.pz = 0
    for (let j = 0; j < N; j++) {
      const a = SEG * (CENTER[j] - (j < k ? 1 : j === k ? along : 0))
      this.jx[j + 2] = -a * this.tz[j]; this.jz[j + 2] = a * this.tx[j]
      this.px += a * this.tx[j]; this.pz += a * this.tz[j]
      if (acceleration) {
        const centripetal = a * this.velocity[j + 2] ** 2
        this.bx -= centripetal * this.tx[j]; this.bz -= centripetal * this.tz[j]
      }
    }
  }
  private resistance(tx: number, tz: number, tangent: number, normal: number, vx: number, vz: number, dt: number) {
    const { jx, jz, matrix, rhs } = this
    const vt = vx * tx + vz * tz, vn = -vx * tz + vz * tx
    const ft = -tangent * (Math.abs(vt) + 0.012) * vt, fn = -normal * (Math.abs(vn) + 0.012) * vn
    const fx = ft * tx - fn * tz, fz = ft * tz + fn * tx
    for (let a = 0; a < D; a++) rhs[a] += dt * (jx[a] * fx + jz[a] * fz)
    this.fluidPower[this.active] += ft * vt + fn * vn
    if (!this.buildingJacobian) return
    const ct = tangent * (2 * Math.abs(vt) + 0.012), cn = normal * (2 * Math.abs(vn) + 0.012)
    const dxx = ct * tx * tx + cn * tz * tz, dxz = (ct - cn) * tx * tz, dzz = ct * tz * tz + cn * tx * tx
    for (let a = 0; a < D; a++) {
      const dx = jx[a] * dxx + jz[a] * dxz, dz = jx[a] * dxz + jz[a] * dzz
      for (let b = 0; b <= a; b++) matrix[a * D + b] += dt * 0.5 * (dx * jx[b] + dz * jz[b])
    }
  }
  private wall(gap: number, nx: number, nz: number, dt: number) {
    // A C1 compliant contact law regularizes the finite thickness of the net.
    // Newton linearization is evaluated at the SAME midpoint as body and water.
    const thickness = 0.008
    if (gap >= thickness) return
    let speed = 0
    for (let a = 0; a < D; a++) {
      const jacobian = this.jx[a] * nx + this.jz[a] * nz
      speed += jacobian * this.velocity[a]
    }
    const weight = Math.min(1, (thickness - gap) / (2 * thickness))
    const penetration = gap < -thickness ? -gap : (thickness - gap) ** 2 / (4 * thickness)
    const spring = 1600, damping = speed < 0 ? 32 * weight : 0
    const force = spring * penetration - damping * speed
    const derivative = dt * spring * weight * 0.25 + damping * 0.5
    for (let a = 0; a < D; a++) {
      const ja = this.jx[a] * nx + this.jz[a] * nz
      this.rhs[a] += dt * force * ja
      if (this.buildingJacobian) for (let b = 0; b <= a; b++) this.matrix[a * D + b] += dt * derivative * ja * (this.jx[b] * nx + this.jz[b] * nz)
    }
    this.contactForce[this.active] += force
  }
  private solve() {
    const { matrix: a, rhs: b, lift } = this
    // Modified Newton: reuse the factorization while evaluating the FULL
    // nonlinear force residual each iteration. Rebuild when convergence is slow.
    if (this.buildingJacobian) {
      for (let i = 0; i < D; i++) for (let j = i + 1; j < D; j++) a[i * D + j] = a[j * D + i]
      for (let i = 0; i < D * D; i++) a[i] -= lift[i]
      for (let i = 0; i < D; i++) {
        const pivot = a[i * D + i]
        for (let j = i + 1; j < D; j++) {
          const multiplier = a[j * D + i] / pivot
          a[j * D + i] = multiplier
          for (let k = i + 1; k < D; k++) a[j * D + k] -= multiplier * a[i * D + k]
        }
      }
    }
    for (let i = 0; i < D; i++) for (let j = 0; j < i; j++) b[i] -= a[i * D + j] * b[j]
    for (let i = D - 1; i >= 0; i--) {
      let sum = b[i]
      for (let j = i + 1; j < D; j++) sum -= a[i * D + j] * b[j]
      b[i] = sum / a[i * D + i]
    }
  }
  advance(i: number, scale: number, command: SwimCommand, dt: number, bounds?: SwimBounds) {
    const steps = Math.ceil(dt / PHYSICS_STEP), h = dt / steps
    this.acceptedResidual = 0; this.integrationSubsteps[i] = 0
    for (let step = 0; step < steps; step++) this.adaptiveStep(i, scale, command,
      command.phase - (steps - step - 1) * h * command.frequency * TAU, h, bounds, 0)
    this.solverResidual[i] = this.acceptedResidual
    this.updatePose(i, scale)
  }
  private adaptiveStep(i: number, scale: number, command: SwimCommand, phase: number,
    dt: number, bounds: SwimBounds | undefined, level: number) {
    // Numerical error control: reject an unresolved nonlinear solve and integrate
    // two shorter physical steps. No positions/velocities are repaired or clipped.
    const at = level * STATE_SIZE, saved = this.rollback
    saved[at] = this.centerX[i]; saved[at + 1] = this.centerZ[i]
    saved[at + 2] = this.velocityX[i]; saved[at + 3] = this.velocityZ[i]
    saved[at + 4] = this.heading[i]; saved[at + 5] = this.turnRate[i]; saved[at + 6] = this.courseRate[i]
    saved[at + 7] = this.steering[i]; saved[at + 8] = this.integral[i]
    saved[at + 9] = this.meanTurn[i]; saved[at + 10] = this.finPhase[i]
    for (let k = 0; k < N; k++) { saved[at + STATE_YAW + k] = this.yaw[i * N + k]; saved[at + STATE_OMEGA + k] = this.angularVelocity[i * N + k] }
    for (let k = 0; k < D; k++) saved[at + STATE_VELOCITY + k] = this.velocities[i * D + k]
    for (let k = 0; k < 4; k++) saved[at + STATE_FIN + k] = this.fins[i * 4 + k]
    for (let k = 0; k < D; k++) saved[at + STATE_ACCEL + k] = this.acceleration[i * D + k]
    for (let k = 0; k < N; k++) saved[at + STATE_ACTIVATION + k] = this.steeringActivation[i * N + k]
    saved[at + STATE_RECRUITMENT] = this.recruitment[i]
    this.integrate(i, scale, command, phase, dt, bounds)
    const residual = this.solverResidual[i]
    if (Number.isFinite(residual) && residual <= 0.001 && Number.isFinite(this.heading[i] + this.centerX[i] + this.centerZ[i])) {
      this.acceptedResidual = Math.max(this.acceptedResidual, residual)
      this.integrationSubsteps[i]++
      return
    }
    this.centerX[i] = saved[at]; this.centerZ[i] = saved[at + 1]
    this.velocityX[i] = saved[at + 2]; this.velocityZ[i] = saved[at + 3]
    this.heading[i] = saved[at + 4]; this.turnRate[i] = saved[at + 5]; this.courseRate[i] = saved[at + 6]
    this.steering[i] = saved[at + 7]; this.integral[i] = saved[at + 8]
    this.meanTurn[i] = saved[at + 9]; this.finPhase[i] = saved[at + 10]
    for (let k = 0; k < N; k++) { this.yaw[i * N + k] = saved[at + STATE_YAW + k]; this.angularVelocity[i * N + k] = saved[at + STATE_OMEGA + k] }
    for (let k = 0; k < D; k++) this.velocities[i * D + k] = saved[at + STATE_VELOCITY + k]
    for (let k = 0; k < 4; k++) this.fins[i * 4 + k] = saved[at + STATE_FIN + k]
    for (let k = 0; k < D; k++) this.acceleration[i * D + k] = saved[at + STATE_ACCEL + k]
    for (let k = 0; k < N; k++) this.steeringActivation[i * N + k] = saved[at + STATE_ACTIVATION + k]
    this.recruitment[i] = saved[at + STATE_RECRUITMENT]
    if (level === 5) throw new Error('Fish mechanical solve failed to converge')
    this.adaptiveStep(i, scale, command, phase - dt * 0.5 * command.frequency * TAU, dt * 0.5, bounds, level + 1)
    this.adaptiveStep(i, scale, command, phase, dt * 0.5, bounds, level + 1)
  }
  private integrate(i: number, scale: number, command: SwimCommand, phase: number, dt: number, bounds?: SwimBounds) {
    const { matrix, rhs, velocity, jx, jz, tx, tz } = this
    const base = i * N, offset = i * D, length = scale * FISH_LENGTH
    this.active = i
    for (let a = 0; a < D; a++) {
      this.old[a] = this.velocities[offset + a]
      this.guess[a] = this.old[a] + this.acceleration[offset + a] * dt
    }
    for (let a = 0; a < 4; a++) this.finPrevious[a] = this.fins[i * 4 + a]
    let lastResidual = Infinity
    for (let iteration = 0; iteration < 7; iteration++) {
      this.buildingJacobian = iteration === 0 || (iteration === 3 && lastResidual > 0.001)
      if (this.buildingJacobian) { matrix.fill(0); this.lift.fill(0) }
      rhs.fill(0); this.motor.fill(0)
      this.fluidPower[i] = 0; this.musclePower[i] = 0; this.contactForce[i] = 0
      for (let a = 0; a < D; a++) velocity[a] = (this.old[a] + this.guess[a]) * 0.5
      for (let k = 0; k < N; k++) {
        const midpoint = this.yaw[base + k] + velocity[k + 2] * dt * 0.5
        tx[k] = Math.cos(midpoint); tz[k] = Math.sin(midpoint)
      }
      for (let k = 0; k < N; k++) {
        this.point(k, 0.5, true)
        let vx = 0, vz = 0
        for (let a = 0; a < D; a++) { vx += jx[a] * velocity[a]; vz += jz[a] * velocity[a] }
        const tangent = BODY_MASS[k] + ADDED_T[k] * this.fluid.addedMass
        const normal = BODY_MASS[k] + ADDED_N[k] * this.fluid.addedMass
        const bxx = tangent * tx[k] ** 2 + normal * tz[k] ** 2
        const bxz = (tangent - normal) * tx[k] * tz[k], bzz = tangent * tz[k] ** 2 + normal * tx[k] ** 2
        const vt = vx * tx[k] + vz * tz[k], vn = -vx * tz[k] + vz * tx[k], rotation = (tangent - normal) * velocity[k + 2]
        const biasX = bxx * this.bx + bxz * this.bz + rotation * (-tz[k] * vt + tx[k] * vn)
        const biasZ = bxz * this.bx + bzz * this.bz + rotation * (tx[k] * vt + tz[k] * vn)
        let dvx = 0, dvz = 0
        for (let a = 0; a < D; a++) {
          dvx += jx[a] * (this.guess[a] - this.old[a]); dvz += jz[a] * (this.guess[a] - this.old[a])
        }
        const inertialX = bxx * dvx + bxz * dvz + dt * biasX
        const inertialZ = bxz * dvx + bzz * dvz + dt * biasZ
        for (let a = 0; a < D; a++) {
          rhs[a] -= jx[a] * inertialX + jz[a] * inertialZ
          if (this.buildingJacobian) {
            const mx = jx[a] * bxx + jz[a] * bxz, mz = jx[a] * bxz + jz[a] * bzz
            for (let b = 0; b <= a; b++) matrix[a * D + b] += mx * jx[b] + mz * jz[b]
          }
        }
        const inertia = INERTIA[k] + this.fluid.addedMass * ADDED_N[k] * SEG ** 2 / 12
        rhs[k + 2] += dt * (tangent - normal) * vt * vn - inertia * (this.guess[k + 2] - this.old[k + 2])
        if (this.buildingJacobian) matrix[(k + 2) * D + k + 2] += inertia
      }
      // One neural traveling wave changes antagonistic muscle rest curvature.
      // Actual bend is solved from elastic torque, damping, inertia and water.
      if (iteration === 0) {
        const forwardX = Math.cos(this.heading[i]), forwardZ = Math.sin(this.heading[i])
        const along = this.velocityX[i] * forwardX + this.velocityZ[i] * forwardZ
        const across = -this.velocityX[i] * forwardZ + this.velocityZ[i] * forwardX
        // Flow direction is ill-conditioned near rest. Reduce course feedback
        // and release its integral until a stroke establishes forward travel.
        const confidence = clamp((Math.max(0, along) / length - 0.12) / 0.13, 0, 1)
        const observerGain = confidence * (1 - Math.exp(-dt * clamp(command.frequency, 0.5, 4.2) / 0.65))
        this.meanTurn[i] += (this.courseRate[i] - this.meanTurn[i]) * observerGain
        if (confidence < 0.05) this.meanTurn[i] *= Math.exp(-dt / 0.2)
        const flowAlignment = along > length * 0.1 ? Math.atan2(across, along) : 0
        const error = command.turn - this.meanTurn[i]
        this.integral[i] = clamp(this.integral[i] + error * dt * confidence, -0.65, 0.65) * Math.exp(-dt * (command.gain === 0 ? 8 : confidence < 0.2 ? 2 : 0.04))
        const cadenceScale = clamp(command.frequency, 0.5, 4.2) / 2.3
        const forwardPace = Math.max(0.18, along / length)
        const routeBend = command.turn / forwardPace
        const demand = clamp(routeBend * 1.05 + error * 0.85 / cadenceScale + this.integral[i] + flowAlignment * 0.7, -1, 1) * command.gain
        const oldSteering = this.steering[i]
        this.steering[i] += (demand - this.steering[i]) * (1 - Math.exp(-dt / 0.065))
        const requestedPower = clamp(Math.max(command.power ?? 0, Math.abs(demand - oldSteering) * 1.4,
          Math.abs(error) * 0.55 / cadenceScale), 0, 1) * command.gain
        this.recruitment[i] += (requestedPower - this.recruitment[i]) * (1 - Math.exp(-dt / (requestedPower > this.recruitment[i] ? 0.045 : 0.20)))
        // One spinal activation field: a change in steering is transmitted from
        // anterior to posterior muscles, rather than imposing a head animation.
        const upstream = (oldSteering + this.steering[i]) * 0.5
        const ratio = dt / 0.012, decay = Math.exp(-ratio)
        for (let k = 0; k < N; k++) this.neuralPrior[k] = this.steeringActivation[base + k]
        // Exact exponential of the serial first-order conduction system. This
        // avoids timestep-dependent propagation caused by updating cells in-place.
        for (let k = 0; k < N; k++) {
          let sum = 0, weight = 1
          for (let j = 0; j <= k; j++) {
            sum += weight * (this.neuralPrior[k - j] - upstream)
            weight *= ratio / (j + 1)
          }
          this.steeringActivation[base + k] = upstream + decay * sum
        }
      }
      const steer = this.steering[i], effort = clamp(command.effort, 0, 1.4) * command.gain, cadence = clamp(command.frequency, 0.5, 4.2)
      let previousWave = 0, previousBias = 0
      for (let k = 1; k < N; k++) {
        const s = k / (N - 1)
        const peduncle = Math.min(1, s / 0.82)
        const exponent = 3.6 - this.recruitment[i] * 2.4
        const wave = 0.62 * peduncle ** exponent * Math.sin(phase - dt * cadence * Math.PI - TAU * peduncle * 0.85)
          * effort * (command.bodyActivity ?? 1)
        const bendExponent = 3.0 - this.recruitment[i] * 1.5
        const bias = -this.steeringActivation[base + k] * 1.05 * peduncle ** bendExponent * (command.bodyActivity ?? 1)
        const target = k === 1 ? 0 : wave - previousWave + bias - previousBias
        previousWave = wave; previousBias = bias
        const a = k + 1, b = k + 2
        const relativeRate = velocity[b] - velocity[a]
        const angle = angleDelta(this.yaw[base + k], this.yaw[base + k - 1]) + dt * 0.5 * relativeRate
        const finSupport = Math.max(0, (s - 0.78) / 0.22)
        const coactivation = 0.7 ** 2 + Math.max(0, cadence ** 2 - 0.7 ** 2) * clamp(command.gain, 0, 1)
        const muscleCadence = Math.sqrt(coactivation)
        const stiffness = k === 1 ? 2.8 * N / 8
          : 2.78352 * N / 8 * (1 - s * 0.75 + finSupport * 0.45) * coactivation / (2.3 ** 2)
        const damping = k === 1 ? 0.09 : 0.014 * N / 8 * (1 - s * 0.7 + finSupport * 0.25) * muscleCadence / 2.3
        const excess = Math.max(0, Math.abs(angle) - (k === 1 ? 0.025 : 0.50 * 8 / N)), limit = excess > 0 ? 6 : 0
        const torque = stiffness * (target - angle) - damping * relativeRate - Math.sign(angle) * excess * limit
        rhs[a] -= dt * torque; rhs[b] += dt * torque
        const implicit = dt * damping * 0.5 + dt * dt * (stiffness + limit) * 0.25
        if (this.buildingJacobian) { matrix[a * D + a] += implicit; matrix[b * D + b] += implicit; matrix[b * D + a] -= implicit }
        this.motor[k] = stiffness * target; this.stiffness[k] = stiffness
      }
      for (let k = 0; k < N; k++) for (let p = 0; p < 2; p++) {
        this.point(k, p === 0 ? 0.2113248654 : 0.7886751346)
        let vx = 0, vz = 0
        for (let a = 0; a < D; a++) { vx += jx[a] * velocity[a]; vz += jz[a] * velocity[a] }
        this.resistance(tx[k], tz[k], DRAG_T[k] * 0.5 * this.fluid.resistance, DRAG_N[k] * 0.5 * this.fluid.resistance, vx, vz, dt)
        if (k >= Math.floor(N * 0.75)) {
          // Finite-span quasi-steady Kutta lift on the sharp caudal membrane.
          // F = gamma * (vz, -vx), hence F dot v = 0, for every velocity.
          const vt = vx * tx[k] + vz * tz[k], vn = -vx * tz[k] + vz * tx[k]
          const aspect = 2 * HEIGHT[k] / SEG
          const coefficient = Math.PI * (2 * HEIGHT[k] * SEG * 0.5) / volume * aspect / (aspect + 2)
          const gamma = coefficient * vt * vn / Math.sqrt(vx * vx + vz * vz + 0.0001)
            * (this.fluid.circulation ?? (this.fluid.resistance > 0 ? 1 : 0))
          for (let a = 0; a < D; a++) {
            rhs[a] += dt * gamma * (jx[a] * vz - jz[a] * vx)
            if (this.buildingJacobian) for (let b = 0; b < D; b++) this.lift[a * D + b] += dt * 0.5 * gamma * (jx[a] * jz[b] - jz[a] * jx[b])
          }
        }
      }
      if (iteration === 0) this.finPhase[i] += dt * TAU * Math.min(2.2, 0.45 + cadence * 0.3 + Math.abs(steer) * 0.6)
      const finAssist = Math.min(1, 0.15 + Math.abs(command.turn) / cadence)
      this.rowFins(i, this.finPhase[i], effort * (command.finActivity ?? 1), steer * finAssist * (command.finActivity ?? 1), command.brake * command.gain * (command.finActivity ?? 1), dt)
      const reach = length * CONTACT_REACH + 0.018
      const nearNet = bounds && Math.min(this.centerX[i] - bounds.minX, bounds.maxX - this.centerX[i],
        this.centerZ[i] - bounds.minZ, bounds.maxZ - this.centerZ[i]) < reach + Math.hypot(velocity[0], velocity[1]) * length * dt
      if (bounds && nearNet) for (let k = 0; k < N; k++) for (let p = 0; p < 2; p++) {
        this.point(k, p)
        const x = this.centerX[i] + (this.px + velocity[0] * dt * 0.5) * length, z = this.centerZ[i] + (this.pz + velocity[1] * dt * 0.5) * length, radius = WIDTH[k] + 0.018 / length
        this.wall((x - bounds.minX) / length - radius, 1, 0, dt); this.wall((bounds.maxX - x) / length - radius, -1, 0, dt)
        this.wall((z - bounds.minZ) / length - radius, 0, 1, dt); this.wall((bounds.maxZ - z) / length - radius, 0, -1, dt)
      }
      this.solve()
      let residual = 0
      for (let a = 0; a < D; a++) {
        const next = this.guess[a] + rhs[a]
        residual = Math.max(residual, Math.abs(rhs[a]) / (1 + Math.abs(next)))
        this.guess[a] = next
      }
      this.solverResidual[i] = residual; lastResidual = residual
      if (iteration > 0 && residual < 0.00005) break
    }
    rhs.set(this.guess)
    for (let a = 0; a < D; a++) {
      this.acceleration[offset + a] = (rhs[a] - this.old[a]) / dt
      this.velocities[offset + a] = rhs[a]
    }
    this.centerX[i] += (this.old[0] + rhs[0]) * 0.5 * length * dt
    this.centerZ[i] += (this.old[1] + rhs[1]) * 0.5 * length * dt
    let hx = 0, hz = 0, rate = 0
    this.elasticEnergy[i] = 0
    for (let k = 0; k < N; k++) {
      this.yaw[base + k] += (this.old[k + 2] + rhs[k + 2]) * 0.5 * dt; this.angularVelocity[base + k] = rhs[k + 2]
      if (k > 0) {
        const jointPower = this.motor[k] * (this.old[k + 2] + rhs[k + 2] - this.old[k + 1] - rhs[k + 1]) * 0.5
        this.jointPower[base + k] = jointPower; this.musclePower[i] += jointPower
        const bend = angleDelta(this.yaw[base + k], this.yaw[base + k - 1])
        const excess = Math.max(0, Math.abs(bend) - (k === 1 ? 0.025 : 0.50 * 8 / N))
        this.elasticEnergy[i] += 0.5 * this.stiffness[k] * bend * bend + 3 * excess * excess
      }
      hx += BODY_MASS[k] * Math.cos(this.yaw[base + k]); hz += BODY_MASS[k] * Math.sin(this.yaw[base + k]); rate += BODY_MASS[k] * rhs[k + 2]
    }
    this.heading[i] += angleDelta(Math.atan2(hz, hx), this.heading[i]); this.turnRate[i] = rate
    const oldPace = Math.hypot(this.old[0], this.old[1]), newPace = Math.hypot(rhs[0], rhs[1])
    this.courseRate[i] = Math.min(oldPace, newPace) > 0.025
      ? Math.atan2(this.old[0] * rhs[1] - this.old[1] * rhs[0], this.old[0] * rhs[0] + this.old[1] * rhs[1]) / dt : 0
    this.velocityX[i] = rhs[0] * length; this.velocityZ[i] = rhs[1] * length
  }
  private rowFins(i: number, phase: number, effort: number, steer: number, brake: number, dt: number) {
    // Massless rowing plates. Power strokes present area; recovery feathers.
    // Actual moving-surface velocity supplies force at the root, including yaw.
    const k = FIN_ROOT_LINK, angle = this.yaw[i * N + k] + this.velocity[k + 2] * dt * 0.5, c = Math.cos(angle), s = Math.sin(angle)
    for (let index = 0; index < 2; index++) {
      const side = index === 0 ? -1 : 1
      const amplitude = clamp(effort * 0.025 - side * steer * 0.12 + brake * 0.12, 0, 0.30)
      const sweepTarget = side * amplitude * Math.sin(phase)
      const feather = Math.tanh(Math.cos(phase) * 3)
      const deployment = Math.min(1, amplitude / 0.2)
      const pitchTarget = (0.08 + 0.4 * (0.5 + feather * 0.5) + brake * 0.12) * deployment
      const oldSweep = this.finPrevious[index], oldPitch = this.finPrevious[2 + index]
      const response = 1 - Math.exp(-dt / 0.025)
      const newSweep = oldSweep + (sweepTarget - oldSweep) * response
      const newPitch = oldPitch + (pitchTarget - oldPitch) * response
      const sweepRate = (newSweep - oldSweep) / dt, pitchRate = (newPitch - oldPitch) / dt
      const sweep = (oldSweep + newSweep) * 0.5, pitch = (oldPitch + newPitch) * 0.5
      this.fins[i * 4 + index] = newSweep; this.fins[i * 4 + 2 + index] = newPitch
      this.point(k, (FISH_HEAD - 0.20) / FISH_LENGTH * N - k)
      const armForward = -0.16333333333333333 / FISH_LENGTH, armDown = -0.013 / FISH_LENGTH
      const armSide = side * 0.04666666666666667 / FISH_LENGTH
      const featheredForward = armForward * Math.cos(pitch) - armDown * Math.sin(pitch)
      const featherRate = (-armForward * Math.sin(pitch) - armDown * Math.cos(pitch)) * pitchRate
      const ax = featheredForward * Math.cos(sweep) - armSide * Math.sin(sweep)
      const az = featheredForward * Math.sin(sweep) + armSide * Math.cos(sweep)
      const rx = featherRate * Math.cos(sweep) - az * sweepRate
      const rz = featherRate * Math.sin(sweep) + ax * sweepRate
      const rootSide = side * 0.06 / FISH_LENGTH
      const wx = c * ax - s * (az + rootSide), wz = s * ax + c * (az + rootSide)
      this.jx[k + 2] -= wz; this.jz[k + 2] += wx
      let vx = c * rx - s * rz, vz = s * rx + c * rz
      for (let a = 0; a < D; a++) { vx += this.jx[a] * this.velocity[a]; vz += this.jz[a] * this.velocity[a] }
      const finAngle = angle + sweep, coefficient = 0.5 * 1.2 * (0.01575 / FISH_LENGTH ** 2) / volume * this.fluid.resistance
      this.resistance(-Math.sin(finAngle), Math.cos(finAngle), coefficient * 0.025,
        coefficient * (0.04 + Math.sin(pitch) ** 2), vx, vz, dt)
    }
  }
  updatePose(i: number, scale: number) {
    const base = i * N, point = i * SPINE_POINTS, length = scale * FISH_LENGTH
    let cx = 0, cz = 0
    for (let k = 0; k < N; k++) { cx -= Math.cos(this.yaw[base + k]) * CENTER[k] * length * SEG; cz -= Math.sin(this.yaw[base + k]) * CENTER[k] * length * SEG }
    this.centroidX[i] = cx; this.centroidZ[i] = cz
    this.headX[i] = this.centerX[i] - cx; this.headZ[i] = this.centerZ[i] - cz
    const fx = Math.cos(this.heading[i]), fz = Math.sin(this.heading[i])
    let x = 0, z = 0
    this.offsetX[point] = 0; this.offsetZ[point] = 0
    for (let k = 0; k < N; k++) {
      x -= Math.cos(this.yaw[base + k]) * length * SEG; z -= Math.sin(this.yaw[base + k]) * length * SEG
      this.offsetX[point + k + 1] = x; this.offsetZ[point + k + 1] = z
      const packed = this.packed[Math.floor(k / 2)], index = i * 4 + k % 2 * 2
      packed[index] = (x * fx + z * fz) / scale; packed[index + 1] = (-x * fz + z * fx) / scale
    }
  }
  /** Tissue momentum and kinetic energy, for force-free mechanics regressions. */
  mechanics(i: number, scale: number) {
    const length = scale * FISH_LENGTH, base = i * N
    for (let a = 0; a < D; a++) this.velocity[a] = this.velocities[i * D + a]
    for (let k = 0; k < N; k++) { this.tx[k] = Math.cos(this.yaw[base + k]); this.tz[k] = Math.sin(this.yaw[base + k]) }
    let px = 0, pz = 0, angular = 0, kinetic = 0, bend = 0
    for (let k = 0; k < N; k++) {
      this.point(k, 0.5)
      let vx = 0, vz = 0
      for (let a = 0; a < D; a++) { vx += this.jx[a] * this.velocity[a]; vz += this.jz[a] * this.velocity[a] }
      const m = BODY_MASS[k], omega = this.velocity[k + 2]
      px += m * vx; pz += m * vz; angular += m * (this.px * vz - this.pz * vx) + INERTIA[k] * omega
      kinetic += 0.5 * (m * (vx * vx + vz * vz) + INERTIA[k] * omega * omega)
      if (k > 0) bend += angleDelta(this.yaw[base + k], this.yaw[base + k - 1]) ** 2
    }
    return { momentumX: px * length, momentumZ: pz * length, angularMomentum: angular * length * length, kineticEnergy: kinetic * length * length, squaredBend: bend }
  }
}
