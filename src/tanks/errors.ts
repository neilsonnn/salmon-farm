export type TanksErrorKind = 'context-unavailable' | 'context-lost' | 'shader' | 'loading' | 'render' | 'simulation'

export class TanksSceneError extends Error {
  constructor(readonly kind: TanksErrorKind, message: string, readonly details = message) {
    super(message)
    this.name = 'TanksSceneError'
  }
}

export function toTanksSceneError(reason: unknown, kind: TanksErrorKind = 'loading') {
  if (reason instanceof TanksSceneError) return reason
  const details = reason instanceof Error ? reason.message : String(reason ?? 'Unknown scene error')
  return new TanksSceneError(kind, details)
}

export function sceneErrorMessage(error: TanksSceneError) {
  switch (error.kind) {
    case 'context-unavailable': return 'The browser could not start the scene’s graphics context. Please try opening it again.'
    case 'context-lost': return 'The graphics connection was interrupted. Please try opening the scene again.'
    case 'shader': return 'A rendering error prevented the scene from opening. Please try opening it again.'
    case 'simulation': return 'The fish simulation was interrupted. Please try opening it again.'
    default: return 'The scene could not finish loading. Please try opening it again.'
  }
}

type ShaderDiagnostics = Pick<WebGLRenderingContext, 'getProgramInfoLog' | 'getShaderInfoLog' | 'getShaderSource'>

/** Preserve the driver diagnostics; assigning onShaderError disables Three's default reporting. */
export function shaderCompilationError(gl: ShaderDiagnostics, program: WebGLProgram, vertex: WebGLShader, fragment: WebGLShader) {
  const source = gl.getShaderSource(vertex) ?? ''
  const name = source.match(/^#define SHADER_NAME[ \t]+([^\r\n]*)/m)?.[1].trim()
    || source.match(/^#define SHADER_TYPE[ \t]+([^\r\n]*)/m)?.[1].trim() || 'Scene material'
  const logs = [
    ['Program', gl.getProgramInfoLog(program)],
    ['Vertex shader', gl.getShaderInfoLog(vertex)],
    ['Fragment shader', gl.getShaderInfoLog(fragment)],
  ].filter(([, log]) => log?.trim()).map(([stage, log]) => `${stage}:\n${log!.trim()}`)
  return new TanksSceneError('shader', `The ${name} shader could not compile or link.`,
    [`Material: ${name}`, ...logs].join('\n\n'))
}
