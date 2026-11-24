import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlobPhysicsWorkers } from '../../src/tanks/workerBootstrap'
import { FishPhysicsRunner } from '../../src/tanks/physicsRunner'
import { FishSchool } from '../../src/tanks/simulation'
import type { PhysicsRequest, PhysicsResponse } from '../../src/tanks/physicsProtocol'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: { data: PhysicsResponse }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn<(message: PhysicsRequest, transfer?: Transferable[]) => void>()
  terminate = vi.fn()
  constructor(readonly url: string, readonly options?: WorkerOptions) { TestWorker.instances.push(this) }
  ready() { this.onmessage?.({ data: { type: 'ready' } }) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); TestWorker.instances = [] })

function mockPool() {
  const workers = [new TestWorker('blob:main'), new TestWorker('blob:outer')]
  const releaseBootstrap = vi.fn()
  const factory = vi.fn(async (_signal: AbortSignal) => ({ workers: workers as unknown as Worker[], releaseBootstrap }))
  const school = new FishSchool(52)
  const step = vi.spyOn(school, 'step')
  const onError = vi.fn()
  const runner = new FishPhysicsRunner(school, onError, factory)
  return { workers, releaseBootstrap, factory, school, step, onError, runner }
}

describe('Blob worker bootstrap', () => {
  it('fetches once, starts two named Blob workers, and retains the URL until released', async () => {
    vi.stubGlobal('Worker', TestWorker)
    const fetch = vi.fn(async () => new Response('self.onmessage = () => {};'))
    vi.stubGlobal('fetch', fetch)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:physics')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const abort = new AbortController()
    const pool = await createBlobPhysicsWorkers('https://assets.example/project/worker.js', abort.signal)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://assets.example/project/worker.js', { signal: abort.signal, credentials: 'omit' })
    expect(await (create.mock.calls[0][0] as Blob).text()).toBe('self.onmessage = () => {};')
    expect((create.mock.calls[0][0] as Blob).type).toBe('text/javascript')
    expect(TestWorker.instances.map(worker => worker.url)).toEqual(['blob:physics', 'blob:physics'])
    expect(TestWorker.instances.map(worker => worker.options?.name)).toEqual(['salmon-farm-main', 'salmon-farm-outer'])
    expect(revoke).not.toHaveBeenCalled()
    pool.releaseBootstrap(); pool.releaseBootstrap()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:physics')
  })

  it('cleans up the first worker and URL when the second constructor is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('self.onmessage = () => {};')))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:physics')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class BlockedWorker extends TestWorker {
      constructor(url: string, options?: WorkerOptions) {
        if (TestWorker.instances.length) throw new DOMException('Blocked by worker-src', 'SecurityError')
        super(url, options)
      }
    }
    vi.stubGlobal('Worker', BlockedWorker)
    await expect(createBlobPhysicsWorkers('/worker.js', new AbortController().signal)).rejects.toThrow('Blocked by worker-src')
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:physics')
  })

  it('reports failed fetches before creating any worker', async () => {
    vi.stubGlobal('Worker', TestWorker)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(createBlobPhysicsWorkers('/missing.js', new AbortController().signal)).rejects.toThrow('HTTP 404')
    expect(TestWorker.instances).toHaveLength(0)
  })

  it('cancels a pending download without allocating a Blob URL', async () => {
    vi.stubGlobal('Worker', TestWorker)
    const abort = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { abort.abort(); return new Response('self.onmessage = () => {};') }))
    const create = vi.spyOn(URL, 'createObjectURL')
    await expect(createBlobPhysicsWorkers('/worker.js', abort.signal)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('Physics worker lifecycle', () => {
  it('waits for both shards before advancing and never computes physics on the main thread', async () => {
    const r = mockPool(), start = r.runner.start()
    await Promise.resolve()
    expect(r.workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', mask: 1 }), [])
    r.runner.step(1 / 60)
    expect(r.school.time).toBe(0)
    r.workers[0].ready(); r.runner.step(1 / 60)
    expect(r.school.time).toBe(0)
    expect(r.releaseBootstrap).not.toHaveBeenCalled()
    r.workers[1].ready(); await start
    r.runner.step(1 / 60)
    expect(r.school.time).toBeCloseTo(1 / 60)
    expect(r.workers.every(worker => worker.postMessage.mock.calls.some(([message]) => message.type === 'step'))).toBe(true)
    expect(r.step).not.toHaveBeenCalled()
    expect(r.releaseBootstrap).toHaveBeenCalledOnce()
    r.runner.dispose()
    expect(r.releaseBootstrap).toHaveBeenCalledOnce()
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
  })

  it('rejects worker creation failures instead of falling back to synchronous simulation', async () => {
    const r = mockPool()
    const failure = new FishPhysicsRunner(r.school, r.onError, async () => { throw new Error('worker-src blocked') })
    await expect(failure.start()).rejects.toThrow('worker-src blocked')
    failure.step(1 / 60)
    expect(r.step).not.toHaveBeenCalled()
  })

  it('cleans up when a worker rejects initialization', async () => {
    const r = mockPool(), start = r.runner.start()
    const rejection = expect(start).rejects.toThrow('Initialization failed')
    await Promise.resolve()
    r.workers[0].onmessage?.({ data: { type: 'error', message: 'Initialization failed' } })
    await rejection
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
    expect(r.releaseBootstrap).toHaveBeenCalledOnce()
    expect(r.onError).not.toHaveBeenCalled()
  })

  it('handles synchronous initialization-message failures without an unhandled promise', async () => {
    const r = mockPool()
    r.workers[0].postMessage.mockImplementation(() => { throw new Error('Message could not be cloned') })
    await expect(r.runner.start()).rejects.toThrow('Message could not be cloned')
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
    expect(r.releaseBootstrap).toHaveBeenCalledOnce()
    expect(r.step).not.toHaveBeenCalled()
  })

  it('cancels an unfinished startup and terminates workers', async () => {
    const r = mockPool(), start = r.runner.start()
    const rejection = expect(start).rejects.toThrow('cancelled')
    await Promise.resolve()
    r.runner.dispose(); await rejection
    expect(r.factory.mock.calls[0][0].aborted).toBe(true)
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
  })

  it('times out a stalled worker without leaving a pending loading screen', async () => {
    vi.useFakeTimers()
    const r = mockPool(), start = r.runner.start()
    const rejection = expect(start).rejects.toThrow('did not become ready')
    await Promise.resolve()
    r.workers[0].ready()
    await vi.advanceTimersByTimeAsync(15000)
    await rejection
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
  })

  it('reports a worker error after successful startup and stops the pool', async () => {
    const r = mockPool(), start = r.runner.start()
    await Promise.resolve(); r.workers.forEach(worker => worker.ready()); await start
    r.workers[0].onerror?.({ message: 'Worker interrupted' })
    expect(r.onError).toHaveBeenCalledExactlyOnceWith('Worker interrupted')
    r.runner.step(1 / 60)
    expect(r.step).not.toHaveBeenCalled()
    expect(r.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
  })
})
