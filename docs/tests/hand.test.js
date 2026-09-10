import { test } from "node:test";
import assert from "node:assert/strict";
import { pinchRatio, isPinching, penPoint, holdPoint, palmWidth, handRotation, isPinkyUp, isThumbUp, wristTwistAngle, gripWidth, Debouncer, LM } from "../hand.js";

function baseLandmarks() {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

test("pinched fingers (thumb tip == index tip) give ratio 0", () => {
  const lm = baseLandmarks();
  lm[LM.INDEX_MCP] = { x: 0.4, y: 0.5, z: 0 };
  lm[LM.PINKY_MCP] = { x: 0.6, y: 0.5, z: 0 };
  lm[LM.THUMB_TIP] = { x: 0.5, y: 0.5, z: 0 };
  lm[LM.INDEX_TIP] = { x: 0.5, y: 0.5, z: 0 };
  assert.equal(pinchRatio(lm), 0);
  assert.equal(isPinching(lm), true);
});

test("spread-apart fingers are not a pinch", () => {
  const lm = baseLandmarks();
  lm[LM.INDEX_MCP] = { x: 0.4, y: 0.5, z: 0 };
  lm[LM.PINKY_MCP] = { x: 0.6, y: 0.5, z: 0 };
  lm[LM.THUMB_TIP] = { x: 0.0, y: 0.5, z: 0 };
  lm[LM.INDEX_TIP] = { x: 1.0, y: 0.5, z: 0 };
  assert.equal(isPinching(lm), false);
});

test("penPoint is the midpoint of thumb and index tips (including z)", () => {
  const lm = baseLandmarks();
  lm[LM.THUMB_TIP] = { x: 0.2, y: 0.4, z: 0.1 };
  lm[LM.INDEX_TIP] = { x: 0.6, y: 0.8, z: 0.3 };
  const p = penPoint(lm);
  assert.ok(Math.abs(p.x - 0.4) < 1e-9);
  assert.ok(Math.abs(p.y - 0.6) < 1e-9);
  assert.ok(Math.abs(p.z - 0.2) < 1e-9);
});

test("holdPoint is the midpoint of the thumb and middle fingertips", () => {
  const lm = baseLandmarks();
  lm[LM.THUMB_TIP] = { x: 0.2, y: 0.6, z: 0.05 };
  lm[LM.MIDDLE_TIP] = { x: 0.6, y: 0.2, z: 0.15 };
  const p = holdPoint(lm);
  assert.ok(Math.abs(p.x - 0.4) < 1e-9);
  assert.ok(Math.abs(p.y - 0.4) < 1e-9);
  assert.ok(Math.abs(p.z - 0.1) < 1e-9);
});

test("palmWidth measures the index-to-pinky base distance", () => {
  const lm = baseLandmarks();
  lm[LM.INDEX_MCP] = { x: 0.4, y: 0.5, z: 0 };
  lm[LM.PINKY_MCP] = { x: 0.7, y: 0.5, z: 0 };
  assert.ok(Math.abs(palmWidth(lm) - 0.3) < 1e-9);
});

test("handRotation points from wrist toward the middle finger base", () => {
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0, z: 0 };
  lm[LM.MIDDLE_MCP] = { x: 1, y: 0, z: 0 };
  assert.ok(Math.abs(handRotation(lm) - 0) < 1e-9);

  lm[LM.MIDDLE_MCP] = { x: 0, y: 1, z: 0 };
  assert.ok(Math.abs(handRotation(lm) - Math.PI / 2) < 1e-9);
});

test("Debouncer requires consecutive stable frames before flipping", () => {
  const d = new Debouncer(3, false);
  assert.equal(d.update(true), false);
  assert.equal(d.update(true), false);
  assert.equal(d.update(true), true);
});

test("Debouncer resets the streak on interruption", () => {
  const d = new Debouncer(3, false);
  d.update(true);
  d.update(true);
  d.update(false);
  assert.equal(d.update(true), false);
});

