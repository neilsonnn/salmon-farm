export interface PhysicsWorkers { workers: Worker[]; releaseBootstrap: () => void }
export type PhysicsWorkerFactory = (signal: AbortSignal) => Promise<PhysicsWorkers>
export const PHYSICS_WORKER_NAMES = ['salmon-farm-main', 'salmon-farm-outer'] as const

/** Opaque-origin players can fetch a bundle but may start only blob: workers. */
export async function createBlobPhysicsWorkers(bundleURL: string, signal: AbortSignal): Promise<PhysicsWorkers> {
  signal.throwIfAborted()
  if (typeof Worker === 'undefined') throw new Error('This browser does not provide fish physics workers.')
  const response = await fetch(bundleURL, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`The fish physics bundle could not load (HTTP ${response.status}).`)
  const source = await response.text()
  signal.throwIfAborted()
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  let released = false
  const releaseBootstrap = () => { if (!released) { released = true; URL.revokeObjectURL(url) } }
  const workers: Worker[] = []
  try {
    for (const name of PHYSICS_WORKER_NAMES) workers.push(new Worker(url, { name }))
    return { workers, releaseBootstrap }
  } catch (error) {
    workers.forEach(worker => worker.terminate())
    releaseBootstrap()
    throw error
  }
}
