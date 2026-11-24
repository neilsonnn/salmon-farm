import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync('dist/index.html', 'utf8')
assert(html.includes('id="opening"'), 'The opening still must be present before JavaScript.')
assert(html.includes('id="loading"'), 'The loading bar must be present before JavaScript.')
assert(html.includes('tanks/opening.webp'), 'The opening still must be preloaded.')
assert(!/(?:src|href)="\/(?!\/)/.test(html), 'Use relative asset paths for embedded hosting.')
const textureBudgets = {
  'misty-pines-512.hdr': 500_000,
  'wood-planks-color.webp': 80_000,
  'wood-planks-normal.webp': 80_000,
  'wood-planks-roughness.webp': 80_000,
}
for (const name of ['opening.webp', ...Object.keys(textureBudgets), 'CREDITS.txt']) {
  assert(existsSync(`dist/tanks/${name}`), `Missing scene asset: ${name}`)
}
assert(statSync('dist/tanks/opening.webp').size < 300_000, 'Keep the opening still under 300 KB.')
for (const [name, budget] of Object.entries(textureBudgets)) {
  assert(statSync(`dist/tanks/${name}`).size < budget, `Scene texture exceeds its size budget: ${name}`)
  const link = html.match(/<link\b[^>]*>/g)?.find(tag => tag.includes(`tanks/${name}`))
  assert(link?.includes('rel="preload"') && link.includes('crossorigin="anonymous"'), `Preload the scene texture with matching CORS mode: ${name}`)
  assert(link.includes(`as="${name.endsWith('.hdr') ? 'fetch' : 'image'}"`), `Preload the correct resource type: ${name}`)
}
function totalBytes(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((bytes, item) => {
    const path = join(directory, item.name)
    return bytes + (item.isDirectory() ? totalBytes(path) : statSync(path).size)
  }, 0)
}
assert(totalBytes('dist') < 2_000_000, 'Keep the full production build under 2 MB.')
const assets = readdirSync('dist/assets')
assert(assets.some(name => /^physics\.worker-.*\.js$/.test(name)), 'The physics worker must be bundled.')
assert(!assets.some(name => /DevControls|dev-.*\.css/.test(name)), 'Development controls must not ship.')
for (const name of assets.filter(name => name.endsWith('.js'))) {
  const source = readFileSync(`dist/assets/${name}`, 'utf8')
  for (const text of ['Save opening still', 'Save thumbnail', 'Record preview', 'Technical details', 'A study of moving together', 'Return to Neilson']) {
    assert(!source.includes(text), `Development or obsolete UI leaked into ${name}: ${text}`)
  }
}
console.log('Verified early texture preloads, asset size budgets, initial still, relative paths, physics worker, and exclusion of development UI.')
