import {
  Color, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector4,
  type Texture,
} from 'three'
import {
  DIFFUSION_KERNEL, MAX_DIFFUSION_PIXELS, MAX_REFRACTION_PIXELS, MURKINESS,
  REFRACTION_STRENGTH, SILT_DEPTH_GRADIENT, WATER_DIFFUSION, WATER_EXTINCTION,
} from './optics'

export const WATER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform mat4 uReflectionMatrix;
  varying vec3 vWorld;
  varying vec4 vProjected;
  varying vec4 vReflection;
  void main() {
    vec3 p = position;
    vec4 world = modelMatrix * vec4(p, 1.0);
    world.y += sin(world.x * 1.37 + world.z * 0.71 + uTime * 0.83) * 0.009;
    world.y += sin(world.x * -0.67 + world.z * 2.19 - uTime * 0.63) * 0.006;
    vWorld = world.xyz;
    vReflection = uReflectionMatrix * world;
    vProjected = projectionMatrix * viewMatrix * world;
    gl_Position = vProjected;
  }
`

export const WATER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uMurk;
  uniform float uNear;
  uniform float uFar;
  uniform sampler2D uRefraction;
  uniform sampler2D uDepth;
  uniform sampler2D uReflection;
  uniform sampler2D uEnvironment;
  uniform vec2 uResolution;
  uniform vec4 uRipples[8];
  varying vec3 vWorld;
  varying vec4 vProjected;
  varying vec4 vReflection;
  const float PI = 3.14159265359;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float linearDepth(float depth) { return uNear * uFar / (uFar - depth * (uFar - uNear)); }
  // Each tap carries its own water column. A near fish must not lend its shallow
  // attenuation to another, displaced silhouette in the diffusion footprint.
  vec3 submergedSample(vec2 uv, float surfaceDepth, float verticalView, float density, vec3 scattering) {
    uv = clamp(uv, vec2(0.002), vec2(0.998));
    float depth = linearDepth(texture2D(uDepth, uv).x);
    float thickness = clamp((depth - surfaceDepth) * verticalView, 0.025, 8.0);
    float opticalDepth = thickness * (1.0 + ${SILT_DEPTH_GRADIENT.toFixed(2)} * thickness) * density;
    vec3 absorption = exp(-vec3(${WATER_EXTINCTION.map(value => value.toFixed(2)).join(', ')}) * opticalDepth);
    return texture2D(uRefraction, uv).rgb * absorption + scattering * (1.0 - absorption);
  }
  vec2 environmentUv(vec3 direction) {
    return vec2(atan(direction.z, direction.x) / (2.0 * PI) + 0.5, asin(clamp(direction.y, -1.0, 1.0)) / PI + 0.5);
  }
  vec2 slope(vec2 p) {
    vec2 n = vec2(0.0);
    n += vec2(1.37, 0.71) * cos(dot(p, vec2(1.37, 0.71)) + uTime * 0.83) * 0.009;
    n += vec2(-0.67, 2.19) * cos(dot(p, vec2(-0.67, 2.19)) - uTime * 0.63) * 0.006;
    n += vec2(5.1, -3.7) * cos(dot(p, vec2(5.1, -3.7)) + uTime * 1.08) * 0.0025;
    n += vec2(11.3, 7.1) * cos(dot(p, vec2(11.3, 7.1)) - uTime * 1.67) * 0.00075;
    n += vec2(-18.7, 13.4) * cos(dot(p, vec2(-18.7, 13.4)) + uTime * 2.1) * 0.00032;
    vec2 drift = vec2(uTime * 0.026, -uTime * 0.013);
    n += vec2(noise(p * 3.8 + drift), noise(p * 4.2 - drift + 41.7)) * 0.017 - 0.0085;
    for (int i = 0; i < 8; i++) {
      vec4 r = uRipples[i];
      vec2 delta = p - r.xy;
      float distanceToRipple = length(delta) + 0.001;
      float front = distanceToRipple - r.z * 0.9;
      float envelope = exp(-front * front * 4.5) * exp(-r.z * 0.68) * r.w;
      n += delta / distanceToRipple * cos(front * 23.0) * envelope * 0.085;
    }
    return n;
  }
  void main() {
    vec2 normalSlope = slope(vWorld.xz);
    vec3 normal = normalize(vec3(-normalSlope.x, 1.0, -normalSlope.y));
    vec3 viewDirection = normalize(cameraPosition - vWorld);
    vec2 screen = vProjected.xy / vProjected.w * 0.5 + 0.5;
    float surfaceDepth = linearDepth(gl_FragCoord.z);
    // Do not use foreground depth to move the sampling UV: the sharp depth jump
    // at a fish edge otherwise maps that fish into two different screen positions.
    vec2 shift = normalSlope * ${REFRACTION_STRENGTH.toFixed(3)} * uResolution;
    shift *= min(1.0, ${MAX_REFRACTION_PIXELS.toFixed(2)} / max(0.00001, length(shift)));
    vec2 refractionUv = clamp(screen + shift / uResolution, vec2(0.002), vec2(0.998));
    float verticalView = max(0.25, viewDirection.y);
    float refractedDepth = linearDepth(texture2D(uDepth, refractionUv).x);
    float thickness = clamp((refractedDepth - surfaceDepth) * verticalView, 0.025, 8.0);
    vec2 diffusion = vec2(1.0) / uResolution * min(${MAX_DIFFUSION_PIXELS.toFixed(2)}, 0.35 + thickness * thickness * uMurk * ${WATER_DIFFUSION.toFixed(2)});
    float sediment = noise(vWorld.xz * 0.29 + uTime * 0.009) * 0.65 + noise(vWorld.xz * 0.71) * 0.35;
    float density = uMurk * (0.85 + sediment * 0.4);
    vec3 scattering = mix(vec3(0.033, 0.043, 0.035), vec3(0.073, 0.081, 0.064), sediment);
    vec3 transmitted = vec3(0.0);
    ${DIFFUSION_KERNEL.map(tap => `transmitted += submergedSample(refractionUv + diffusion * vec2(${tap.x.toFixed(1)}, ${tap.y.toFixed(1)}), surfaceDepth, verticalView, density, scattering) * ${tap.weight.toFixed(4)};`).join('\n    ')}
    vec3 reflectedRay = reflect(-viewDirection, normal);
    vec3 environment = texture2D(uEnvironment, environmentUv(reflectedRay)).rgb;
    vec2 reflectionUv = vReflection.xy / vReflection.w * 0.5 + 0.5;
    reflectionUv = clamp(reflectionUv + normalSlope * 0.16, vec2(0.003), vec2(0.997));
    vec3 planar = texture2D(uReflection, reflectionUv).rgb;
    vec3 reflected = mix(planar, environment * 0.26, 0.27);
    float facing = max(0.0, dot(normal, viewDirection));
    // Schlick's approximation for the air/water boundary (IOR 1.333).
    float fresnel = 0.0204 + 0.9796 * pow(1.0 - facing, 5.0);
    vec3 color = mix(transmitted, reflected * 0.8, fresnel);
    // Broad, restrained overcast glints, with no hard tropical sun disc.
    vec3 lightDirection = normalize(vec3(-0.4, 0.9, -0.35));
    float glint = pow(max(dot(reflect(-lightDirection, normal), viewDirection), 0.0), 160.0);
    color += vec3(0.63, 0.65, 0.57) * glint * 0.19;
    float fleck = pow(noise(vWorld.xz * 145.0 + vec2(uTime * 0.03, 0.0)), 18.0);
    color += vec3(0.07, 0.08, 0.055) * fleck;
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function createWater(refraction: Texture, depth: Texture, reflection: Texture, environment: Texture) {
  const material = new ShaderMaterial({
    name: 'TanksWater',
    vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT,
    uniforms: {
      uTime: { value: 0 }, uMurk: { value: MURKINESS.default }, uNear: { value: 0.1 }, uFar: { value: 150 },
      uRefraction: { value: refraction }, uDepth: { value: depth }, uReflection: { value: reflection },
      uEnvironment: { value: environment }, uReflectionMatrix: { value: new Matrix4() },
      uResolution: { value: new Vector2(1, 1) },
      uRipples: { value: Array.from({ length: 8 }, () => new Vector4(0, 0, 100, 0)) },
    },
  })
  const geometry = new PlaneGeometry(180, 180, 180, 180)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 1
  return { mesh, material }
}

/** A local fallback keeps the scene available if an HDR file cannot be decoded. */
export function fallbackSkyPixels() {
  const width = 256, height = 128
  const data = new Uint8Array(width * height * 4)
  const sky = new Color('#bac2ba'), ground = new Color('#263c2e'), color = new Color()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const horizon = height * (0.46 + Math.sin(x * 0.041) * 0.05 + Math.sin(x * 0.17) * 0.04)
    const tree = Math.max(0, Math.min(1, (y - horizon) / 7))
    color.copy(sky).lerp(ground, tree).multiplyScalar(0.85 + Math.sin(x * 0.11 + y * 0.04) * 0.12)
    const offset = (y * width + x) * 4
    data[offset] = color.r * 255; data[offset + 1] = color.g * 255; data[offset + 2] = color.b * 255; data[offset + 3] = 255
  }
  return { data, width, height }
}
