import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, Color, CylinderGeometry, Float32BufferAttribute,
  Group, InstancedBufferAttribute, InstancedMesh, LineBasicMaterial, LineSegments,
  Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, ShaderMaterial, Shape, ShapeGeometry,
  SRGBColorSpace, TextureLoader, TorusGeometry, TubeGeometry, Vector2, Vector3,
  type Texture,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PENS, seededRandom, TANK_LAYOUT } from './simulation'

export interface FloatingDock { group: Group; phase: number; x: number; z: number }

const NET_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uCover;
  varying vec2 vUv;
  #include <clipping_planes_pars_vertex>
  void main() {
    vUv = uv;
    vec3 p = position;
    if (uCover > 0.5) {
      float sag = sin(uv.x * 3.14159265) * sin(uv.y * 3.14159265);
      p.y -= sag * 0.16;
      p.y += sin(p.x * 0.6 + p.z * 0.7 + uTime * 0.7) * 0.007 * sag;
    } else {
      p.z += sin(uv.x * 7.0 + uTime * 0.28) * sin(uv.y * 3.14159265) * 0.05;
    }
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`

const NET_FRAGMENT = /* glsl */ `
  uniform vec2 uSize;
  uniform float uCover;
  varying vec2 vUv;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    vec2 p = vUv * uSize / 0.105;
    // Interwoven diagonal strands, filtered analytically to avoid shimmering.
    p = vec2(p.x + p.y, p.y - p.x) * 0.70710678;
    vec2 distanceToThread = abs(fract(p - 0.5) - 0.5);
    vec2 pixelWidth = max(fwidth(p), vec2(0.002));
    vec2 thread = 1.0 - smoothstep(vec2(0.016), vec2(0.016) + pixelWidth * 0.85, distanceToThread);
    float coverage = max(thread.x, thread.y);
    float alpha = coverage * mix(0.44, 0.31, uCover);
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(mix(vec3(0.025, 0.043, 0.029), vec3(0.075, 0.098, 0.063), thread.x * thread.y), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function createNets() {
  const group = new Group()
  const materials: ShaderMaterial[] = []
  const makeMaterial = (width: number, height: number, cover: boolean) => {
    const material = new ShaderMaterial({
      name: 'TanksNet',
      vertexShader: NET_VERTEX, fragmentShader: NET_FRAGMENT, transparent: true,
      depthWrite: false, side: 2, clipping: true,
      uniforms: { uTime: { value: 0 }, uSize: { value: new Vector2(width, height) }, uCover: { value: cover ? 1 : 0 } },
    })
    materials.push(material)
    return material
  }
  for (const pen of PENS) {
    const width = pen.halfWidth * 2 + 0.22, length = pen.halfLength * 2 + 0.22
    const topGeometry = new PlaneGeometry(width, length, 24, 32)
    topGeometry.rotateX(-Math.PI / 2)
    const cover = new Mesh(topGeometry, makeMaterial(width, length, true))
    cover.position.set(pen.x, 0.075, pen.z)
    cover.renderOrder = 3
    group.add(cover)
    const depth = 3.0
    for (const sign of [-1, 1]) {
      const side = new Mesh(new PlaneGeometry(length, depth, 30, 8), makeMaterial(length, depth, false))
      side.rotation.y = Math.PI / 2
      side.position.set(pen.x + sign * (pen.halfWidth + 0.08), -depth / 2, pen.z)
      group.add(side)
      const end = new Mesh(new PlaneGeometry(width, depth, 24, 8), makeMaterial(width, depth, false))
      end.position.set(pen.x, -depth / 2, pen.z + sign * (pen.halfLength + 0.08))
      group.add(end)
    }
  }
  return { group, materials }
}

export async function loadWoodTextures() {
  const loader = new TextureLoader()
  const textures = await Promise.allSettled([
    loader.loadAsync(`${import.meta.env.BASE_URL}tanks/wood-planks-color.webp`),
    loader.loadAsync(`${import.meta.env.BASE_URL}tanks/wood-planks-normal.webp`),
    loader.loadAsync(`${import.meta.env.BASE_URL}tanks/wood-planks-roughness.webp`),
  ])
  const [map, normalMap, roughnessMap] = textures.map(result => result.status === 'fulfilled' ? result.value : null)
  if (map) map.colorSpace = SRGBColorSpace
  for (const texture of [map, normalMap, roughnessMap]) if (texture) texture.anisotropy = 8
  return { map, normalMap, roughnessMap }
}

export function createDocks(textures: { map: Texture | null; normalMap: Texture | null; roughnessMap: Texture | null }) {
  const root = new Group(), docks: FloatingDock[] = []
  const { pitchX, pitchZ, dockWidth } = TANK_LAYOUT
  const across = dockWidth / 0.84
  const random = seededRandom(39612)
  const plankGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.035)
  // Give the upper face continuous, lengthwise grain instead of the box's side UVs.
  const uv = plankGeometry.getAttribute('uv'), position = plankGeometry.getAttribute('position'), normal = plankGeometry.getAttribute('normal')
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(normal.getY(i)) > 0.6) uv.setXY(i, position.getX(i) + 0.5, position.getZ(i) + 0.5)
    else if (Math.abs(normal.getX(i)) > 0.6) uv.setXY(i, position.getZ(i) + 0.5, position.getY(i) + 0.5)
    else uv.setXY(i, position.getX(i) + 0.5, position.getY(i) + 0.5)
  }
  const wood = new MeshStandardMaterial({
    name: 'TanksTimber',
    ...textures, color: textures.map ? '#b7b5a6' : '#8d8b77', roughness: 0.94,
    normalScale: new Vector2(0.48, 0.48), envMapIntensity: 0.65,
  })
  wood.onBeforeCompile = shader => {
    shader.vertexShader = `attribute vec2 plankOffset;\nattribute vec2 plankScale;\n${shader.vertexShader}`
      .replace('#include <uv_vertex>', `
        #include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * plankScale + plankOffset;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = uv * plankScale + plankOffset;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = uv * plankScale + plankOffset;
        #endif
      `)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTimberPosition;')
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        float damp = 1.0 - smoothstep(-0.025, 0.23, vTimberPosition.y);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.35, 0.42, 0.28), damp * 0.72);
      `)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTimberPosition;')
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        vec4 timberPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          timberPosition = instanceMatrix * timberPosition;
        #endif
        vTimberPosition = (modelMatrix * timberPosition).xyz;
      `)
  }
  wood.customProgramCacheKey = () => 'weathered-timber-v1'
  const beamMaterial = new MeshStandardMaterial({ color: '#454c38', roughness: 0.98 })
  const floatMaterial = new MeshStandardMaterial({ name: 'TanksFloats', color: '#a7aaa0', roughness: 0.97 })
  floatMaterial.onBeforeCompile = shader => {
    shader.vertexShader = `varying vec3 vFloatPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloatPosition = position + vec3(0.0, 0.22, 0.0);')
    shader.fragmentShader = `varying vec3 vFloatPosition;\n${shader.fragmentShader}`.replace('#include <color_fragment>', `
      #include <color_fragment>
      float mottling = fract(sin(dot(floor(vFloatPosition * 180.0), vec3(12.9898, 78.233, 43.23))) * 43758.5453);
      float tide = 1.0 - smoothstep(-0.12, 0.2, vFloatPosition.y + sin(vFloatPosition.z * 22.0) * 0.025);
      diffuseColor.rgb *= mix(vec3(0.82 + mottling * 0.18), vec3(0.20, 0.29, 0.16), tide * 0.83);
    `)
  }
  floatMaterial.customProgramCacheKey = () => 'algae-floats-v1'
  const bandMaterial = new MeshStandardMaterial({ color: '#27372c', roughness: 0.88 })
  const metalMaterial = new MeshStandardMaterial({ color: '#494d40', metalness: 0.68, roughness: 0.8 })
  const rustMaterial = new MeshStandardMaterial({ color: '#554334', metalness: 0.35, roughness: 0.95 })
  const ropeMaterial = new MeshStandardMaterial({ color: '#315549', roughness: 1 })
  const floatGeometry = new RoundedBoxGeometry(0.68 * across, 0.5, 0.79, 2, 0.075)
  const boltGeometry = new CylinderGeometry(0.018, 0.022, 0.011, 7)
  const dummy = new Object3D(), tint = new Color()

  function addSection(x: number, z: number, length: number, rotation: number) {
    const group = new Group()
    group.position.set(x, 0, z)
    group.rotation.y = rotation
    const boards: { x: number; z: number; length: number; tone: number }[] = []
    const nails: { x: number; y: number; z: number }[] = []
    const scars: number[] = []
    for (let lane = 0; lane < 3; lane++) {
      let start = -length / 2
      while (start < length / 2 - 0.05) {
        const boardLength = Math.min(1.25 + random() * 1.1, length / 2 - start)
        const boardX = ((lane - 1) * 0.277 + (random() - 0.5) * 0.009) * across
        const boardZ = start + boardLength / 2
        boards.push({ x: boardX, z: boardZ, length: boardLength - 0.025, tone: random() })
        for (const side of [-1, 1]) for (const end of [-1, 1]) {
          nails.push({ x: boardX + side * 0.086 * across, y: 0.245, z: boardZ + end * (boardLength / 2 - 0.095) })
        }
        for (let c = 0; c < 2; c++) {
          const scarX = boardX + (random() - 0.5) * 0.2 * across, scarZ = start + random() * boardLength
          scars.push(scarX, 0.245, scarZ, scarX + (random() - 0.5) * 0.012, 0.245, scarZ + random() * 0.5)
        }
        start += boardLength
      }
    }
    const geometry = plankGeometry.clone()
    const offsets = new Float32Array(boards.length * 2), scales = new Float32Array(boards.length * 2)
    geometry.setAttribute('plankOffset', new InstancedBufferAttribute(offsets, 2))
    geometry.setAttribute('plankScale', new InstancedBufferAttribute(scales, 2))
    const planks = new InstancedMesh(geometry, wood, boards.length)
    boards.forEach((board, i) => {
      dummy.position.set(board.x, 0.18 + (random() - 0.5) * 0.01, board.z)
      dummy.rotation.set((random() - 0.5) * 0.005, (random() - 0.5) * 0.008, (random() - 0.5) * 0.015)
      dummy.scale.set(0.262 * across, 0.123, board.length)
      dummy.updateMatrix()
      planks.setMatrixAt(i, dummy.matrix)
      tint.setHSL(0.10 + random() * 0.04, 0.04 + random() * 0.07, 0.68 + board.tone * 0.3)
      planks.setColorAt(i, tint)
      offsets[i * 2] = random() * 0.87; offsets[i * 2 + 1] = random() * 0.12
      scales[i * 2] = 0.10; scales[i * 2 + 1] = 0.72 + random() * 0.22
    })
    planks.castShadow = true
    planks.receiveShadow = true
    group.add(planks)
    const bolts = new InstancedMesh(boltGeometry, metalMaterial, nails.length)
    dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1)
    nails.forEach((nail, i) => {
      dummy.position.set(nail.x, nail.y, nail.z); dummy.updateMatrix(); bolts.setMatrixAt(i, dummy.matrix)
    })
    group.add(bolts)
    const scarGeometry = new BufferGeometry()
    scarGeometry.setAttribute('position', new Float32BufferAttribute(scars, 3))
    group.add(new LineSegments(scarGeometry, new LineBasicMaterial({ color: '#4b4a3e', transparent: true, opacity: 0.35 })))
    for (const sign of [-1, 1]) {
      const beam = new Mesh(new BoxGeometry(0.075 * across, 0.19, length + 0.04), beamMaterial)
      beam.position.set(sign * 0.33 * across, 0.045, 0)
      beam.castShadow = true; group.add(beam)
    }
    for (let floatZ = -length / 2 + 0.55; floatZ < length / 2; floatZ += 1.24) {
      const float = new Mesh(floatGeometry, floatMaterial)
      float.position.set((random() - 0.5) * 0.05, -0.22, floatZ)
      float.rotation.y = (random() - 0.5) * 0.06
      float.castShadow = true
      group.add(float)
      for (const offset of [-0.24, 0.24]) {
        const strap = new Mesh(new BoxGeometry(0.7 * across, 0.52, 0.03), bandMaterial)
        strap.position.set(float.position.x, -0.22, floatZ + offset)
        group.add(strap)
      }
    }
    // Raised net line and knots track the same floating assembly as the timber.
    for (const sign of [-1, 1]) {
      const points = []
      for (let n = 0; n <= 12; n++) points.push(new Vector3(sign * 0.48 * across, 0.12 - Math.sin(n / 12 * Math.PI) * 0.055, -length / 2 + n / 12 * length))
      const rope = new Mesh(new TubeGeometry(new CatmullRomCurve3(points), 36, 0.012, 5, false), ropeMaterial)
      group.add(rope)
      for (const end of [-1, 1]) {
        const eyelet = new Mesh(new TorusGeometry(0.047, 0.012, 5, 12), metalMaterial)
        eyelet.rotation.x = -Math.PI / 2
        eyelet.position.set(sign * 0.22 * across, 0.261, end * (length / 2 - 0.15))
        group.add(eyelet)
        const knot = new Mesh(new TorusGeometry(0.036, 0.012, 5, 10), ropeMaterial)
        knot.rotation.set(Math.PI / 3, 0.4, 0.3)
        knot.position.set(sign * 0.3 * across, 0.263, end * (length / 2 - 0.13))
        group.add(knot)
      }
    }
    root.add(group)
    docks.push({ group, phase: random() * Math.PI * 2, x, z })
    return group
  }
  for (const column of [-1.5, -0.5, 0.5, 1.5]) {
    for (const row of [-1, 0, 1]) addSection(column * pitchX, row * pitchZ, pitchZ - dockWidth, 0)
  }
  for (const row of [-1.5, -0.5, 0.5, 1.5]) {
    for (const column of [-2, -1, 0, 1, 2]) addSection(column * pitchX, row * pitchZ, pitchX - dockWidth, Math.PI / 2)
  }
  // The salvaged pole, spliced rope and blue scrap echo the small irregularities in the reference.
  const pole = new Mesh(new CylinderGeometry(0.023, 0.035, 3.4, 10), new MeshStandardMaterial({ color: '#b9a387', roughness: 0.86 }))
  pole.rotation.x = Math.PI / 2; pole.rotation.z = 0.05; pole.position.set(-0.12, 0.34, -0.7)
  docks.find(dock => dock.x === -pitchX / 2 && dock.z === 0)?.group.add(pole)
  const brace = new Mesh(new BoxGeometry(0.14, 0.06, 1.8), beamMaterial)
  brace.position.set(-0.1, 0.31, 1.9); brace.rotation.y = 0.39
  docks.find(dock => dock.x === pitchX / 2 && dock.z === 0)?.group.add(brace)
  const scrapShape = new Shape()
  scrapShape.moveTo(-0.17, -0.04); scrapShape.lineTo(-0.11, 0.04); scrapShape.lineTo(0.01, 0.065)
  scrapShape.lineTo(0.08, 0.03); scrapShape.lineTo(0.2, 0.07); scrapShape.lineTo(0.17, -0.035); scrapShape.lineTo(0.02, -0.02); scrapShape.closePath()
  const scrap = new Mesh(new ShapeGeometry(scrapShape), new MeshStandardMaterial({ color: '#287a9e', roughness: 0.45, side: 2 }))
  scrap.rotation.x = -Math.PI / 2; scrap.position.set(0.05, 0.258, 1.8)
  scrap.scale.setScalar(0.75)
  docks.find(dock => dock.x === 0 && dock.z === pitchZ / 2)?.group.add(scrap)
  // A few rusty repair plates are deliberately sparse.
  for (const index of [4, 7, 14, 19]) {
    const plate = new Mesh(new BoxGeometry(0.19, 0.009, 0.37), rustMaterial)
    plate.position.set(0.08, 0.254, -1.3); plate.rotation.y = 0.08
    docks[index].group.add(plate)
  }
  // Bake the fixed fittings per floating assembly to keep the three water passes affordable.
  const sourceGeometries = new Set<BufferGeometry>()
  for (const dock of docks) {
    const batches = new Map<MeshStandardMaterial, BufferGeometry[]>()
    for (const child of [...dock.group.children]) {
      if (!(child instanceof Mesh) || child instanceof InstancedMesh) continue
      child.updateMatrix()
      const material = child.material as MeshStandardMaterial
      const geometry = child.geometry.clone().applyMatrix4(child.matrix)
      const batch = batches.get(material) ?? []
      batch.push(geometry)
      batches.set(material, batch)
      sourceGeometries.add(child.geometry)
      dock.group.remove(child)
    }
    for (const [material, geometries] of batches) {
      const merged = mergeGeometries(geometries, false)
      if (merged) {
        const mesh = new Mesh(merged, material)
        mesh.castShadow = true; mesh.receiveShadow = true
        dock.group.add(mesh)
      }
      geometries.forEach(geometry => geometry.dispose())
    }
  }
  sourceGeometries.forEach(geometry => geometry.dispose())
  plankGeometry.dispose()
  return { group: root, docks }
}

export function updateDocks(docks: FloatingDock[], time: number) {
  for (const dock of docks) {
    const swell = Math.sin(time * 0.64 + dock.x * 0.16 + dock.z * 0.12)
    dock.group.position.y = swell * 0.012 + Math.sin(time * 1.02 + dock.phase) * 0.003
    dock.group.rotation.x = Math.sin(time * 0.51 + dock.phase) * 0.0016
    dock.group.rotation.z = Math.cos(time * 0.43 + dock.phase) * 0.0023
    dock.group.position.x = dock.x + Math.sin(time * 0.23 + dock.phase) * 0.003
    dock.group.position.z = dock.z + Math.sin(time * 0.19 + dock.phase) * 0.004
  }
}
