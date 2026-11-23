import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Development-only scene export. Fixed destinations; no client-supplied paths.
function sceneCapture(): Plugin {
  return {
    name: 'local-scene-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (request, response, next) => {
        const video = request.url === '/video' && ['video/webm', 'video/mp4'].includes(request.headers['content-type'] ?? '')
        const output = request.url === '/opening' ? 'public/tanks/opening.webp'
          : request.url === '/thumbnail' ? 'media/thumbnail.webp'
          : video ? (request.headers['content-type'] === 'video/mp4' ? '.local/preview.mp4' : '.local/preview.webm') : null
        if (!output) { next(); return }
        const origin = request.headers.origin
        if (request.method !== 'POST' || (!video && request.headers['content-type'] !== 'image/webp')
          || !origin || new URL(origin).host !== request.headers.host) {
          response.statusCode = 403; response.end('Local scene export only.'); return
        }
        let length = 0
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 8_000_000) { response.statusCode = 413; response.end('Capture is too large.'); request.destroy(); return }
          chunks.push(chunk)
        })
        request.on('end', () => {
          if (response.writableEnded) return
          const image = Buffer.concat(chunks)
          if (!video && (image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP')) {
            response.statusCode = 400; response.end('Expected a WebP scene capture.'); return
          }
          const target = resolve(server.config.root, output)
          void mkdir(dirname(target), { recursive: true }).then(() => writeFile(target, image)).then(() => {
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({ path: output, bytes: image.length }))
          }).catch(() => { response.statusCode = 500; response.end('Scene capture could not be saved.') })
        })
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), sceneCapture()],
  server: { host: '127.0.0.1', fs: { strict: true, deny: ['**/.local/**', '**/.env*', '**/.git/**'] } },
  preview: { host: '127.0.0.1' },
  build: { sourcemap: false },
})
