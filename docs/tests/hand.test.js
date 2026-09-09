import { test } from "node:test";
import assert from "node:assert/strict";
import { pinchRatio, isPinching, penPoint, palmWidth, handRotation, Debouncer, LM } from "../hand.js";

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
