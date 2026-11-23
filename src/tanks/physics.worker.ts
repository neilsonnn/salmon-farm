import { FishSchool } from './simulation'
import { STATE_STRIDE, writeFishState, type PhysicsRequest, type PhysicsResponse } from './physicsProtocol'
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PhysicsRequest>) => void) | null
  postMessage(message: PhysicsResponse, transfer?: Transferable[]): void
}
let school: FishSchool | null = null, start = 0, end = 0, buffer: ArrayBuffer | null = null
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      school = new FishSchool(data.seed, data.mask); start = data.start; end = data.end
      buffer = new ArrayBuffer((end - start) * STATE_STRIDE * 4)
      scope.postMessage({ type: 'ready' })
    } else if (data.type === 'recycle') buffer = data.buffer
    else if (data.type === 'disturb') school?.disturb(data.x, data.z, data.kind)
    else if (school) {
      school.step(data.dt)
      const output = buffer ?? new ArrayBuffer((end - start) * STATE_STRIDE * 4)
      writeFishState(school, start, end, new Float32Array(output))
      buffer = null
      scope.postMessage({ type: 'state', buffer: output }, [output])
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Fish physics was interrupted.' })
  }
}
