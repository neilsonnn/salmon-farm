import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

const port = Number(process.argv[2] || 5177)
const origin = `http://127.0.0.1:${port}`
const root = resolve('dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain' }

// Injected only by this local test server; never included in the production ZIP.
function observe(mode) {
  const workers = [], errors = [], bundleFetches = []
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options)
      const entry = { scheme: String(url).split(':')[0], ready: false, updates: 0, bytes: 0 }
      workers.push(entry)
      this.addEventListener('message', event => {
        if (event.data.type === 'ready') entry.ready = true
        if (event.data.type === 'state') { entry.updates++; entry.bytes = event.data.buffer.byteLength }
        if (event.data.type === 'error') errors.push(event.data.message)
      })
      this.addEventListener('error', event => errors.push(event.message || 'Worker error'))
    }
  }
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input, options) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('physics.worker-')) bundleFetches.push(url)
    return nativeFetch(input, options)
  }
  window.addEventListener('error', event => errors.push(event.message))
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
  let started = 0, frames = 0, resumed = false
  const tick = now => {
    if (!document.querySelector('[role="alert"]') && document.querySelector('.tanks-page[aria-busy="false"]')) {
      if (!started) started = now
      frames++
      if (!resumed && matchMedia('(prefers-reduced-motion: reduce)').matches) {
        resumed = true
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  setInterval(() => {
    const alert = document.querySelector('[role="alert"]')?.textContent || ''
    const running = !alert && !!document.querySelector('.tanks-page[aria-busy="false"]')
    const fps = started ? Math.round(frames * 1000 / Math.max(1, performance.now() - started)) : 0
    const passed = mode === 'blocked' ? !!alert && !running
      : running && workers.length === 2 && workers.every(worker => worker.scheme === 'blob' && worker.ready && worker.updates >= 3) && bundleFetches.length === 1 && errors.length === 0
    parent.postMessage({ type: 'salmon-farm-compatibility', mode, passed, running, workers, bundleFetches, fps, errors, alert }, '*')
  }, 500)
}

const harness = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Salmon Farm compatibility</title>
<style>body{margin:0;background:#18221d;color:#e6e8d7;font:13px/1.4 ui-monospace,monospace}header{padding:12px 16px}button{font:inherit;margin:0 10px 8px 0;padding:7px 12px}iframe{display:block;width:100%;height:65vh;border:0}pre{padding:12px 16px;white-space:pre-wrap;margin:0}#result{font-weight:bold}</style>
<header><button data-mode="normal">Normal production</button><button data-mode="sandbox">Toyware sandbox</button><button data-mode="blocked">Blocked-policy control</button><span id="result">Loading</span></header>
<iframe id="scene" title="Salmon Farm test scene"></iframe><pre id="details"></pre>
<script>
const frame=document.getElementById('scene'), result=document.getElementById('result'), details=document.getElementById('details');let mode='sandbox';
function load(next){mode=next;result.textContent='Loading '+mode;result.dataset.passed='false';details.textContent='';if(mode==='normal')frame.removeAttribute('sandbox');else frame.setAttribute('sandbox','allow-scripts');frame.src='/__player/'+mode+'/release/index.html';}
document.querySelectorAll('button').forEach(button=>button.onclick=()=>load(button.dataset.mode));
addEventListener('message',event=>{const data=event.data;if(event.source!==frame.contentWindow||data?.type!=='salmon-farm-compatibility'||data.mode!==mode)return;result.textContent=(data.passed?'PASS: ':'Checking: ')+mode;result.dataset.passed=String(data.passed);details.textContent=JSON.stringify(data,null,2);});load(mode);
</script></html>`

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', origin)
    if (url.pathname === '/__compatibility' || url.pathname === '/__compatibility/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(harness); return
    }
    const match = url.pathname.match(/^\/__player\/(normal|sandbox|blocked)\/release\/(.*)$/)
    const mode = match?.[1]
    const relative = decodeURIComponent(match ? match[2] : url.pathname.slice(1)) || 'index.html'
    const file = resolve(root, relative)
    if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return }
    if (!(await stat(file)).isFile()) { response.writeHead(404); response.end(); return }
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    if (mode && mode !== 'normal') {
      response.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src ${origin} 'unsafe-inline' 'wasm-unsafe-eval'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; media-src ${origin} data: blob:; font-src ${origin} data:; connect-src ${origin}; worker-src ${mode === 'blocked' ? "'none'" : 'blob:'}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`)
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    }
    let body = await readFile(file)
    if (mode && relative === 'index.html') {
      const probe = `<script>(${observe.toString()})(${JSON.stringify(mode)})</script>`
      body = Buffer.from(body.toString().replace('<head>', '<head>' + probe))
    }
    response.end(body)
  } catch (error) {
    response.statusCode = error.code === 'ENOENT' ? 404 : 500
    response.end('Not found')
  }
})
server.listen(port, '127.0.0.1', () => console.log(`Production: ${origin}/\nWorker compatibility: ${origin}/__compatibility/`))