test("a curled pinky (tip near the wrist) is not raised", () => {
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0, z: 0 };
  lm[LM.PINKY_MCP] = { x: 0, y: 0.3, z: 0 };
  lm[LM.PINKY_TIP] = { x: 0.05, y: 0.32, z: 0 };
  assert.equal(isPinkyUp(lm), false);
});

test("a straightened pinky (tip far past the MCP) is raised", () => {
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0, z: 0 };
  lm[LM.PINKY_MCP] = { x: 0, y: 0.3, z: 0 };
  lm[LM.PINKY_TIP] = { x: 0, y: 0.9, z: 0 };
  assert.equal(isPinkyUp(lm), true);
});

test("isPinkyUp is invariant to the hand's rotation in the image (only the knuckle bend matters)", () => {
  // The same straight-pinky shape as above, rotated 90 degrees about the
  // wrist. A true rotation preserves the angle at the knuckle, so this
  // should still read as raised no matter which way the hand is turned
  // toward the camera -- including palm-to-camera orientations.
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0, z: 0 };
  lm[LM.PINKY_MCP] = { x: -0.3, y: 0, z: 0 };
  lm[LM.PINKY_TIP] = { x: -0.9, y: 0, z: 0 };
  assert.equal(isPinkyUp(lm), true);
});

test("wristTwistAngle points from the index knuckle toward the pinky knuckle", () => {
  const lm = baseLandmarks();
  lm[LM.INDEX_MCP] = { x: 0, y: 0, z: 0 };
  lm[LM.PINKY_MCP] = { x: 1, y: 0, z: 0 };
  assert.ok(Math.abs(wristTwistAngle(lm) - 0) < 1e-9);

  lm[LM.PINKY_MCP] = { x: 0, y: 1, z: 0 };
  assert.ok(Math.abs(wristTwistAngle(lm) - Math.PI / 2) < 1e-9);
});

test("gripWidth measures the live distance between the thumb and middle fingertips", () => {
  const lm = baseLandmarks();
  lm[LM.THUMB_TIP] = { x: 0, y: 0, z: 0 };
  lm[LM.MIDDLE_TIP] = { x: 0.3, y: 0.4, z: 0 };
  assert.ok(Math.abs(gripWidth(lm) - 0.5) < 1e-9);

  // Squeezing the fingers together shrinks it.
  lm[LM.MIDDLE_TIP] = { x: 0.06, y: 0.08, z: 0 };
  assert.ok(Math.abs(gripWidth(lm) - 0.1) < 1e-9);
});

test("a curled thumb (tip near its own base) is not raised", () => {
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0.3, z: 0 };
  lm[LM.THUMB_MCP] = { x: 0, y: 0, z: 0 };
  lm[LM.THUMB_TIP] = { x: 0.05, y: 0.02, z: 0 };
  assert.equal(isThumbUp(lm), false);
});

test("a straightened thumb (tip pushed well past its base) is raised", () => {
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: 0, y: 0.3, z: 0 };
  lm[LM.THUMB_MCP] = { x: 0.05, y: 0.28, z: 0 };
  lm[LM.THUMB_TIP] = { x: 0.35, y: 0.1, z: 0 };
  assert.equal(isThumbUp(lm), true);
});

test("isThumbUp is invariant to the hand's rotation in the image (only the knuckle bend matters)", () => {
  // The same straight-thumb shape as above, rotated 90 degrees about the
  // origin ((x, y) -> (-y, x)). A true rotation preserves the angle at
  // the knuckle, so this should still read as raised no matter which way
  // the hand is turned toward the camera -- including palm-to-camera.
  const lm = baseLandmarks();
  lm[LM.WRIST] = { x: -0.3, y: 0, z: 0 };
  lm[LM.THUMB_MCP] = { x: -0.28, y: 0.05, z: 0 };
  lm[LM.THUMB_TIP] = { x: -0.1, y: 0.35, z: 0 };
  assert.equal(isThumbUp(lm), true);
});
