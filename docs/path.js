// Pure 2D path math: turning a noisy, pinch-drawn stroke into a clean,
// closed polygon ready to hand to Three.js's ExtrudeGeometry. No Three.js
// dependency here, so it's unit-testable with plain arrays of {x, y}.

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Ramer-Douglas-Peucker simplification: keeps the shape's overall silhouette
// while dropping points that don't deviate much from the line between their
// neighbors -- turns a jittery hand-drawn stroke into a clean polygon.
export function simplifyPath(points, tolerance = 0.01) {
  if (points.length <= 2) return points.slice();

  function perpendicularDistance(pt, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x, dy = lineEnd.y - lineStart.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return dist(pt, lineStart);
    const t = ((pt.x - lineStart.x) * dx + (pt.y - lineStart.y) * dy) / (len * len);
    const projX = lineStart.x + t * dx, projY = lineStart.y + t * dy;
    return Math.hypot(pt.x - projX, pt.y - projY);
  }

  function rdp(pts) {
    if (pts.length <= 2) return pts;
    let maxDist = -1, maxIdx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistance(pts[i], pts[0], pts[pts.length - 1]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance) {
      const left = rdp(pts.slice(0, maxIdx + 1));
      const right = rdp(pts.slice(maxIdx));
      return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[pts.length - 1]];
  }

  return rdp(points);
}

// Ensures the path's last point coincides with the first (auto-closing an
// open stroke), unless it's already effectively closed.
export function closePath(points, closeTolerance = 0.03) {
  if (points.length < 3) return points.slice();
  const first = points[0], last = points[points.length - 1];
  if (dist(first, last) <= closeTolerance) {
    return points.slice(0, -1).concat([{ x: first.x, y: first.y }]);
  }
  return points.concat([{ x: first.x, y: first.y }]);
}

// Shoelace formula: signed area (positive = counter-clockwise in standard
// math orientation, i.e. y-up). Screen-space y grows downward, so a path
// that looks clockwise on screen comes out with positive area here.
export function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function centroid(points) {
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  return { x: cx / points.length, y: cy / points.length };
}

export function boundingBox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Recenters the path on (0, 0) and scales it so its largest dimension
// equals `targetSize`, flipping Y (screen space grows down; a "normal"
// 2D shape for extrusion should grow up) -- ready to extrude in a
// consistent, predictable size regardless of how big it was drawn.
export function normalizePath(points, targetSize = 1) {
  const box = boundingBox(points);
  const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const largest = Math.max(box.width, box.height) || 1;
  const scale = targetSize / largest;
  return points.map((p) => ({
    x: (p.x - c.x) * scale,
    y: -(p.y - c.y) * scale,
  }));
}

// Full pipeline: simplify -> close -> normalize. Returns null if the
// resulting path is too small/degenerate to extrude meaningfully.
export function preparePathForExtrusion(rawPoints, options = {}) {
  const { simplifyTolerance = 0.01, targetSize = 1, minPoints = 3, minArea = 1e-5 } = options;
  if (rawPoints.length < minPoints) return null;

  const simplified = simplifyPath(rawPoints, simplifyTolerance);
  const closed = closePath(simplified);
  if (closed.length < minPoints + 1) return null;

  const box = boundingBox(closed);
  if (Math.max(box.width, box.height) < 1e-6) return null;

  const normalized = normalizePath(closed, targetSize);
  const area = Math.abs(signedArea(normalized));
  if (area < minArea) return null;

  return normalized;
}
