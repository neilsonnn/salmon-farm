import {
  BufferGeometry, Color, DataTexture, DynamicDrawUsage, Float32BufferAttribute, FloatType, NearestFilter, RGBAFormat,
  InstancedMesh, MeshStandardMaterial, SphereGeometry,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FishSchool, seededRandom } from './simulation'
import { FISH_HEAD, FISH_LENGTH, fishSection, SPINE_LINKS } from './locomotion'

const SPINE_TEXELS = Math.ceil(SPINE_LINKS / 2)
export const FISH_POSE_TEXELS = SPINE_TEXELS + 1
const FIN_ROOT = (FISH_HEAD - 0.20) / FISH_LENGTH * SPINE_LINKS
const SPINE_SHADER = /* glsl */ `
  uniform highp sampler2D uFoidPose;
  attribute float finRole;
  vec3 foidFinPosition(vec3 p, out mat3 rotation) {
    vec4 finPose = texelFetch(uFoidPose, ivec2(${SPINE_TEXELS}, gl_InstanceID), 0);
    float sideIndex = step(0.0, finRole);
    float sweep = mix(finPose.x, finPose.y, sideIndex) * abs(finRole);
    float pitch = mix(finPose.z, finPose.w, sideIndex) * abs(finRole);
    float cs = cos(sweep), ss = sin(sweep), cp = cos(pitch), sp = sin(pitch);
    // Feather about the span axis, then row about the physical root.
    rotation = mat3(cs * cp, sp, ss * cp, -cs * sp, cp, -ss * sp, -ss, 0.0, cs);
    vec3 pivot = vec3(0.20, -0.018, finRole * 0.06);
    return pivot + rotation * (p - pivot);
  }
  vec2 foidPoint(float index) {
    if (index < 0.5) return vec2(0.0);
    int point = int(index) - 1;
    vec4 joints = texelFetch(uFoidPose, ivec2(point / 2, gl_InstanceID), 0);
    return point % 2 == 0 ? joints.xy : joints.zw;
  }
  // Hermite interpolation keeps the skin smooth between the physical, fixed-length links.
  vec2 foidFrame(float x, out vec2 forward) {
    float along = clamp((${FISH_HEAD.toFixed(3)} - x) / ${FISH_LENGTH.toFixed(3)}, 0.0, 1.0) * ${SPINE_LINKS.toFixed(1)};
    float segment = min(floor(along), ${(SPINE_LINKS - 1).toFixed(1)});
    float t = along - segment;
    vec2 a = foidPoint(segment), b = foidPoint(segment + 1.0);
    vec2 previous = segment < 0.5 ? a * 2.0 - b : foidPoint(segment - 1.0);
    vec2 next = segment > ${(SPINE_LINKS - 1.5).toFixed(1)} ? b * 2.0 - a : foidPoint(segment + 2.0);
    vec2 ma = (b - previous) * 0.5, mb = (next - a) * 0.5;
    float t2 = t * t, t3 = t2 * t;
    vec2 center = (2.0 * t3 - 3.0 * t2 + 1.0) * a + (t3 - 2.0 * t2 + t) * ma
      + (-2.0 * t3 + 3.0 * t2) * b + (t3 - t2) * mb;
    vec2 derivative = (6.0 * t2 - 6.0 * t) * a + (3.0 * t2 - 4.0 * t + 1.0) * ma
      + (-6.0 * t2 + 6.0 * t) * b + (3.0 * t2 - 2.0 * t) * mb;
    forward = -normalize(derivative + vec2(-0.000001, 0.0));
    return center;
  }
`

function colorGeometry(geometry: BufferGeometry, color: Color) {
  const positions = geometry.getAttribute('position')
  const colors = new Float32Array(positions.count * 3)
  for (let i = 0; i < positions.count; i++) color.toArray(colors, i * 3)
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  if (!geometry.hasAttribute('finRole')) geometry.setAttribute('finRole', new Float32BufferAttribute(new Float32Array(positions.count), 1))
  return geometry
}

