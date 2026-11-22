// M7.5 on-plane editing: pure 2D helpers for reshaping a sketch's point
// loops, kept out of App.tsx/Viewport.tsx so the geometry is readable on its
// own. Everything here works in sketch-local (u, v) — the same frame the
// committed polygon(points=[...]) is written in.

export type SketchPoint = [number, number];

// A sketch session's geometry. `profiles` are closed loops; `open` is the
// polyline the Line/Arc tools are currently appending to (empty when none).
// Finish Sketch / Save Sketch close `open` too, when it has 3+ points.
// Several profiles become one polygon(points, paths) (formatSketchPolygonArgs,
// targetedPatch.ts): OpenSCAD fills it even-odd, so a loop drawn inside
// another one cuts a hole, the way a circle inside a rectangle does in any
// CAD sketch.
export interface SketchState {
  profiles: SketchPoint[][];
  open: SketchPoint[];
}

export const EMPTY_SKETCH: SketchState = { profiles: [], open: [] };

// Addresses one handle. `profile` is an index into `profiles`, or -1 for the
// open polyline.
export interface SketchHandle {
  profile: number;
  point: number;
}

export function sketchPointAt(sketch: SketchState, h: SketchHandle): SketchPoint | undefined {
  return (h.profile === -1 ? sketch.open : sketch.profiles[h.profile])?.[h.point];
}

export function allSketchPoints(sketch: SketchState): SketchPoint[] {
  return [...sketch.profiles.flat(), ...sketch.open];
}

// The profiles Finish/Save would write: every closed loop plus the open
// polyline when it has enough points to close.
export function committableProfiles(sketch: SketchState): SketchPoint[][] {
  return sketch.open.length >= 3 ? [...sketch.profiles, sketch.open] : sketch.profiles;
}

export function moveSketchPoint(sketch: SketchState, h: SketchHandle, p: SketchPoint): SketchState {
  if (h.profile === -1) return { ...sketch, open: sketch.open.map((q, i) => (i === h.point ? p : q)) };
  return {
    ...sketch,
    profiles: sketch.profiles.map((loop, li) => (li === h.profile ? loop.map((q, i) => (i === h.point ? p : q)) : loop)),
  };
}

// Double-click on a handle. A closed loop can't go below 3 points, so
// deleting from a triangle removes the whole loop — unless `keepLastLoop` is
// set and it's the only one (editing a committed sketch, where Save needs at
// least one valid loop to write). `wholeLoop` (Shift+double-click) removes
// the handle's entire loop at once, which is the only sane way to drop a
// 32-point circle.
export function deleteSketchPoint(sketch: SketchState, h: SketchHandle, wholeLoop: boolean, keepLastLoop: boolean): SketchState {
  if (h.profile === -1) {
    return { ...sketch, open: wholeLoop ? [] : sketch.open.filter((_, i) => i !== h.point) };
  }
  const loop = sketch.profiles[h.profile];
  if (!loop) return sketch;
  if (wholeLoop || loop.length <= 3) {
    if (keepLastLoop && sketch.profiles.length === 1 && sketch.open.length < 3) return sketch;
    return { ...sketch, profiles: sketch.profiles.filter((_, i) => i !== h.profile) };
  }
  return {
    ...sketch,
    profiles: sketch.profiles.map((l, i) => (i === h.profile ? l.filter((_, j) => j !== h.point) : l)),
  };
}

function distanceToSegmentSq(p: SketchPoint, a: SketchPoint, b: SketchPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const cx = a[0] + t * dx - p[0];
  const cy = a[1] + t * dy - p[1];
  return cx * cx + cy * cy;
}

// Clicking the plane with the Edit Points tool adds a new vertex into
// whichever closed-loop edge — including each loop's closing edge from its
// last point back to its first — passes nearest the click. Appending to the
// end (what the Line tool does) would always splice the new point into the
// closing edge, wherever the click actually landed. Null when there is no
// closed loop to insert into.
export function insertIntoNearestEdge(sketch: SketchState, p: SketchPoint): SketchState | null {
  let best: { loop: number; index: number } | null = null;
  let bestDistance = Infinity;
  for (let loop = 0; loop < sketch.profiles.length; loop++) {
    const points = sketch.profiles[loop];
    for (let i = 0; i < points.length; i++) {
      const d = distanceToSegmentSq(p, points[i], points[(i + 1) % points.length]);
      if (d < bestDistance) {
        bestDistance = d;
        best = { loop, index: i };
      }
    }
  }
  if (!best) return null;
  const { loop, index } = best;
  return {
    ...sketch,
    profiles: sketch.profiles.map((points, i) => (i === loop ? [...points.slice(0, index + 1), p, ...points.slice(index + 1)] : points)),
  };
}

// Appends points to the open polyline. When the run ends back on the
// polyline's first point (an arc whose end was snapped to it), the loop is
// closed instead of writing a duplicate vertex.
// A point equal to the one before it is dropped: grid snapping makes it easy
// to click the same spot twice, and it would only add a zero-length edge.
export function appendToOpen(sketch: SketchState, pts: SketchPoint[]): SketchState {
  const open = [...sketch.open];
  for (const p of pts) {
    const prev = open[open.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    open.push(p);
  }
  const first = open[0];
  const last = open[open.length - 1];
  if (open.length >= 4 && first && last && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
    return { profiles: [...sketch.profiles, open.slice(0, -1)], open: [] };
  }
  return { ...sketch, open };
}

// Clicking the open polyline's first point (3+ points) closes it into a loop
// and leaves the session open for the next profile.
export function closeOpen(sketch: SketchState): SketchState {
  if (sketch.open.length < 3) return sketch;
  return { profiles: [...sketch.profiles, sketch.open], open: [] };
}

export function addProfile(sketch: SketchState, loop: SketchPoint[]): SketchState {
  return { ...sketch, profiles: [...sketch.profiles, loop] };
}
