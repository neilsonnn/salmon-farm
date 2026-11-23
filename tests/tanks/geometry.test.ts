import { describe, expect, it } from 'vitest'
import { BufferGeometry, InstancedMesh, Mesh, type Material } from 'three'
import { createFishGeometry, createFishMesh, FISH_POSE_TEXELS } from '../../src/tanks/fish'
import { FishSchool } from '../../src/tanks/simulation'
import { createDocks } from '../../src/tanks/docks'

describe('Procedural Tanks geometry', () => {
  it('builds a complete fish with finite positions, normals, colors, and forked tail extent', () => {
    const geometry = createFishGeometry()
    const position = geometry.getAttribute('position')
    expect(position.count).toBeGreaterThan(2000)
    for (const name of ['position', 'normal', 'color']) {
      const attribute = geometry.getAttribute(name)
      expect(attribute.count).toBe(position.count)
      expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true)
    }
    const fins = geometry.getAttribute('finRole')
    expect(fins.count).toBe(position.count)
    expect(Array.from(fins.array).filter(value => value === 1)).toHaveLength(6)
    expect(Array.from(fins.array).filter(value => value === -1)).toHaveLength(6)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.x).toBeLessThan(-0.7)
    expect(geometry.boundingBox!.max.x).toBeGreaterThan(0.48)
    expect(geometry.boundingBox!.max.y).toBeGreaterThan(0.17)
    geometry.dispose()
  })

  it('uploads exact body and fin poses through a texture with vertex-input headroom', () => {
    const school = new FishSchool(), { mesh, poseTexture, updatePose } = createFishMesh(school)
    const geometryLocations = Object.values(mesh.geometry.attributes).reduce((sum, attribute) => sum + Math.ceil(attribute.itemSize / 4), 0)
    const instanceLocations = 4 + (mesh.instanceColor ? 1 : 0)
    // Reserve room for implicit renderer inputs; counting just our geometry at
    // exactly 16 did not protect the actual browser shader from link failure.
    expect(geometryLocations + instanceLocations).toBeLessThanOrEqual(10)
    expect(mesh.geometry.hasAttribute('finPose')).toBe(false)
    expect(mesh.geometry.hasAttribute('spineA')).toBe(false)
    expect(poseTexture.image.width).toBe(FISH_POSE_TEXELS)
    expect(poseTexture.image.height).toBe(school.count)
    school.step(1 / 60)
    updatePose()
    const data = poseTexture.image.data
    for (const i of [0, 143, school.count - 1]) {
      let at = i * FISH_POSE_TEXELS * 4
      for (const packed of school.spines.packed) {
        for (let k = 0; k < 4; k++) expect(data[at++]).toBe(packed[i * 4 + k])
      }
      for (let k = 0; k < 4; k++) expect(data[at++]).toBe(school.spines.fins[i * 4 + k])
    }
    const shader = { vertexShader: '#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '', uniforms: {} }
    mesh.material.onBeforeCompile(shader as never, {} as never)
    expect((shader.uniforms as Record<string, { value: unknown }>).uFoidPose.value).toBe(poseTexture)
    expect(mesh.count).toBe(school.count)
    poseTexture.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose()
  })

  it('preserves individual floating assemblies while batching their fixed fittings', () => {
    const { group, docks } = createDocks({ map: null, normalMap: null, roughnessMap: null })
    expect(docks).toHaveLength(32)
    const geometries = new Set<BufferGeometry>(), materials = new Set<Material>()
    for (const dock of docks) {
      expect(dock.group.parent).toBe(group)
      // Boards and their UV ranges remain instanced; fixed details share merged meshes.
      expect(dock.group.children.some(child => child instanceof InstancedMesh)).toBe(true)
      expect(dock.group.children.length).toBeLessThan(13)
    }
    group.traverse(object => {
      if (!(object instanceof Mesh)) return
      geometries.add(object.geometry)
      ;(Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material))
      for (const value of object.geometry.getAttribute('position').array) {
        if (!Number.isFinite(value)) throw new Error('A dock contains nonfinite geometry')
      }
    })
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
  })
})