/** A tapered, ring-built body with separate caudal, dorsal, pectoral and pelvic fins. */
export function createFishGeometry() {
  const positions: number[] = [], colors: number[] = [], indices: number[] = []
  const rings = 28, sides = 14
  const dorsal = new Color('#827e36'), flank = new Color('#d1b952'), belly = new Color('#b9b58a')
  const color = new Color()
  for (let r = 0; r <= rings; r++) {
    const t = r / rings, x = -0.45 + t * 0.94
    const { width, height } = fishSection(x)
    for (let s = 0; s <= sides; s++) {
      const angle = s / sides * Math.PI * 2
      const y = Math.cos(angle) * height, z = Math.sin(angle) * width
      positions.push(x, y, z)
      color.copy(flank).lerp(y > 0 ? dorsal : belly, Math.min(1, Math.abs(y) / (height + 0.001)) * (y > 0 ? 0.62 : 0.7))
      const scales = 1 + Math.sin(t * 195 + s % 2 * 2) * 0.055 + Math.sin(s * 19.3 + t * 73) * 0.025
      color.multiplyScalar(scales)
      if (Math.abs(Math.cos(angle) - 0.05) < 0.19 && t > 0.17 && t < 0.86) color.multiplyScalar(0.77)
      colors.push(color.r, color.g, color.b)
      if (r < rings && s < sides) {
        const a = r * (sides + 1) + s, b = a + sides + 1
        indices.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
  }
  const body = new BufferGeometry()
  body.setAttribute('position', new Float32BufferAttribute(positions, 3))
  body.setAttribute('color', new Float32BufferAttribute(colors, 3))
  body.setAttribute('finRole', new Float32BufferAttribute(new Float32Array(positions.length / 3), 1))
  body.setIndex(indices)
  body.computeVertexNormals()
  const finPositions: number[] = [], finRoles: number[] = []
  const triangle = (a: number[], b: number[], c: number[], role = 0) => {
    finPositions.push(...a, ...b, ...c, ...c, ...b, ...a)
    for (let vertex = 0; vertex < 6; vertex++) finRoles.push(role)
  }
  // Forked tail: both lobes have thickness and remain visible while the fish rolls.
  triangle([-0.39, 0, 0], [-0.72, 0.15, 0.017], [-0.62, 0, 0])
  triangle([-0.39, 0, 0], [-0.62, 0, 0], [-0.72, -0.14, -0.017])
  triangle([-0.38, 0.012, 0], [-0.67, 0.045, 0.065], [-0.69, -0.035, -0.055])
  triangle([0.18, 0.07, 0], [-0.12, 0.18, 0], [-0.28, 0.055, 0])
  for (const sign of [-1, 1]) {
    triangle([0.2, -0.018, 0.06 * sign], [-0.1, -0.045, 0.21 * sign], [0.01, -0.03, 0.05 * sign], sign)
    triangle([-0.07, -0.065, 0.04 * sign], [-0.25, -0.11, 0.1 * sign], [-0.16, -0.06, 0.035 * sign])
  }
  const fins = new BufferGeometry()
  fins.setAttribute('position', new Float32BufferAttribute(finPositions, 3))
  fins.setAttribute('finRole', new Float32BufferAttribute(finRoles, 1))
  fins.computeVertexNormals()
  colorGeometry(fins, new Color('#a39246'))
  const geometries: BufferGeometry[] = [body.toNonIndexed(), fins]
  for (const sign of [-1, 1]) {
    const eye = new SphereGeometry(0.014, 7, 5).scale(1.1, 1.05, 0.45).translate(0.345, 0.036, sign * 0.048)
    eye.deleteAttribute('uv')
    colorGeometry(eye, new Color('#161e13'))
    geometries.push(eye.toNonIndexed())
    eye.dispose()
  }
  const merged = mergeGeometries(geometries, false)!
  body.dispose()
  geometries.forEach(geometry => geometry.dispose())
  return merged
}

export function createFishMesh(school: FishSchool) {
  const geometry = createFishGeometry()
  // Instanced matrices/colors and Three's own inputs also consume locations.
  // Store pose rows in a texture so the 12-link rig leaves ample input headroom.
  const poseData = new Float32Array(FISH_POSE_TEXELS * 4 * school.count)
  const poseTexture = new DataTexture(poseData, FISH_POSE_TEXELS, school.count, RGBAFormat, FloatType)
  poseTexture.name = 'TanksFishPose'
  poseTexture.minFilter = NearestFilter; poseTexture.magFilter = NearestFilter
  poseTexture.generateMipmaps = false
  const updatePose = () => {
    for (let i = 0; i < school.count; i++) {
      let at = i * FISH_POSE_TEXELS * 4
      for (const packed of school.spines.packed) {
        for (let k = 0; k < 4; k++) poseData[at++] = packed[i * 4 + k]
      }
      for (let k = 0; k < 4; k++) poseData[at++] = school.spines.fins[i * 4 + k]
    }
    poseTexture.needsUpdate = true
  }
  updatePose()
  const material = new MeshStandardMaterial({
    name: 'TanksFish',
    vertexColors: true, roughness: 0.39, metalness: 0.18, envMapIntensity: 0.8,
  })
  material.onBeforeCompile = shader => {
    shader.uniforms.uFoidPose = { value: poseTexture }
    shader.vertexShader = `${SPINE_SHADER}\n${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        mat3 foidFinRotation;
        vec3 foidLocal = foidFinPosition(position, foidFinRotation);
        vec2 foidForward;
        vec2 foidCenter = foidFrame(foidLocal.x, foidForward);
        if (abs(finRole) > 0.5) {
          vec2 rootA = foidPoint(${Math.floor(FIN_ROOT).toFixed(1)}), rootB = foidPoint(${(Math.floor(FIN_ROOT) + 1).toFixed(1)});
          foidCenter = mix(rootA, rootB, ${FIN_ROOT - Math.floor(FIN_ROOT)});
          foidForward = -normalize(rootB - rootA);
        }
        objectNormal = foidFinRotation * objectNormal;
        objectNormal.xz = vec2(
          objectNormal.x * foidForward.x - objectNormal.z * foidForward.y,
          objectNormal.x * foidForward.y + objectNormal.z * foidForward.x
        );
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        transformed.xz = foidCenter + foidForward * (abs(finRole) * (foidLocal.x - 0.20))
          + vec2(-foidForward.y, foidForward.x) * foidLocal.z;
        transformed.y = foidLocal.y;
      `)
  }
  material.customProgramCacheKey = () => 'tanks-coupled-body-fluid-pose-texture-v3'
  const mesh = new InstancedMesh(geometry, material, school.count)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.frustumCulled = false
  const random = seededRandom(611)
  const tint = new Color()
  for (let i = 0; i < school.count; i++) {
    const variation = random()
    tint.setHSL(0.112 + random() * 0.037, 0.1 + random() * 0.25, 0.59 + random() * 0.2)
    if (variation < 0.13) tint.set('#909983')
    if (variation > 0.93) tint.set('#e4c579')
    mesh.setColorAt(i, tint)
  }
  return { mesh, poseTexture, updatePose }
}
