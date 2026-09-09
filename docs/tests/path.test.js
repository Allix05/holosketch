import { test } from "node:test";
import assert from "node:assert/strict";
import {
  simplifyPath,
  closePath,
  signedArea,
  centroid,
  boundingBox,
  normalizePath,
  preparePathForExtrusion,
} from "../path.js";

test("simplifyPath drops collinear points on a straight line", () => {
  const points = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 },
  ];
  const simplified = simplifyPath(points, 0.01);
  assert.equal(simplified.length, 2);
  assert.deepEqual(simplified[0], { x: 0, y: 0 });
  assert.deepEqual(simplified[1], { x: 4, y: 0 });
});

test("simplifyPath keeps a point that deviates beyond tolerance", () => {
  const points = [
    { x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 },
  ];
  const simplified = simplifyPath(points, 0.1);
  assert.equal(simplified.length, 3, "the middle point sticks out and should be kept");
});

test("closePath auto-closes an open stroke", () => {
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const closed = closePath(points);
  assert.deepEqual(closed[closed.length - 1], { x: 0, y: 0 });
});

test("closePath doesn't duplicate an already-closed stroke", () => {
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.01, y: 0.01 }];
  const closed = closePath(points, 0.05);
  assert.equal(closed.length, points.length);
});

test("signedArea of a unit square (CCW in math coords) is positive", () => {
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.ok(Math.abs(signedArea(square) - 1) < 1e-9);
});

test("signedArea flips sign when winding direction reverses", () => {
  const square = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
  assert.ok(signedArea(square) < 0);
});

test("centroid of a symmetric square is its center", () => {
  const square = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  assert.deepEqual(centroid(square), { x: 1, y: 1 });
});

test("boundingBox reports correct extents", () => {
  const points = [{ x: -1, y: 2 }, { x: 3, y: -4 }, { x: 0, y: 0 }];
  const box = boundingBox(points);
  assert.deepEqual(box, { minX: -1, minY: -4, maxX: 3, maxY: 2, width: 4, height: 6 });
});

test("normalizePath centers on origin and scales to target size", () => {
  const square = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }];
  const normalized = normalizePath(square, 2);
  const box = boundingBox(normalized);
  assert.ok(Math.abs(box.width - 2) < 1e-9);
  assert.ok(Math.abs(box.height - 2) < 1e-9);
  const c = centroid(normalized);
  assert.ok(Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9);
});

test("normalizePath flips Y (screen-down becomes math-up)", () => {
  // In screen space, this point is *below* center (larger y). After the
  // flip it should end up *above* center (negative y in math space).
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }];
  const normalized = normalizePath(points, 1);
  // The bottom-right screen point (10, 20) is the highest-y (most "down").
  const idx = points.findIndex((p) => p.x === 10 && p.y === 20);
  assert.ok(normalized[idx].y < 0, "screen-down point should map to negative (math-down) after flip is inverted");
});

test("preparePathForExtrusion returns null for too few points", () => {
  assert.equal(preparePathForExtrusion([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
});

test("preparePathForExtrusion returns null for a degenerate (zero-size) path", () => {
  const points = Array.from({ length: 5 }, () => ({ x: 0.5, y: 0.5 }));
  assert.equal(preparePathForExtrusion(points), null);
});

test("preparePathForExtrusion produces a valid normalized shape for a rough circle", () => {
  const points = [];
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    points.push({ x: 0.5 + Math.cos(angle) * 0.2, y: 0.5 + Math.sin(angle) * 0.2 });
  }
  const shape = preparePathForExtrusion(points);
  assert.ok(shape !== null);
  const box = boundingBox(shape);
  assert.ok(Math.abs(Math.max(box.width, box.height) - 1) < 1e-6);
});
