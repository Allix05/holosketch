// Pinch detection + debouncing, and a rough hand depth estimate for
// positioning the 3D hologram. Pure and camera-independent so it's unit
// testable. Landmark indices follow the standard MediaPipe Hand
// Landmarker layout (same convention used in the other hand-tracking
// projects in this portfolio).
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  PINKY_MCP: 17,
};

function dist2D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Distance between thumb and index fingertips, normalized by palm width
// (index_mcp to pinky_mcp) so the pinch threshold works regardless of how
// close or far the hand is from the camera.
export function pinchRatio(landmarks) {
  const palmWidth = dist2D(landmarks[LM.INDEX_MCP], landmarks[LM.PINKY_MCP]);
  if (palmWidth === 0) return Infinity;
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) / palmWidth;
}

export function isPinching(landmarks, threshold = 0.55) {
  return pinchRatio(landmarks) < threshold;
}

// The point to draw/grab at: the midpoint between thumb tip and index tip.
export function penPoint(landmarks) {
  const a = landmarks[LM.THUMB_TIP], b = landmarks[LM.INDEX_TIP];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
}

// Rough "how big does the hand look" measure -- palm width in normalized
// (0..1) coordinates. Hands look bigger when closer to the camera, so
// this doubles as a crude depth cue: bigger palmWidth == closer.
export function palmWidth(landmarks) {
  return dist2D(landmarks[LM.INDEX_MCP], landmarks[LM.PINKY_MCP]);
}

// Direction the hand is facing in-plane, as an angle in radians, derived
// from wrist -> middle-finger-base. Used to spin the held hologram a bit
// as you rotate your hand, for a "you're actually holding it" feel.
export function handRotation(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const mid = landmarks[LM.MIDDLE_MCP];
  return Math.atan2(mid.y - wrist.y, mid.x - wrist.x);
}

// Debounces a raw per-frame boolean (e.g. pinch state) so jitter near the
// threshold doesn't produce flickery grab/release toggling.
export class Debouncer {
  constructor(stableFrames = 3, initial = false) {
    this.stableFrames = stableFrames;
    this.current = initial;
    this.pending = initial;
    this.count = 0;
  }

  update(raw) {
    if (raw === this.pending) {
      this.count++;
    } else {
      this.pending = raw;
      this.count = 1;
    }
    if (this.count >= this.stableFrames) {
      this.current = this.pending;
    }
    return this.current;
  }
}
