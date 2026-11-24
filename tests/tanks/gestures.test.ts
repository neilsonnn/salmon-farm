import { afterEach, describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SceneGestures } from '../../src/tanks/gestures'

// EventTarget and a real camera/OrbitControls exercise routing and camera motion
// without a browser, graphics context, screenshots or rendered-page verification.
class CanvasTarget extends EventTarget {
  clientHeight = 800
  style = { touchAction: '' }
  root = new EventTarget()
  getRootNode() { return this.root }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

function rig() {
  const element = new CanvasTarget()
  const camera = new PerspectiveCamera(40, 1.5, 0.1, 150)
  camera.position.set(4, 8, 8)
  const controls = new OrbitControls(camera, null)
  controls.minDistance = 6.1; controls.maxDistance = 20
  controls.minPolarAngle = 0.22; controls.maxPolarAngle = 1.03
  controls.rotateSpeed = 0.35; controls.zoomSpeed = 0.65
  controls.enablePan = false; controls.enableDamping = true
  controls.update(); controls.saveState()
  const gestures = new SceneGestures(controls, element as unknown as HTMLElement)
  // In a browser our capture listener runs before OrbitControls' bubbling listener.
  controls.connect(element as unknown as HTMLElement)
  cleanups.push(() => { gestures.dispose(); controls.dispose() })
  const send = (type: string, values: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true, bubbles: true })
    for (const [key, value] of Object.entries({ timeStamp: 1000, ...values })) Object.defineProperty(event, key, { value })
    element.dispatchEvent(event)
    return event
  }
  const wheel = (values: Record<string, unknown> = {}) => send('wheel', { deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, clientX: 400, clientY: 300, ...values })
  const step = (frames = 60, dt = 1 / 60) => {
    for (let i = 0; i < frames; i++) { gestures.update(dt); controls.update() }
  }
  return { element, camera, controls, gestures, send, wheel, step }
}

