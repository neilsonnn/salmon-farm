import { describe, expect, it } from 'vitest'
import { sceneErrorMessage, shaderCompilationError, TanksSceneError, toTanksSceneError } from '../../src/tanks/errors'

describe('Tanks error diagnostics', () => {
  it('keeps a shader failure distinct from unavailable graphics through render handling', () => {
    const failure = new TanksSceneError('shader', 'WebGL shader compilation failed', 'Vertex shader: undeclared identifier')
    const propagated = toTanksSceneError(failure, 'render')
    expect(propagated).toBe(failure)
    expect(sceneErrorMessage(propagated)).toContain('rendering error')
    expect(sceneErrorMessage(propagated)).not.toContain('graphics-enabled browser')
  })

  it('does not infer missing WebGL support from words in an unrelated error', () => {
    const failure = toTanksSceneError(new Error('Could not load the 3D graphics module'))
    expect(failure.kind).toBe('loading')
    expect(sceneErrorMessage(failure)).toContain('finish loading')
    expect(failure.details).toBe('Could not load the 3D graphics module')
  })

  it('retains material, program, vertex and fragment compiler diagnostics', () => {
    const vertex = {} as WebGLShader, fragment = {} as WebGLShader
    const gl = {
      getProgramInfoLog: () => 'Program link failed',
      getShaderSource: () => '#version 300 es\n#define SHADER_NAME TanksFish\nvoid main() {}',
      getShaderInfoLog: (shader: WebGLShader) => shader === vertex ? 'ERROR: 0:42: unknown identifier' : 'ERROR: 0:17: type mismatch',
    }
    const failure = shaderCompilationError(gl, {} as WebGLProgram, vertex, fragment)
    expect(failure.kind).toBe('shader')
    expect(failure.details).toContain('Material: TanksFish')
    expect(failure.details).toContain('Program link failed')
    expect(failure.details).toContain('Vertex shader:\nERROR: 0:42')
    expect(failure.details).toContain('Fragment shader:\nERROR: 0:17')
  })

  it('only reports context startup failure when it has that explicit category', () => {
    const failure = toTanksSceneError(new Error('Error creating WebGL context'), 'context-unavailable')
    expect(sceneErrorMessage(failure)).toContain('could not start')
    expect(sceneErrorMessage(failure)).not.toContain('browser is needed')
  })
})
