import { FishSchool, PENS, type Disturbance } from './simulation'
import { readFishState, type PhysicsRequest, type PhysicsResponse } from './physicsProtocol'
import { loadPhysicsWorkers } from './physicsWorkers'
import type { PhysicsWorkerFactory, PhysicsWorkers } from './workerBootstrap'
interface Shard { worker: Worker; start: number; end: number; ready: boolean; busy: boolean; queued: number }

/** Independent pens share a clock and seed; two workers keep mechanics off the render thread. */
export class FishPhysicsRunner {
  private shards: Shard[] = []
  private suspended = false
  private disposed = false
  private readonly startupAbort = new AbortController()
  private pool: PhysicsWorkers | null = null
  private releaseBootstrap: (() => void) | null = null
  private startPromise: Promise<void> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private resolveStartup: (() => void) | null = null
  private rejectStartup: ((error: Error) => void) | null = null
  constructor(private readonly school: FishSchool, private readonly onError: (message: string) => void,
    private readonly workerFactory: PhysicsWorkerFactory = loadPhysicsWorkers) {}

  start(): Promise<void> {
    return this.startPromise ??= this.startWorkers()
  }

  private async startWorkers() {
    try {
      const pool = await this.workerFactory(this.startupAbort.signal)
      if (this.disposed) {
        pool.workers.forEach(worker => worker.terminate()); pool.releaseBootstrap()
        throw new Error('Fish physics startup was cancelled.')
      }
      this.pool = pool
      this.releaseBootstrap = pool.releaseBootstrap
      if (pool.workers.length !== 2) throw new Error('Both fish physics workers are required.')
      const ready = new Promise<void>((resolve, reject) => {
        this.resolveStartup = resolve; this.rejectStartup = reject
        this.startupTimer = setTimeout(() => this.fail('The fish physics workers did not become ready.'), 15000)
      })
      const main = PENS[0].population
      const school = this.school
      const ranges = [{ start: 0, end: main, mask: 1 }, { start: main, end: school.count, mask: ((1 << PENS.length) - 1) ^ 1 }]
      this.shards = ranges.map((range, i) => ({ worker: pool.workers[i], start: range.start, end: range.end, ready: false, busy: false, queued: 0 }))
      try {
        for (const [i, range] of ranges.entries()) this.initializeShard(this.shards[i], range.mask)
      } catch (error) { this.fail(error instanceof Error ? error.message : 'Fish physics initialization failed.') }
      await ready
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  private initializeShard(shard: Shard, mask: number) {
    const worker = shard.worker
    worker.onmessage = ({ data }: MessageEvent<PhysicsResponse>) => {
      if (this.disposed) return
      if (data.type === 'error') { this.fail(data.message); return }
      if (data.type === 'ready') {
        shard.ready = true
        if (this.shards.every(shard => shard.ready)) this.finishStartup()
      } else {
        readFishState(this.school, shard.start, shard.end, new Float32Array(data.buffer))
        this.send(shard, { type: 'recycle', buffer: data.buffer }, [data.buffer])
        shard.busy = false
      }
      this.dispatch(shard)
    }
    worker.onerror = event => this.fail(event.message || 'The fish simulation worker was interrupted.')
    worker.onmessageerror = () => this.fail('A fish physics message could not be decoded.')
    this.send(shard, { type: 'init', seed: this.school.seed, mask, start: shard.start, end: shard.end })
  }

  private finishStartup() {
    clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    const resolve = this.resolveStartup
    this.resolveStartup = null; this.rejectStartup = null
    this.releaseWorkerURL()
    resolve?.()
  }
  private releaseWorkerURL() {
    const release = this.releaseBootstrap
    this.releaseBootstrap = null
    release?.()
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
    if (this.shards.length !== 2 || !this.shards.every(shard => shard.ready)) return
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
    const reject = this.rejectStartup
    this.rejectStartup = null; this.resolveStartup = null
    this.dispose()
    if (reject) reject(new Error(message))
    else this.onError(message)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.startupAbort.abort()
    clearTimeout(this.startupTimer); this.startupTimer = undefined
    this.pool?.workers.forEach(worker => worker.terminate()); this.releaseWorkerURL(); this.pool = null
    this.shards = []
    const reject = this.rejectStartup
    this.rejectStartup = null; this.resolveStartup = null
    reject?.(new Error('Fish physics startup was cancelled.'))
  }
}