describe('Trackpad, pinch and mouse-wheel controls', () => {
  it('orbits both axes on a two-finger scroll without changing camera distance', () => {
    const r = rig(), radius = r.controls.getDistance()
    const theta = r.controls.getAzimuthalAngle(), phi = r.controls.getPolarAngle()
    expect(r.wheel({ deltaX: 15.5, deltaY: 8.25 }).defaultPrevented).toBe(true)
    r.step()
    expect(r.controls.getAzimuthalAngle()).toBeLessThan(theta)
    expect(r.controls.getPolarAngle()).toBeLessThan(phi)
    expect(r.controls.getDistance()).toBeCloseTo(radius, 10)
  })

  it('keeps fast scrolling and momentum in orbit after a gentle trackpad start', () => {
    const r = rig(), radius = r.controls.getDistance(), phi = r.controls.getPolarAngle()
    r.wheel({ deltaY: 2, wheelDeltaY: -6 })
    r.wheel({ deltaY: 100, wheelDeltaY: -120, timeStamp: 1016 })
    r.wheel({ deltaY: 120, wheelDeltaY: -360, timeStamp: 1032 })
    r.step()
    expect(r.controls.getDistance()).toBeCloseTo(radius, 10)
    expect(r.controls.getPolarAngle()).toBeLessThan(phi)
    expect(r.controls.getPolarAngle()).toBeGreaterThanOrEqual(r.controls.minPolarAngle)
  })

  it.each([
    { deltaMode: 0, deltaY: 100, wheelDeltaY: -120 },
    { deltaMode: 0, deltaY: 4.25, wheelDeltaY: -120 },
    { deltaMode: 1, deltaY: 3 },
    { deltaMode: 2, deltaY: 1 },
  ])('zooms a mouse wheel without orbiting: %j', sample => {
    const r = rig(), radius = r.controls.getDistance(), theta = r.controls.getAzimuthalAngle(), phi = r.controls.getPolarAngle()
    r.wheel(sample); r.step()
    expect(r.controls.getDistance()).toBeGreaterThan(radius)
    expect(r.controls.getDistance()).toBeLessThanOrEqual(r.controls.maxDistance)
    expect(r.controls.getAzimuthalAngle()).toBeCloseTo(theta, 10)
    expect(r.controls.getPolarAngle()).toBeCloseTo(phi, 10)
  })

  it('recognizes switching from trackpad to a mouse between gestures', () => {
    const r = rig(), radius = r.controls.getDistance()
    r.wheel({ deltaY: 2 }); r.step()
    r.wheel({ deltaY: 100, wheelDeltaY: -120, timeStamp: 2000 }); r.step()
    expect(r.controls.getDistance()).toBeGreaterThan(radius)
  })

  it('routes ctrl-wheel pinch to zoom and cancels pending orbit', () => {
    const r = rig(), radius = r.controls.getDistance(), theta = r.controls.getAzimuthalAngle()
    r.wheel({ deltaX: 20, deltaY: 10 })
    r.wheel({ ctrlKey: true, deltaY: -2.5, timeStamp: 1016 }); r.step()
    expect(r.controls.getDistance()).toBeLessThan(radius)
    expect(r.controls.getAzimuthalAngle()).toBeCloseTo(theta, 10)
  })

  it('uses incremental Safari pinch scale, preserves angles and clamps zoom distance', () => {
    const r = rig(), radius = r.controls.getDistance(), theta = r.controls.getAzimuthalAngle()
    r.send('gesturestart', { scale: 1 })
    r.send('gesturechange', { scale: 1.2, timeStamp: 1016 })
    r.send('gesturechange', { scale: 1.5, timeStamp: 1032 })
    expect(r.controls.getDistance()).toBeCloseTo(radius / Math.pow(1.5, r.controls.zoomSpeed), 10)
    r.send('gesturechange', { scale: 1.5, timeStamp: 1048 })
    expect(r.controls.getDistance()).toBeCloseTo(radius / Math.pow(1.5, r.controls.zoomSpeed), 10)
    expect(r.controls.getAzimuthalAngle()).toBeCloseTo(theta, 10)
    r.send('gesturechange', { scale: 100, timeStamp: 1064 })
    expect(r.controls.getDistance()).toBeCloseTo(r.controls.minDistance, 10)
    r.send('gesturechange', { scale: 0.001, timeStamp: 1080 })
    expect(r.controls.getDistance()).toBeCloseTo(r.controls.maxDistance, 10)
  })

  it('does not double-zoom when Safari native gestures arrive before ctrl-wheel', () => {
    const r = rig(), radius = r.controls.getDistance()
    r.send('gesturestart', { scale: 1 })
    r.wheel({ ctrlKey: true, deltaY: -5, timeStamp: 1001 })
    r.send('gesturechange', { scale: 1.4, timeStamp: 1016 })
    r.send('gestureend', { scale: 1.4, timeStamp: 1032 })
    r.wheel({ ctrlKey: true, deltaY: -1, timeStamp: 1040 })
    expect(r.controls.getDistance()).toBeCloseTo(radius / Math.pow(1.4, r.controls.zoomSpeed), 10)
  })

  it('does not double-zoom when ctrl-wheel arrives before Safari native gestures', () => {
    const r = rig()
    r.wheel({ ctrlKey: true, deltaY: -2 })
    const radius = r.controls.getDistance()
    r.send('gesturestart', { scale: 1, timeStamp: 1001 })
    r.send('gesturechange', { scale: 1.4, timeStamp: 1016 })
    r.send('gestureend', { scale: 1.4, timeStamp: 1032 })
    expect(r.controls.getDistance()).toBeCloseTo(radius, 10)
  })

  it('leaves touchscreen gestures to OrbitControls', () => {
    const r = rig(), radius = r.controls.getDistance()
    r.send('pointerdown', { pointerType: 'touch', pointerId: 1, pageX: 100, pageY: 100 })
    expect(r.send('gesturestart', { scale: 1 }).defaultPrevented).toBe(false)
    r.send('gesturechange', { scale: 1.5, timeStamp: 1016 })
    expect(r.controls.getDistance()).toBeCloseTo(radius, 10)
    r.send('pointerup', { pointerType: 'touch', pointerId: 1 })
  })

  it('clears pending scroll on reset and removes gesture handlers on disposal', () => {
    const r = rig(), start = r.camera.position.clone()
    r.wheel({ deltaX: 25, deltaY: 20 })
    r.gestures.reset(); r.controls.reset(); r.step()
    expect(r.camera.position.distanceTo(start)).toBeLessThan(1e-10)
    r.gestures.dispose()
    expect(r.send('gesturestart', { scale: 1 }).defaultPrevented).toBe(false)
    r.wheel({ deltaY: 5 }); r.step()
    expect(r.controls.getDistance()).toBeGreaterThan(start.length())
  })

  it('filters scrolling consistently across render rates', () => {
    const a = rig(), b = rig()
    a.wheel({ deltaX: 25, deltaY: 12 }); b.wheel({ deltaX: 25, deltaY: 12 })
    a.step(30, 1 / 30); b.step(144, 1 / 144)
    expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-6)
  })
})
