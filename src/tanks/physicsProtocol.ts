import { SPINE_LINKS } from './locomotion'
import type { Disturbance, FishSchool } from './simulation'
export const STATE_STRIDE = 10 + SPINE_LINKS * 2
export type PhysicsRequest =
  | { type: 'init'; seed: number; mask: number; start: number; end: number }
  | { type: 'step'; dt: number }
  | { type: 'disturb'; x: number; z: number; kind: Disturbance['kind'] }
  | { type: 'recycle'; buffer: ArrayBuffer }
export type PhysicsResponse = { type: 'ready' } | { type: 'state'; buffer: ArrayBuffer } | { type: 'error'; message: string }

export function writeFishState(school: FishSchool, start: number, end: number, state: Float32Array) {
  for (let i = start; i < end; i++) {
    let at = (i - start) * STATE_STRIDE
    state[at++] = school.x[i]; state[at++] = school.z[i]; state[at++] = school.depth[i]
    state[at++] = school.heading[i]; state[at++] = school.speed[i]; state[at++] = school.phase[i]
    for (let k = 0; k < 4; k++) state[at++] = school.spines.fins[i * 4 + k]
    for (const packed of school.spines.packed) for (let k = 0; k < 4; k++) state[at++] = packed[i * 4 + k]
  }
}
export function readFishState(school: FishSchool, start: number, end: number, state: Float32Array) {
  for (let i = start; i < end; i++) {
    let at = (i - start) * STATE_STRIDE
    school.x[i] = state[at++]; school.z[i] = state[at++]; school.depth[i] = state[at++]
    school.heading[i] = state[at++]; school.speed[i] = state[at++]; school.phase[i] = state[at++]
    for (let k = 0; k < 4; k++) school.spines.fins[i * 4 + k] = state[at++]
    for (const packed of school.spines.packed) for (let k = 0; k < 4; k++) packed[i * 4 + k] = state[at++]
  }
}
