import { MathUtils, Quaternion, Spherical, Vector3 } from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface WheelSample {
  deltaMode: number
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  timeStamp: number
  wheelDeltaY?: number
}

/** Browsers expose scroll units/deltas, not a reliable physical-device identifier. */
class WheelIntent {
  private intent: 'orbit' | 'zoom' | null = null
  private lastTime = -Infinity

  classify(event: WheelSample) {
    // Read the unit before the deltas: some browsers change their interpretation on access.
    const mode = event.deltaMode
    if (event.ctrlKey || mode !== 0) { this.reset(); return 'zoom' }
    if (event.timeStamp - this.lastTime > 250 || event.timeStamp < this.lastTime) this.intent = null
    this.lastTime = event.timeStamp
    if (this.intent) return this.intent
    const { deltaX, deltaY, wheelDeltaY } = event
    const notch = wheelDeltaY !== undefined && Math.abs(wheelDeltaY) >= 120
      && Math.abs(wheelDeltaY) % 120 === 0
    const continuous = deltaX !== 0 || (!notch && (!Number.isInteger(deltaY) || Math.abs(deltaY) < 50))
    this.intent = continuous ? 'orbit' : 'zoom'
    return this.intent
  }

  reset() { this.intent = null; this.lastTime = -Infinity }
}

interface NativeGesture extends Event { scale: number }

/** Trackpad orbit augments OrbitControls; its mouse, wheel zoom and touch controls remain native. */
export class SceneGestures {
  private readonly wheelIntent = new WheelIntent()
  private readonly offset = new Vector3()
  private readonly spherical = new Spherical()
  private readonly upToY = new Quaternion()
  private readonly fromY = new Quaternion()
  private readonly worldUp = new Vector3(0, 1, 0)
  private readonly touches = new Set<number>()
  private pendingTheta = 0
  private pendingPhi = 0
  private nativeScale: number | null = null
  private nativeUsesWheel = false
  private lastWheelPinch = -Infinity
  private suppressWheelPinchUntil = -Infinity

  constructor(private readonly controls: OrbitControls, private readonly element: HTMLElement) {
    element.addEventListener('wheel', this.onWheel, { capture: true, passive: false })
    element.addEventListener('gesturestart', this.onGestureStart, { passive: false })
    element.addEventListener('gesturechange', this.onGestureChange, { passive: false })
    element.addEventListener('gestureend', this.onGestureEnd, { passive: false })
    element.addEventListener('pointerdown', this.onPointerDown, true)
    element.addEventListener('pointerup', this.onPointerUp, true)
    element.addEventListener('pointercancel', this.onPointerUp, true)
  }

  private consume(event: Event) { event.preventDefault(); event.stopImmediatePropagation() }
  private clearOrbit() { this.pendingTheta = 0; this.pendingPhi = 0 }

  private onWheel = (event: WheelEvent) => {
    if (!this.controls.enabled) return
    if (event.ctrlKey) {
      this.clearOrbit()
      this.wheelIntent.reset()
      // A browser may emit both native gesture events and ctrl-wheel for one pinch.
      if ((this.nativeScale !== null && !this.nativeUsesWheel) || event.timeStamp <= this.suppressWheelPinchUntil) {
        this.consume(event); return
      }
      this.lastWheelPinch = event.timeStamp
    }
    if (this.wheelIntent.classify(event) === 'zoom') { this.clearOrbit(); return }
    this.consume(event)
    if (!this.controls.enableRotate) return
    const radiansPerPixel = 2 * Math.PI * this.controls.rotateSpeed / Math.max(1, this.element.clientHeight)
    this.pendingTheta -= event.deltaX * radiansPerPixel
    this.pendingPhi -= event.deltaY * radiansPerPixel
  }

  private onPointerDown = (event: PointerEvent) => {
    this.clearOrbit()
    if (event.pointerType === 'touch') this.touches.add(event.pointerId)
  }
  private onPointerUp = (event: PointerEvent) => { this.touches.delete(event.pointerId) }

