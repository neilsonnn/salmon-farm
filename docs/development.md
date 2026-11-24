# Development

Use Node.js 22 or later. Run `npm ci`, then `npm run dev`. `npm run check` typechecks and runs the fish mechanics, schooling, geometry, optics, worker and opening-framing checks. `npm run build` creates the static app in `dist/` and checks its packaged assets. `npm run preview` serves that production build locally.

The production app fills the page with the scene. Drag, touch, or swipe with two fingers on a trackpad to orbit. Pinch or use a mouse wheel to zoom, and tap the water to disturb nearby fish. Space pauses, F feeds, and R restores the camera. Reduced-motion preferences start the scene paused. The only normal loading UI is the 2px bottom bar; a saved opening frame is present in the initial HTML and crossfades over 250ms after the first successful render. Simulation stays paused through this handoff.

Trackpad scrolling changes camera angles while preserving distance. Pinch works with ctrl-wheel events and Safari native gesture events, choosing one source when a browser emits both. Mouse wheel zoom and touchscreen gestures continue through OrbitControls. Wheel-device detection uses scroll units, notch/delta patterns and a short gesture lock because browsers do not expose a reliable physical device type. A high-resolution smooth mouse wheel can resemble a trackpad. Scroll filtering is independent of the render rate; reset, hidden tabs and disposal clear pending movement.

The small Debug disclosure exists only in development. It contains pause, feed, reset, murkiness, and local scene-export controls. Its module and stylesheet are excluded from production. Error diagnostics appear there only in development; production retains a concise error and Retry control if rendering fails.

The initial HTML preloads the HDR as a CORS fetch and all three wood maps as CORS images, matching Three.js loader requests. Downloads start while JavaScript loads and the procedural scene is constructed. The environment is a 512×256 RGBE HDR with its dynamic range preserved; wood maps are 512×512 WebP. The opening still retains its 2880×960 resolution. The build enforces a 2 MB runtime budget and individual texture budgets.

To regenerate these derivatives from the original assets, install `cwebp` and run `node scripts/optimize-assets.mjs 7b9b8d2`. The script reads the original files from Git, filters the environment in linear radiance with spherical area weights, checks the RGBE round-trip error, and encodes the images. It always uses original inputs to avoid cumulative recompression.

To regenerate the opening, run the development server and open `/?opening`. This keeps the initial physical pose frozen. Expand Debug and use Save opening still. The scene renders its own 2880×960 frame directly to `public/tanks/opening.webp`; the export has no HTML overlays. Save thumbnail renders a separate 1200×675 frame to `media/thumbnail.webp`. A development-only local endpoint accepts fixed capture destinations. The opening camera and CSS cover scaling share the same crop through portrait, landscape and ultrawide layouts.

Recompress a newly captured opening still with `cwebp` at quality 82 before building so it meets the opening image budget.

Record preview exports 4.5 seconds of the live canvas at 1200×675 to ignored `.local/preview.mp4` or `.local/preview.webm`, depending on browser support. It captures the scene without HTML controls or audio; convert to H.264 for publishing.

The README intentionally contains only the app thumbnail. Asset authors and CC0 source links are in `public/tanks/CREDITS.txt`. The coupled fish model and its limits are documented in [foids.md](foids.md). Original user attachments are held under ignored `.local/inputs/` while publication is pending.
