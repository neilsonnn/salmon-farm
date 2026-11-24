import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

const html = readFileSync('dist/index.html', 'utf8')
assert(html.includes('id="opening"'), 'The opening still must be present before JavaScript.')
assert(html.includes('id="loading"'), 'The loading bar must be present before JavaScript.')
assert(html.includes('tanks/opening.webp'), 'The opening still must be preloaded.')
assert(!/(?:src|href)="\/(?!\/)/.test(html), 'Use relative asset paths for embedded hosting.')
for (const name of ['opening.webp', 'misty_pines_2k.hdr', 'wood-planks-color.jpg', 'wood-planks-normal.jpg', 'wood-planks-roughness.jpg', 'CREDITS.txt']) {
  assert(existsSync(`dist/tanks/${name}`), `Missing scene asset: ${name}`)
}
assert(statSync('dist/tanks/opening.webp').size < 1_000_000, 'Keep the opening still under 1 MB.')
const assets = readdirSync('dist/assets')
assert(assets.some(name => /^physics\.worker-.*\.js$/.test(name)), 'The physics worker must be bundled.')
assert(!assets.some(name => /DevControls|dev-.*\.css/.test(name)), 'Development controls must not ship.')
for (const name of assets.filter(name => name.endsWith('.js'))) {
  const source = readFileSync(`dist/assets/${name}`, 'utf8')
  for (const text of ['Save opening still', 'Save thumbnail', 'Record preview', 'Technical details', 'A study of moving together', 'Return to Neilson']) {
    assert(!source.includes(text), `Development or obsolete UI leaked into ${name}: ${text}`)
  }
}
console.log('Verified initial still and loading bar, relative paths, scene assets, physics worker, and exclusion of development UI.')
