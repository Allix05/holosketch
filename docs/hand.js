// Pinch detection + debouncing, and a rough hand depth estimate for
// positioning the 3D hologram. Pure and camera-independent so it's unit
// testable. Landmark indices follow the standard MediaPipe Hand
// Landmarker layout (same convention used in the other hand-tracking
// projects in this portfolio).
export const LM = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
};

function dist2D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// The angle (radians) at `joint`, between the ray toward `before` and the
// ray toward `after` -- e.g. angleAtJoint(wrist, mcp, tip) is the bend at
// the knuckle. A straight line (before -> joint -> after keeps going the
// same direction) gives an angle near PI; a sharp fold gives an angle
// near 0. Deliberately 2D (x/y only): this is what makes it robust to
// the hand's rotation *in the image plane* -- rotating the whole hand
// around the camera axis doesn't change the angle at all, so a bent
// knuckle reads as bent and a straight one reads as straight no matter
// which way the hand is turned toward the camera. MediaPipe's z estimate
// is comparatively noisy, so leaving it out of this check also avoids
// dragging in extra jitter.
function angleAtJoint(before, joint, after) {
  const v1 = { x: before.x - joint.x, y: before.y - joint.y };
  const v2 = { x: after.x - joint.x, y: after.y - joint.y };
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return Math.PI;
  const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2)));
  return Math.acos(cos);
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

// The point to draw at: the midpoint between thumb tip and index tip
// (the sketching pinch).
export function penPoint(landmarks) {
  const a = landmarks[LM.THUMB_TIP], b = landmarks[LM.INDEX_TIP];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
}

// The point to anchor a held object at: the midpoint between thumb tip
// and middle-finger tip -- a natural grip for a small floating object,
// distinct from the thumb+index pinch used for sketching.
export function holdPoint(landmarks) {
  const a = landmarks[LM.THUMB_TIP], b = landmarks[LM.MIDDLE_TIP];
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

// Angle of the line between the index and pinky knuckles. When the hand
// is held upright (fingers toward the ceiling) and you twist your wrist
// -- rotating the forearm, not tilting the hand -- this line visibly
// sweeps around, making it a much better "spin the hologram" control
// than handRotation, which tracks hand tilt instead.
export function wristTwistAngle(landmarks) {
  const a = landmarks[LM.INDEX_MCP];
  const b = landmarks[LM.PINKY_MCP];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// Distance from the wrist to the middle-finger knuckle: a depth cue like
// palmWidth (bigger == closer), but measured along the forearm's own
// axis instead of across it. Twisting the wrist rotates around that
// axis, so unlike palmWidth (which foreshortens as the knuckle line
// turns edge-on), this stays roughly stable during a pure twist -- so
// distance/scale doesn't get dragged around by rotation.
export function handLength(landmarks) {
  return dist2D(landmarks[LM.WRIST], landmarks[LM.MIDDLE_MCP]);
}

// A finger is "extended" when it continues in roughly a straight line
// from the wrist through its own knuckle to its tip -- i.e. the angle at
// the knuckle is close to a straight line (near PI radians / 180deg).
// Curling the finger folds that angle down sharply regardless of the
// hand's rotation in the image, which is what makes this robust across
// orientations (including palm-to-camera) in a way a raw wrist-to-tip
// distance isn't: a distance-ratio check depends on the hand's absolute
// size/position doing the "right" thing in whatever direction it happens
// to be facing, where an angle only cares about the knuckle's own shape.
function isFingerExtended(landmarks, mcpIdx, tipIdx, minAngleDeg) {
  const angleDeg = (angleAtJoint(landmarks[LM.WRIST], landmarks[mcpIdx], landmarks[tipIdx]) * 180) / Math.PI;
  return angleDeg >= minAngleDeg;
}

// Detects the "raise your pinky" gesture: just the pinky extended.
export function isPinkyUp(landmarks, minAngleDeg = 150) {
  return isFingerExtended(landmarks, LM.PINKY_MCP, LM.PINKY_TIP, minAngleDeg);
}

// Detects an extended thumb (out to the side, away from the palm).
export function isThumbUp(landmarks, minAngleDeg = 140) {
  return isFingerExtended(landmarks, LM.THUMB_MCP, LM.THUMB_TIP, minAngleDeg);
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
