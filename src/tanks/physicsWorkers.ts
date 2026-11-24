import bundleURL from './physics.worker.ts?worker&url'
import { createBlobPhysicsWorkers, PHYSICS_WORKER_NAMES, type PhysicsWorkers } from './workerBootstrap'

export async function loadPhysicsWorkers(signal: AbortSignal): Promise<PhysicsWorkers> {
  if (import.meta.env.PROD) return createBlobPhysicsWorkers(bundleURL, signal)
  // Vite's development server uses module imports/HMR. The production bundle
  // is self-contained and exercises the Blob path in the compatibility preview.
  signal.throwIfAborted()
  if (typeof Worker === 'undefined') throw new Error('This browser does not provide fish physics workers.')
  const workers: Worker[] = []
  try {
    for (const name of PHYSICS_WORKER_NAMES) {
      workers.push(new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module', name }))
    }
    return { workers, releaseBootstrap: () => {} }
  } catch (error) { workers.forEach(worker => worker.terminate()); throw error }
}
