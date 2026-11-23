import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { OPENING_ASPECT, OPENING_FOV, openingFieldOfView } from '../../src/tanks/opening'

describe('Opening still framing', () => {
  it('matches a centered CSS cover crop through portrait, landscape, and ultrawide views', () => {
    const imageWidth = 2880, imageHeight = imageWidth / OPENING_ASPECT
    const captureCamera = new PerspectiveCamera(OPENING_FOV, OPENING_ASPECT, 0.1, 150)
    for (const [width, height] of [[390, 844], [1024, 768], [1920, 1080], [2880, 960], [3840, 960]]) {
      const liveCamera = new PerspectiveCamera(openingFieldOfView(width / height), width / height, 0.1, 150)
      const coverScale = Math.max(width / imageWidth, height / imageHeight)
      for (const point of [new Vector3(-0.5, 0.35, -4), new Vector3(1, -1, -5), new Vector3(0, 0, -2)]) {
        const still = point.clone().project(captureCamera), live = point.clone().project(liveCamera)
        const imageX = still.x * imageWidth / 2 * coverScale + width / 2
        const imageY = -still.y * imageHeight / 2 * coverScale + height / 2
        expect((live.x + 1) * width / 2).toBeCloseTo(imageX, 8)
        expect((1 - live.y) * height / 2).toBeCloseTo(imageY, 8)
      }
    }
  })
})
