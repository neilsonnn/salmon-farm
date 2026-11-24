import {
  ACESFilmicToneMapping, AmbientLight, BufferGeometry, Color, DataTexture, DepthTexture,
  DirectionalLight, EquirectangularReflectionMapping, Float32BufferAttribute, Group,
  HalfFloatType, HemisphereLight, Matrix4, Mesh, MeshStandardMaterial, NoToneMapping,
  Object3D, PCFSoftShadowMap, PerspectiveCamera, Plane, PlaneGeometry, PMREMGenerator,
  Points, Raycaster, RGBAFormat, Scene, ShaderMaterial, SRGBColorSpace, UnsignedByteType,
  UnsignedIntType, Vector2, Vector3, Vector4, WebGLRenderer, WebGLRenderTarget,
  type Material, type Texture,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { createDocks, createNets, loadWoodTextures, updateDocks, type FloatingDock } from './docks'
import { createFishMesh } from './fish'
import { FishSchool, seededRandom } from './simulation'
import { createWater, fallbackSkyPixels } from './water'
import { MURKINESS } from './optics'
import { FishPhysicsRunner } from './physicsRunner'
import { shaderCompilationError, TanksSceneError, toTanksSceneError } from './errors'
import { openingFieldOfView } from './opening'
import { SceneGestures } from './gestures'

interface SceneCallbacks { onReady: () => void; onError: (error: TanksSceneError) => void; onEnvironmentFallback: () => void }

export class TanksScene {
  readonly school = new FishSchool()
  private readonly physics: FishPhysicsRunner
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly underwater = new Group()
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 150)
  private readonly reflectionCamera = new PerspectiveCamera(40, 1, 0.1, 150)
  private readonly controls: OrbitControls
  private readonly gestures: SceneGestures
  private readonly refraction = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true })
  private readonly reflection = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true })
  private readonly fish = createFishMesh(this.school)
  private readonly dummy = new Object3D()
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private readonly hit = new Vector3()
  private readonly waterPlane = new Plane(new Vector3(0, 1, 0), 0)
  private readonly underwaterClip = [new Plane(new Vector3(0, -1, 0), 0.018)]
  private readonly reflectionClip = [new Plane(new Vector3(0, 1, 0), -0.012)]
  private readonly darkWater = new Color('#19261f')
  private readonly lookAt = new Vector3()
  private readonly up = new Vector3()
  private readonly textures = new Set<Texture>()
  private readonly resizeObserver: ResizeObserver
  private readonly ambientMaterials: ShaderMaterial[] = []
  private environment: Texture
  private environmentTarget: WebGLRenderTarget | null = null
  private water: ReturnType<typeof createWater>
  private docks: FloatingDock[] = []
  private netMaterials: ShaderMaterial[] = []
  private lastFrame = 0
  private accumulator = 0
  private dirty = true
  private disposed = false
  private initialized = false
  private ready = false
  private paused: boolean
  private pointerDown = { x: 0, y: 0, time: 0 }
  private lastWaterPoint: { x: number; z: number } | null = null

  constructor(private host: HTMLElement, private callbacks: SceneCallbacks, paused: boolean) {
    this.paused = paused
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    } catch (error) {
      throw toTanksSceneError(error, 'context-unavailable')
    }
    this.renderer.setClearColor(this.darkWater)
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.03
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.localClippingEnabled = true
    this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      const error = shaderCompilationError(gl, program, vertex, fragment)
      console.error(error.message, error.details)
      throw error
    }
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    host.appendChild(this.renderer.domElement)
    this.textures.add(this.fish.poseTexture)
    this.refraction.depthTexture = new DepthTexture(1, 1, UnsignedIntType)
    const fallback = fallbackSkyPixels()
    this.environment = new DataTexture(fallback.data, fallback.width, fallback.height, RGBAFormat, UnsignedByteType)
    this.environment.mapping = EquirectangularReflectionMapping
    this.environment.needsUpdate = true
    this.textures.add(this.environment)
    this.scene.background = this.environment
    this.scene.backgroundIntensity = 0.26
    this.scene.environment = this.environment
    this.scene.environmentIntensity = 0.65
    this.water = createWater(this.refraction.texture, this.refraction.depthTexture, this.reflection.texture, this.environment)
    this.scene.add(this.water.mesh, this.underwater)
    this.underwater.add(this.fish.mesh)
    this.camera.position.set(2.54, 8.37, 6.96)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(-0.15, -0.25, 0)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.065
    this.controls.enablePan = false
    this.controls.minDistance = 6.1
    this.controls.maxDistance = 20
    this.controls.minPolarAngle = 0.22
    this.controls.maxPolarAngle = 1.03
    this.controls.rotateSpeed = 0.35
    this.controls.zoomSpeed = 0.65
    this.controls.update()
    this.controls.saveState()
    this.gestures = new SceneGestures(this.controls, this.renderer.domElement)
    this.controls.addEventListener('change', this.invalidate)
    this.addLighting()
    this.addBottom()
    this.addParticles()
    const nets = createNets()
    this.scene.add(nets.group)
    this.netMaterials = nets.materials
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(host)
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp)
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.physics = new FishPhysicsRunner(this.school, message => {
      this.renderer.setAnimationLoop(null)
      this.callbacks.onError(new TanksSceneError('simulation', message))
    })
    this.physics.suspend(paused || document.hidden)
    this.resize()
    this.updateFish()
  }

  async start() {
    try {
      const [hdrResult, woodResult] = await Promise.allSettled([
        new HDRLoader().loadAsync(`${import.meta.env.BASE_URL}tanks/misty_pines_2k.hdr`), loadWoodTextures(),
      ])
      if (this.disposed) {
        if (hdrResult.status === 'fulfilled') hdrResult.value.dispose()
        if (woodResult.status === 'fulfilled') Object.values(woodResult.value).forEach(texture => texture?.dispose())
        return
      }
      if (hdrResult.status === 'fulfilled') {
        const hdr = hdrResult.value
        hdr.mapping = EquirectangularReflectionMapping
        this.environment = hdr
        this.textures.add(hdr)
        const generator = new PMREMGenerator(this.renderer)
        this.environmentTarget = generator.fromEquirectangular(hdr)
        this.scene.environment = this.environmentTarget.texture
        this.scene.background = hdr
        this.water.material.uniforms.uEnvironment.value = hdr
        generator.dispose()
      } else this.callbacks.onEnvironmentFallback()
      const wood = woodResult.status === 'fulfilled' ? woodResult.value : { map: null, normalMap: null, roughnessMap: null }
      Object.values(wood).forEach(texture => { if (texture) this.textures.add(texture) })
      const docks = createDocks(wood)
      this.docks = docks.docks
      this.scene.add(docks.group)
      this.initialized = true
      this.renderer.shadowMap.needsUpdate = true
      this.lastFrame = performance.now()
      if (!document.hidden) this.renderer.setAnimationLoop(this.frame)
    } catch (error) {
      if (!this.disposed) this.callbacks.onError(toTanksSceneError(error, 'loading'))
    }
  }

  setPaused(value: boolean) { this.paused = value; this.physics.suspend(value || document.hidden); this.accumulator = 0; this.lastFrame = performance.now(); this.dirty = true }
  setMurk(value: number) { this.water.material.uniforms.uMurk.value = Math.max(MURKINESS.min, Math.min(MURKINESS.max, value)); this.dirty = true }
  resetView() { this.gestures.reset(); this.controls.reset(); this.dirty = true }
  feed() {
    const point = this.lastWaterPoint ?? { x: 0.4, z: 1.5 }
    this.physics.disturb(point.x, point.z, 'food')
    this.dirty = true
  }

  captureFrame(width: number, height: number) {
    if (!import.meta.env.DEV) throw new Error('Scene capture is available in development.')
    if (!this.initialized || this.disposed) throw new Error('Wait for the scene to finish loading.')
    try {
      this.setViewport(width, height, 1, false)
      this.renderer.shadowMap.needsUpdate = true
      this.render()
      // Read in the same task as the render; preserving the drawing buffer is unnecessary.
      return this.renderer.domElement.toDataURL('image/webp', 0.92)
    } finally {
      this.resize()
    }
  }

  recordPreview() {
    if (!import.meta.env.DEV) throw new Error('Scene recording is available in development.')
    if (!this.initialized || this.disposed) throw new Error('Wait for the scene to finish loading.')
    if (typeof MediaRecorder === 'undefined') throw new Error('Video recording is unavailable in this browser.')
    this.setViewport(1200, 675, 1, false)
    const stream = this.renderer.domElement.captureStream(24)
    return new Promise<Blob>((resolve, reject) => {
      let timer = 0
      const cleanup = () => { window.clearTimeout(timer); stream.getTracks().forEach(track => track.stop()); if (!this.disposed) this.resize() }
      try {
        const mimeType = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
        if (!mimeType) throw new Error('No supported video recorder was found.')
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 })
        const chunks: Blob[] = []
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
        recorder.onerror = () => { cleanup(); reject(new Error('Scene recording was interrupted.')) }
        recorder.onstop = () => { cleanup(); resolve(new Blob(chunks, { type: recorder.mimeType.split(';')[0] })) }
        recorder.start()
        timer = window.setTimeout(() => recorder.stop(), 4500)
      } catch (reason) { cleanup(); reject(reason) }
    })
  }

  private addLighting() {
    this.scene.add(new HemisphereLight('#d5dfd7', '#34452b', 1.45), new AmbientLight('#9baa91', 0.3))
    const sun = new DirectionalLight('#fff4d9', 2.1)
    sun.position.set(-9, 19, -8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -20; sun.shadow.camera.right = 20
    sun.shadow.camera.top = 23; sun.shadow.camera.bottom = -23
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 65
    sun.shadow.normalBias = 0.018; sun.shadow.bias = -0.00015
    sun.shadow.radius = 3
    this.scene.add(sun)
  }

  private addBottom() {
    const geometry = new PlaneGeometry(150, 150)
    geometry.rotateX(-Math.PI / 2)
    const material = new MeshStandardMaterial({ name: 'TanksBottom', color: '#46503a', roughness: 1, envMapIntensity: 0.2 })
    const time = { value: 0 }
    material.onBeforeCompile = shader => {
      shader.uniforms.uBottomTime = time
      shader.vertexShader = `varying vec3 vBottomWorld;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBottomWorld = (modelMatrix * vec4(position, 1.0)).xyz;')
      shader.fragmentShader = `uniform float uBottomTime;\nvarying vec3 vBottomWorld;\n${shader.fragmentShader}`
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          float silt = sin(vBottomWorld.x * 1.7 + sin(vBottomWorld.z * 2.3)) * 0.08;
          silt += sin(vBottomWorld.x * 13.0 + vBottomWorld.z * 9.0) * 0.018;
          float caustic = pow(max(0.0, sin(vBottomWorld.x * 3.3 + sin(vBottomWorld.z * 4.1 + uBottomTime * 0.3)) * sin(vBottomWorld.z * 4.0 + uBottomTime * 0.25)), 10.0);
          diffuseColor.rgb *= 0.72 + silt + caustic * 0.06;
        `)
    }
    material.userData.time = time
    const bottom = new Mesh(geometry, material)
    bottom.position.y = -4.3
    bottom.receiveShadow = true
    this.underwater.add(bottom)
  }

  private addParticles() {
    const random = seededRandom(303)
    const positions = new Float32Array(800 * 3)
    const seeds = new Float32Array(800)
    for (let i = 0; i < seeds.length; i++) {
      positions[i * 3] = (random() - 0.5) * 35
      positions[i * 3 + 1] = -0.1 - random() * 2.7
      positions[i * 3 + 2] = (random() - 0.5) * 40
      seeds[i] = random()
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('seed', new Float32BufferAttribute(seeds, 1))
    const material = new ShaderMaterial({
      name: 'TanksSilt',
      uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime; attribute float seed; varying float vAlpha;
        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.035 + seed * 39.0) * 0.22;
          p.z += cos(uTime * 0.028 + seed * 17.0) * 0.19;
          p.y += sin(uTime * 0.09 + seed * 6.28) * 0.035;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((10.0 + seed * 9.0) / -mv.z, 0.6, 2.0);
          vAlpha = 0.1 + seed * 0.19;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(0.36, 0.39, 0.24, (1.0 - smoothstep(0.05, 0.5, d)) * vAlpha);
        }
      `,
    })
    this.ambientMaterials.push(material)
    this.underwater.add(new Points(geometry, material))
  }

  private updateFish() {
    const { school, dummy } = this
    for (let i = 0; i < school.count; i++) {
      dummy.position.set(school.x[i], -school.depth[i], school.z[i])
      // Coordinate frame only: the packed centerline and fin poses come directly
      // from the coupled mechanical solver. No render-only swimming animation.
      dummy.rotation.set(0, -school.heading[i], 0)
      dummy.scale.setScalar(school.length[i])
      dummy.updateMatrix()
      this.fish.mesh.setMatrixAt(i, dummy.matrix)
    }
    this.fish.mesh.instanceMatrix.needsUpdate = true
    this.fish.updatePose()
  }

  private invalidate = () => { this.dirty = true }

  private resize = () => {
    if (this.disposed) return
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight)
    // Limit actual pixel work, including both offscreen passes, on dense displays.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.65, Math.sqrt(2_800_000 / (width * height)))
    this.setViewport(width, height, pixelRatio)
  }

  private setViewport(width: number, height: number, pixelRatio: number, updateStyle = true) {
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(width, height, updateStyle)
    this.camera.aspect = width / height
    this.camera.fov = openingFieldOfView(this.camera.aspect)
    this.camera.updateProjectionMatrix()
    const scale = Math.min(1, 1650 / (width * pixelRatio))
    this.refraction.setSize(Math.max(1, Math.round(width * pixelRatio * scale)), Math.max(1, Math.round(height * pixelRatio * scale)))
    this.reflection.setSize(Math.max(1, Math.round(width * pixelRatio * 0.5)), Math.max(1, Math.round(height * pixelRatio * 0.5)))
    this.water.material.uniforms.uResolution.value.set(this.refraction.width, this.refraction.height)
    this.dirty = true
  }

  private onPointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0 || performance.now() - this.pointerDown.time > 450
      || Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 7) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    if (this.raycaster.ray.intersectPlane(this.waterPlane, this.hit)
      && this.physics.disturb(this.hit.x, this.hit.z)) {
      this.lastWaterPoint = { x: this.hit.x, z: this.hit.z }
      this.dirty = true
    }
  }

  private onContextLost = (event: Event) => {
    event.preventDefault()
    this.renderer.setAnimationLoop(null)
    this.callbacks.onError(new TanksSceneError('context-lost', 'The graphics context was interrupted.'))
  }

  private onVisibility = () => {
    if (this.disposed || !this.initialized) return
    if (document.hidden) this.gestures.reset()
    this.lastFrame = performance.now(); this.accumulator = 0
    this.physics.suspend(this.paused || document.hidden)
    this.renderer.setAnimationLoop(document.hidden ? null : this.frame)
  }

  private frame = (now: number) => {
    if (this.disposed || document.hidden) return
    const elapsed = Math.min(0.075, Math.max(0, (now - this.lastFrame) / 1000))
    this.lastFrame = now
    this.gestures.update(elapsed)
    const moved = this.controls.update()
    if (!this.paused) {
      this.accumulator += elapsed
      while (this.accumulator >= 1 / 60) { this.physics.step(1 / 60); this.accumulator -= 1 / 60 }
      this.updateFish()
      updateDocks(this.docks, this.school.time)
      this.water.material.uniforms.uTime.value = this.school.time
      this.netMaterials.forEach(material => { material.uniforms.uTime.value = this.school.time })
      this.ambientMaterials.forEach(material => { material.uniforms.uTime.value = this.school.time })
      for (let i = 0; i < 8; i++) {
        const ripple = this.school.disturbances[i]
        const value: Vector4 = this.water.material.uniforms.uRipples.value[i]
        if (ripple) value.set(ripple.x, ripple.z, ripple.age, ripple.kind === 'food' ? 0.25 : ripple.strength)
        else value.set(0, 0, 100, 0)
      }
      this.dirty = true
    }
    if (this.dirty || moved) {
      try {
        this.render()
        this.dirty = false
        if (!this.ready) { this.ready = true; this.callbacks.onReady() }
      } catch (error) {
        this.renderer.setAnimationLoop(null)
        this.callbacks.onError(toTanksSceneError(error, 'render'))
      }
    }
  }

  private render() {
    const { renderer, scene, camera, reflectionCamera, water } = this
    camera.updateMatrixWorld()
    // The underwater pass remains linear HDR; absorption is applied once at the surface.
    water.mesh.visible = false
    scene.background = this.darkWater
    renderer.toneMapping = NoToneMapping
    renderer.clippingPlanes = this.underwaterClip
    renderer.setRenderTarget(this.refraction)
    renderer.render(scene, camera)
    // Mirrored camera supplies real dock reflections, together with the photographed sky.
    this.underwater.visible = false
    scene.background = this.environment
    reflectionCamera.position.copy(camera.position)
    reflectionCamera.position.y *= -1
    camera.getWorldDirection(this.lookAt)
    this.lookAt.add(camera.position); this.lookAt.y *= -1
    this.up.copy(camera.up); this.up.y *= -1
    reflectionCamera.up.copy(this.up)
    reflectionCamera.lookAt(this.lookAt)
    reflectionCamera.projectionMatrix.copy(camera.projectionMatrix)
    reflectionCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse)
    reflectionCamera.updateMatrixWorld()
    const reflectionMatrix: Matrix4 = water.material.uniforms.uReflectionMatrix.value
    reflectionMatrix.multiplyMatrices(reflectionCamera.projectionMatrix, reflectionCamera.matrixWorldInverse)
    renderer.clippingPlanes = this.reflectionClip
    renderer.setRenderTarget(this.reflection)
    renderer.render(scene, reflectionCamera)
    water.mesh.visible = true
    renderer.clippingPlanes = []
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)
    this.underwater.visible = true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.physics.dispose()
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.removeEventListener('change', this.invalidate)
    this.gestures.dispose()
    this.controls.dispose()
    document.removeEventListener('visibilitychange', this.onVisibility)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('webglcontextlost', this.onContextLost)
    const geometries = new Set<BufferGeometry>(), materials = new Set<Material>()
    this.scene.traverse(object => {
      const drawable = object as Mesh
      if (drawable.geometry) geometries.add(drawable.geometry)
      if (drawable.material) (Array.isArray(drawable.material) ? drawable.material : [drawable.material]).forEach(material => materials.add(material))
      if (object instanceof DirectionalLight) { object.shadow.map?.dispose(); object.shadow.mapPass?.dispose() }
    })
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
    this.textures.forEach(texture => texture.dispose())
    this.refraction.dispose(); this.reflection.dispose(); this.environmentTarget?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
  }
}
