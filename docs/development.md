# Development

Use Node.js 22 or later. Run `npm ci`, then `npm run dev`. `npm run check` typechecks and runs the fish mechanics, schooling, geometry, optics, worker and opening-framing checks. `npm run build` creates the static app in `dist/` and checks its packaged assets. `npm run preview` serves that production build locally.

The production app fills the page with the scene. Drag or touch to orbit, scroll or pinch to zoom, and tap the water to disturb nearby fish. Space pauses, F feeds, and R restores the camera. Reduced-motion preferences start the scene paused. The only normal loading UI is the 2px bottom bar; a saved opening frame is present in the initial HTML and crossfades over 250ms after the first successful render. Simulation stays paused through this handoff.

The small Debug disclosure exists only in development. It contains pause, feed, reset, murkiness, and local scene-export controls. Its module and stylesheet are excluded from production. Error diagnostics appear there only in development; production retains a concise error and Retry control if rendering fails.

To regenerate the opening, run the development server and open `/?opening`. This keeps the initial physical pose frozen. Expand Debug and use Save opening still. The scene renders its own 2880×960 frame directly to `public/tanks/opening.webp`; the export has no HTML overlays. Save thumbnail renders a separate 1200×675 frame to `media/thumbnail.webp`. A development-only local endpoint accepts fixed capture destinations. The opening camera and CSS cover scaling share the same crop through portrait, landscape and ultrawide layouts.

Record preview exports 4.5 seconds of the live canvas at 1200×675 to ignored `.local/preview.mp4` or `.local/preview.webm`, depending on browser support. It captures the scene without HTML controls or audio; convert to H.264 for publishing.

The README intentionally contains only the app thumbnail. Asset authors and CC0 source links are in `public/tanks/CREDITS.txt`. The coupled fish model and its limits are documented in [foids.md](foids.md). Original user attachments are held under ignored `.local/inputs/` while publication is pending.
