export const OPENING_ASPECT = 3
export const OPENING_FOV = 40
export const OPENING_FADE_MS = 250

// The 3:1 still and live camera share their vertical field of view. Beyond
// that ratio both crop vertically, matching the still's CSS cover behavior.
export function openingFieldOfView(aspect: number) {
  return 2 * Math.atan(Math.tan(OPENING_FOV * Math.PI / 360) * Math.min(1, OPENING_ASPECT / aspect)) * 180 / Math.PI
}

export function resetOpening() {
  for (const id of ['opening', 'loading']) {
    const element = document.getElementById(id)
    if (!element) continue
    element.hidden = false
    element.classList.remove('is-gone', 'is-done')
  }
}

export function hideOpening() {
  for (const id of ['opening', 'loading']) {
    const element = document.getElementById(id)
    if (element) element.hidden = true
  }
}

/** Release the simulation only after its actual first frame replaces the still. */
export function revealOpening(onComplete: () => void) {
  const opening = document.getElementById('opening')
  const loading = document.getElementById('loading')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  loading?.classList.add('is-done')
  const begin = window.setTimeout(() => {
    opening?.classList.add('is-gone')
    loading?.classList.add('is-gone')
  }, reduced ? 0 : 100)
  const finish = window.setTimeout(() => {
    hideOpening()
    onComplete()
  }, reduced ? 0 : 100 + OPENING_FADE_MS)
  return () => { window.clearTimeout(begin); window.clearTimeout(finish) }
}
