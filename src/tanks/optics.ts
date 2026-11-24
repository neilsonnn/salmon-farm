/** Shared by the water shader, controls, and nonvisual visibility checks. */
export const MURKINESS = { default: 1.85, min: 0.35, max: 3.2 } as const
export const WATER_EXTINCTION = [2, 1.85, 1.8] as const
export const SILT_DEPTH_GRADIENT = 0.9
export const REFRACTION_STRENGTH = 0.012
export const MAX_REFRACTION_PIXELS = 1.25

/** Surface-only mapping: the same ripple displaces fish and background coherently. */
export function refractionPixelOffset(slopeX: number, slopeZ: number, width: number, height: number) {
  const x = slopeX * REFRACTION_STRENGTH * width, y = slopeZ * REFRACTION_STRENGTH * height
  const scale = Math.min(1, MAX_REFRACTION_PIXELS / Math.max(0.00001, Math.hypot(x, y)))
  return { x: x * scale, y: y * scale }
}

/** Integrate an extinction density that grows with depth, rather than a uniform tint. */
export function waterTransmittance(depth: number, murk: number = MURKINESS.default, sediment = 1) {
  const distance = Math.max(0, Math.min(8, depth))
  const opticalDepth = distance * (1 + SILT_DEPTH_GRADIENT * distance) * murk * sediment
  return WATER_EXTINCTION.map(extinction => Math.exp(-extinction * opticalDepth))
}
