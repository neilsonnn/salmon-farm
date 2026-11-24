import { useState, type RefObject } from 'react'
import type { TanksScene } from './scene'
import { MURKINESS } from './optics'
import './dev.css'

interface Props {
  sceneRef: RefObject<TanksScene | null>
  paused: boolean
  setPaused: (value: boolean) => void
  murk: number
  setMurk: (value: number) => void
  feed: () => void
  fallbackEnvironment: boolean
}

export default function DevControls({ sceneRef, paused, setPaused, murk, setMurk, feed, fallbackEnvironment }: Props) {
  const [status, setStatus] = useState('')
  const [recording, setRecording] = useState(false)
  const save = async (kind: 'opening' | 'thumbnail') => {
    const scene = sceneRef.current
    if (!scene) return
    try {
      setStatus('Saving…')
      const data = kind === 'opening' ? scene.captureFrame(2880, 960) : scene.captureFrame(2560, 1440)
      const image = await (await fetch(data)).blob()
      const result = await fetch(`/__capture/${kind}`, { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: image })
      if (!result.ok) throw new Error(await result.text())
      setStatus(kind === 'opening' ? 'Opening still saved.' : 'Thumbnail saved.')
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Capture failed.') }
  }
  const record = async () => {
    const scene = sceneRef.current
    if (!scene || recording) return
    setRecording(true); setStatus('Recording…'); setPaused(false)
    try {
      const video = await scene.recordPreview()
      const result = await fetch('/__capture/video', { method: 'POST', headers: { 'Content-Type': video.type }, body: video })
      if (!result.ok) throw new Error(await result.text())
      setStatus('Video saved.')
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Recording failed.') }
    finally { setRecording(false); setPaused(paused) }
  }
  return <details className="tanks-debug">
    <summary>Debug</summary>
    <div className="tanks-debug-panel">
      <div className="tanks-debug-buttons">
        <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        <button type="button" onClick={feed}>Feed</button>
        <button type="button" onClick={() => sceneRef.current?.resetView()}>Reset view</button>
      </div>
      <label htmlFor="murk">Murkiness <output htmlFor="murk">{murk.toFixed(2)}</output></label>
      <input id="murk" type="range" min={MURKINESS.min} max={MURKINESS.max} step="0.01" value={murk} onChange={event => setMurk(Number(event.target.value))} />
      <div className="tanks-debug-buttons">
        <button type="button" disabled={recording} onClick={() => save('opening')}>Save opening still</button>
        <button type="button" disabled={recording} onClick={() => save('thumbnail')}>Save thumbnail</button>
        <button type="button" disabled={recording} onClick={record}>Record preview</button>
      </div>
      {fallbackEnvironment && <p>Using the procedural sky.</p>}
      <p role="status">{status}</p>
    </div>
  </details>
}
