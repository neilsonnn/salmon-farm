import { FishSchool, PENS, type Disturbance } from './simulation'
import { readFishState, type PhysicsRequest, type PhysicsResponse } from './physicsProtocol'
interface Shard { worker: Worker; start: number; end: number; ready: boolean; busy: boolean; queued: number }

/** Independent pens share a clock and seed; two workers keep mechanics off the render thread. */
export class FishPhysicsRunner {
  private shards: Shard[] = []
  private suspended = false
  private disposed = false
  constructor(private readonly school: FishSchool, private readonly onError: (message: string) => void) {
    if (typeof Worker === 'undefined') return
    try {
      const main = PENS[0].population
      for (const range of [{ start: 0, end: main, mask: 1 }, { start: main, end: school.count, mask: ((1 << PENS.length) - 1) ^ 1 }]) {
        const worker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' })
        const shard: Shard = { worker, start: range.start, end: range.end, ready: false, busy: false, queued: 0 }
        this.shards.push(shard)
        worker.onmessage = ({ data }: MessageEvent<PhysicsResponse>) => {
          if (this.disposed) return
          if (data.type === 'error') { this.fail(data.message); return }
          if (data.type === 'ready') shard.ready = true
          else {
            readFishState(school, shard.start, shard.end, new Float32Array(data.buffer))
            this.send(shard, { type: 'recycle', buffer: data.buffer }, [data.buffer])
            shard.busy = false
          }
          this.dispatch(shard)
        }
        worker.onerror = event => this.fail(event.message || 'The fish simulation worker was interrupted.')
        this.send(shard, { type: 'init', seed: school.seed, mask: range.mask, start: range.start, end: range.end })
      }
    } catch {
      // Worker construction can be unavailable under an embedding policy. At this
      // point the school is still at its initial state, so synchronous fallback is exact.
      this.shards.forEach(shard => shard.worker.terminate()); this.shards = []
    }
  }
  private send(shard: Shard, data: PhysicsRequest, transfer: Transferable[] = []) { shard.worker.postMessage(data, transfer) }
  private dispatch(shard: Shard) {
    if (this.suspended || !shard.ready || shard.busy || shard.queued < 1e-8) return
    const frames = Math.min(2, shard.queued)
    shard.queued -= frames; shard.busy = true
    this.send(shard, { type: 'step', dt: frames / 60 })
  }
  step(dt: number) {
    if (this.disposed || this.suspended) return
    if (this.shards.length === 0) { this.school.step(dt); return }
    const frames = Math.max(0, Math.min(2, Math.round(dt * 60)))
    if (frames === 0) return
    this.school.advanceClock(frames / 60)
    for (const shard of this.shards) {
      // Bound catch-up after stalls; never queue an unbounded stream of old frames.
      shard.queued = Math.min(4, shard.queued + frames)
      this.dispatch(shard)
    }
  }
  disturb(x: number, z: number, kind: Disturbance['kind'] = 'ripple') {
    if (!this.school.disturb(x, z, kind)) return false
    this.shards.forEach(shard => this.send(shard, { type: 'disturb', x, z, kind }))
    return true
  }
  suspend(value: boolean) {
    this.suspended = value
    if (value) this.shards.forEach(shard => { shard.queued = 0 })
  }
  private fail(message: string) {
    if (this.disposed) return
    this.dispose(); this.onError(message)
  }
  dispose() {
    this.disposed = true
    this.shards.forEach(shard => shard.worker.terminate()); this.shards = []
  }
}
