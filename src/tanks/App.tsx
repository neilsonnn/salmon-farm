import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { TanksScene } from './scene'
import { MURKINESS } from './optics'
import { sceneErrorMessage, toTanksSceneError, type TanksSceneError } from './errors'
import { hideOpening, resetOpening, revealOpening } from './opening'
import './style.css'

// Vite removes this import and all debug controls from the production build.
const DevControls = import.meta.env.DEV ? lazy(() => import('./DevControls')) : null
const captureOpening = import.meta.env.DEV && new URLSearchParams(location.search).has('opening')

export default function Tanks() {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<TanksScene | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<TanksSceneError | null>(null)
  const [generation, setGeneration] = useState(0)
  const [paused, setPaused] = useState(() => captureOpening || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [murk, setMurk] = useState<number>(MURKINESS.default)
  const [fallbackEnvironment, setFallbackEnvironment] = useState(false)
  const pausedRef = useRef(paused)
  const murkRef = useRef(murk)
  pausedRef.current = paused
  murkRef.current = murk

  useEffect(() => {
    let abandoned = false
    let scene: TanksScene | null = null
    let cancelReveal: (() => void) | undefined
    setRevealed(false); setError(null); setFallbackEnvironment(false)
    resetOpening()
    void import('./scene').then(({ TanksScene }) => {
      if (abandoned || !hostRef.current) return
      scene = new TanksScene(hostRef.current, {
        onReady: () => {
          if (abandoned) return
          cancelReveal = revealOpening(() => {
            if (abandoned) return
            setRevealed(true)
            scene?.setPaused(pausedRef.current)
          })
        },
        onError: reason => {
          if (abandoned) return
          cancelReveal?.()
          hideOpening()
          setError(reason)
        },
        onEnvironmentFallback: () => { if (!abandoned) setFallbackEnvironment(true) },
      }, true)
      sceneRef.current = scene
      scene.setMurk(murkRef.current)
      void scene.start()
    }).catch(reason => {
      if (!abandoned) { hideOpening(); setError(toTanksSceneError(reason)) }
    })
    return () => { abandoned = true; cancelReveal?.(); sceneRef.current = null; scene?.dispose() }
  }, [generation])

  useEffect(() => { if (revealed) sceneRef.current?.setPaused(paused) }, [paused, revealed])
  useEffect(() => { sceneRef.current?.setMurk(murk) }, [murk])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => { if (preference.matches) setPaused(true) }
    preference.addEventListener('change', onChange)
    return () => preference.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    if (error) { sceneRef.current?.dispose(); sceneRef.current = null }
  }, [error])

  const feed = useCallback(() => { sceneRef.current?.feed(); setPaused(false) }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.metaKey || event.altKey || event.ctrlKey) return
      if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); setPaused(value => !value) }
      if (event.key.toLowerCase() === 'r') sceneRef.current?.resetView()
      if (event.key.toLowerCase() === 'f') feed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [feed])

  return <div className="tanks-page" aria-busy={!revealed && !error}>
    <div ref={hostRef} className="tanks-canvas" role="img" aria-label="Golden fish swim beneath floating wooden docks and fine nets, fading into deep, murky water." />
    {error && <div className="tanks-error" role="alert">
      <p>{sceneErrorMessage(error)}</p>
      <button type="button" onClick={() => setGeneration(value => value + 1)}>Retry</button>
      {import.meta.env.DEV && <details><summary>Technical details</summary><pre>{error.details}</pre></details>}
    </div>}
    {DevControls && revealed && !error && <Suspense fallback={null}>
      <DevControls sceneRef={sceneRef} paused={paused} setPaused={setPaused} murk={murk} setMurk={setMurk} feed={feed} fallbackEnvironment={fallbackEnvironment} />
    </Suspense>}
    <p className="sr-only">Drag with either mouse button or one finger to orbit. Move two fingers together to orbit and pinch to zoom during the same gesture. Scroll with a mouse or trackpad, or middle-drag to zoom. Hold Shift while scrolling to orbit. Tap the water to create a ripple. Space pauses or resumes, F scatters food, and R resets the view. Reduced motion starts the scene paused.</p>
  </div>
}
