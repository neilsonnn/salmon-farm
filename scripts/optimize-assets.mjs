import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FloatType } from 'three'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'

// Rebuild derivatives from an original Git revision, never from already compressed assets.
const revision = process.argv[2]
assert(revision, 'Usage: node scripts/optimize-assets.mjs <original-assets-git-revision> (requires cwebp)')
const original = name => execFileSync('git', ['show', `${revision}:public/tanks/${name}`], { maxBuffer: 16_000_000 })
const decodeHDR = bytes => new HDRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))

function smallHDR(bytes) {
  const source = decodeHDR(bytes), width = 512, height = 256
  const factor = source.width / width
  assert(Number.isInteger(factor) && source.height / height === factor)
  const linear = new Float32Array(width * height * 3)
  // Average radiance in linear space, weighted by spherical pixel area. No tone mapping or clipping.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let weight = 0
    const at = (y * width + x) * 3
    for (let dy = 0; dy < factor; dy++) {
      const sy = y * factor + dy, area = Math.sin((sy + 0.5) / source.height * Math.PI)
      for (let dx = 0; dx < factor; dx++) {
        const from = (sy * source.width + x * factor + dx) * 4
        for (let c = 0; c < 3; c++) linear[at + c] += source.data[from + c] * area
        weight += area
      }
    }
    for (let c = 0; c < 3; c++) linear[at + c] /= weight
  }
  const output = [...Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`)]
  const scan = new Uint8Array(width * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3
      const peak = Math.max(linear[at], linear[at + 1], linear[at + 2])
      const exponent = peak > 1e-32 ? Math.floor(Math.log2(peak)) + 1 : -128
      const scale = 256 / 2 ** exponent
      for (let c = 0; c < 3; c++) scan[c * width + x] = Math.min(255, Math.floor(linear[at + c] * scale))
      scan[width * 3 + x] = exponent + 128
    }
    output.push(2, 2, width >> 8, width & 255)
    for (let c = 0; c < 4; c++) {
      const channel = scan.subarray(c * width, (c + 1) * width)
      const runAt = start => { let end = start + 1; while (end < width && end - start < 127 && channel[end] === channel[start]) end++; return end - start }
      for (let x = 0; x < width;) {
        const run = runAt(x)
        if (run >= 4) { output.push(128 + run, channel[x]); x += run }
        else {
          const start = x++
          while (x < width && x - start < 128 && runAt(x) < 4) x++
          output.push(x - start, ...channel.subarray(start, x))
        }
      }
    }
  }
  const encoded = Buffer.from(output), decoded = decodeHDR(encoded)
  let error = 0, energy = 0, peak = 0
  for (let i = 0; i < linear.length; i++) {
    const value = decoded.data[Math.floor(i / 3) * 4 + i % 3]
    assert(Number.isFinite(value))
    error += Math.abs(value - linear[i]); energy += linear[i]; peak = Math.max(peak, value)
  }
  assert(peak > 1, 'Preserve HDR highlights above display white.')
  assert(error / energy < 0.01, 'RGBE round-trip radiance error must stay below 1%.')
  console.log(`HDR: ${bytes.length} → ${encoded.length} bytes; linear radiance error ${(error / energy * 100).toFixed(3)}%`)
  return encoded
}

const temporary = mkdtempSync(join(tmpdir(), 'salmon-assets-'))
try {
  const hdr = smallHDR(original('misty_pines_2k.hdr'))
  const images = [
    ['wood-planks-color.jpg', 'wood-planks-color.webp', ['-q', '88', '-resize', '512', '512']],
    ['wood-planks-normal.jpg', 'wood-planks-normal.webp', ['-q', '94', '-resize', '512', '512']],
    ['wood-planks-roughness.jpg', 'wood-planks-roughness.webp', ['-q', '90', '-resize', '512', '512']],
    ['opening.webp', 'opening.webp', ['-q', '82']],
  ]
  for (const [source, target, options] of images) {
    writeFileSync(join(temporary, source), original(source))
    execFileSync('cwebp', ['-quiet', '-m', '6', '-sharp_yuv', ...options, join(temporary, source), '-o', join(temporary, `optimized-${target}`)])
  }
  writeFileSync('public/tanks/misty-pines-512.hdr', hdr)
  for (const [source, target] of images) {
    copyFileSync(join(temporary, `optimized-${target}`), `public/tanks/${target}`)
    console.log(`${target}: ${readFileSync(`public/tanks/${target}`).length} bytes`)
    if (source !== target) rmSync(`public/tanks/${source}`, { force: true })
  }
  rmSync('public/tanks/misty_pines_2k.hdr', { force: true })
} finally { rmSync(temporary, { recursive: true, force: true }) }
