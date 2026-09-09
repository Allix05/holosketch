# Holosketch

[![CI](https://github.com/Allix05/holosketch/actions/workflows/ci.yml/badge.svg)](https://github.com/Allix05/holosketch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Pinch your thumb and index finger together to sketch a shape in thin air over your webcam feed. Hit **Extrude** and it becomes a real 3D hologram — pinch it again to pick it up, move your hand to carry it around, and turn your wrist to spin it. Iron Man's holotable, in a browser tab.

**[Try it live](https://allix05.github.io/holosketch/)** — 100% client-side: hand tracking and 3D rendering both run locally. Your camera feed never leaves your device.

<!-- SCREENSHOT_PLACEHOLDER -->

## How it works

```
Webcam ──▶ MediaPipe Hand Landmarker ──▶ 21 landmarks
                                              │
                                              ▼
                                  pinch detection (hand.js)
                                              │
                          pinching ──▶ trace stroke on invisible plane
                                              │
                                    (you click "Extrude")
                                              ▼
                     simplify (Ramer-Douglas-Peucker) → close → normalize
                                       (path.js)
                                              │
                                              ▼
                       THREE.Shape → ExtrudeGeometry (beveled solid)
                                  + wireframe edge overlay
                                              │
                                              ▼
                     rendered transparent over the camera feed (Three.js)
                                              │
                            pinch near it ──▶ grab: hand (x, y, z) + wrist
                                               rotation drive position/spin
```

1. **[`hand.js`](docs/hand.js)** — tracks the pinch gesture (thumb tip to index tip, normalized by palm width) via MediaPipe's Hand Landmarker, debounced against jitter. Also derives a rough depth cue (palm width — bigger looks closer) and an in-plane wrist rotation angle, both used later for holding/spinning the hologram.
2. **Draw mode** (`app.js`) — while pinching, the midpoint between thumb and index fingertips traces a stroke onto a 2D canvas layered over the video.
3. **[`path.js`](docs/path.js)** — pure geometry: Ramer-Douglas-Peucker simplification cleans up the noisy hand-drawn stroke, `closePath` auto-closes it into a polygon, and `normalizePath` centers/scales/flips it into a consistent shape ready for extrusion.
4. **Extrude** — the cleaned 2D polygon becomes a `THREE.Shape`, run through `ExtrudeGeometry` with bevels for a genuine solid, rendered as a translucent fill plus a glowing wireframe edge overlay — a real 3D object, not a flat sprite.
5. **Holo mode** — pinching near the hologram grabs it. While held, your hand's screen position maps to a 3D world position in front of the camera (via FOV-based screen-to-world projection), palm-width changes nudge it nearer/farther, and wrist rotation spins it. Release and it floats gently in place.

## Try it locally

```bash
python -m http.server 8092 --directory docs
# open http://localhost:8092
```

Needs camera access and a browser with WebGL. Nothing is uploaded — hand tracking (MediaPipe WASM) and rendering (Three.js/WebGL) both run entirely on-device.

### Run the tests

The pinch/depth/rotation math and the path-simplification pipeline are pure functions, unit-tested with Node's built-in test runner — no camera needed:

```bash
node --test
```

## Project structure

```
docs/                fully static GitHub Pages app
  hand.js               pinch detection, debouncing, depth/rotation cues (pure)
  path.js               stroke simplify/close/normalize -> extrudable polygon (pure)
  app.js                camera capture, drawing, Three.js hologram, hand-tracking glue
  index.html            HUD layout
  style.css             JARVIS-style dark HUD theme
  tests/                node:test unit tests
```

## Why these design choices

- **Pure geometry modules** (`hand.js`, `path.js`) — all the interesting math has zero DOM/Three.js/camera dependencies, so it's fully unit-testable without a browser or camera.
- **Screen-to-world FOV projection** — rather than faking depth, the hologram's 3D position is computed from the camera's actual field of view, so it visually tracks your hand's screen position at whatever depth it's currently held at.
- **Wireframe + translucent fill** — a beveled solid alone looks like a plain 3D shape; the glowing edge overlay on top of a low-opacity fill is what sells the "hologram" look.

## License

MIT — see [LICENSE](LICENSE).
