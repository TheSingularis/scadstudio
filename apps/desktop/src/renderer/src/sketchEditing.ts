// M7.5 on-plane editing: pure 2D helpers for reshaping a sketch's point
// loop, kept out of App.tsx/Viewport.tsx so the geometry is readable on its
// own. Everything here works in sketch-local (u, v) — the same frame the
// committed polygon(points=[...]) is written in.

export type SketchPoint = [number, number];

function distanceToSegmentSq(p: SketchPoint, a: SketchPoint, b: SketchPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const cx = a[0] + t * dx - p[0];
  const cy = a[1] + t * dy - p[1];
  return cx * cx + cy * cy;
}

// Clicking the plane while editing a committed (closed) profile inserts a
// new vertex into whichever edge — including the closing edge from the last
// point back to the first — passes nearest the click. Appending to the end
// (what draw mode does) would always splice the new point into the closing
// edge, wherever the click actually landed.
export function insertIntoNearestEdge(points: SketchPoint[], p: SketchPoint): SketchPoint[] {
  if (points.length < 2) return [...points, p];
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = distanceToSegmentSq(p, points[i], points[(i + 1) % points.length]);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return [...points.slice(0, bestIndex + 1), p, ...points.slice(bestIndex + 1)];
}