  private onGestureStart = (event: Event) => {
    if (!this.controls.enabled || !this.controls.enableZoom || this.touches.size) return
    const { scale } = event as NativeGesture
    if (!Number.isFinite(scale) || scale <= 0) return
    this.consume(event)
    this.nativeScale = scale
    const sinceWheel = event.timeStamp - this.lastWheelPinch
    this.nativeUsesWheel = sinceWheel >= 0 && sinceWheel < 120
  }

  private onGestureChange = (event: Event) => {
    if (this.nativeScale === null || !this.controls.enabled || !this.controls.enableZoom) return
    this.consume(event)
    const { scale } = event as NativeGesture
    if (!Number.isFinite(scale) || scale <= 0) return
    const previous = this.nativeScale
    this.nativeScale = scale
    if (this.nativeUsesWheel || scale === previous) return
    this.clearOrbit()
    this.wheelIntent.reset()
    const camera = this.controls.object
    this.offset.copy(camera.position).sub(this.controls.target)
    const distance = this.offset.length()
    if (distance <= 0) return
    const radius = MathUtils.clamp(distance * Math.pow(previous / scale, this.controls.zoomSpeed), this.controls.minDistance, this.controls.maxDistance)
    camera.position.copy(this.controls.target).add(this.offset.multiplyScalar(radius / distance))
    this.controls.update()
  }

  private onGestureEnd = (event: Event) => {
    if (this.nativeScale === null) return
    this.consume(event)
    if (!this.nativeUsesWheel) this.suppressWheelPinchUntil = event.timeStamp + 120
    this.nativeScale = null
  }

  /** Drain scroll input smoothly, including OS-generated momentum, without changing distance. */
  update(elapsed: number) {
    if (!this.controls.enabled || !this.controls.enableRotate) { this.clearOrbit(); return }
    if (Math.abs(this.pendingTheta) + Math.abs(this.pendingPhi) < 1e-8) { this.clearOrbit(); return }
    const portion = 1 - Math.exp(-30 * Math.max(0, elapsed))
    const theta = this.pendingTheta * portion, phi = this.pendingPhi * portion
    this.pendingTheta -= theta; this.pendingPhi -= phi
    const camera = this.controls.object
    this.upToY.setFromUnitVectors(camera.up, this.worldUp)
    this.fromY.copy(this.upToY).invert()
    this.offset.copy(camera.position).sub(this.controls.target).applyQuaternion(this.upToY)
    this.spherical.setFromVector3(this.offset)
    this.spherical.theta = MathUtils.clamp(this.spherical.theta + theta, this.controls.minAzimuthAngle, this.controls.maxAzimuthAngle)
    this.spherical.phi = MathUtils.clamp(this.spherical.phi + phi, this.controls.minPolarAngle, this.controls.maxPolarAngle)
    this.spherical.makeSafe()
    this.offset.setFromSpherical(this.spherical).applyQuaternion(this.fromY)
    camera.position.copy(this.controls.target).add(this.offset)
  }

  reset() {
    this.clearOrbit(); this.wheelIntent.reset(); this.touches.clear()
    this.nativeScale = null; this.nativeUsesWheel = false
    this.lastWheelPinch = -Infinity; this.suppressWheelPinchUntil = -Infinity
  }

  dispose() {
    this.reset()
    this.element.removeEventListener('wheel', this.onWheel, true)
    this.element.removeEventListener('gesturestart', this.onGestureStart)
    this.element.removeEventListener('gesturechange', this.onGestureChange)
    this.element.removeEventListener('gestureend', this.onGestureEnd)
    this.element.removeEventListener('pointerdown', this.onPointerDown, true)
    this.element.removeEventListener('pointerup', this.onPointerUp, true)
    this.element.removeEventListener('pointercancel', this.onPointerUp, true)
  }
}
