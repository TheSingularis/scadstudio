// M7.5 richer sketch tools: the pure geometry behind the Rectangle, Circle
// and 3-point Arc tools. Everything is sketch-local (u, v), like the rest of
// sketch mode. The viewport's live preview and the committed profile both
// come from these same functions, so what the preview shows is exactly what
// lands in the polygon().
//
// OpenSCAD has no native arc or line primitive, so circles and arcs become
// point runs in the sketch's polygon(), the same thing a hand-written
// OpenSCAD profile with a rounded corner would contain.

export type Vec2 = [number, number];

// 'edit' is Edit Points: click an edge to insert a vertex, double-click a
// vertex to delete it. Dragging a handle works with every tool.
// M15 'text': one click places a text() statement on the sketch plane.
export type SketchTool = 'line' | 'arc' | 'rect' | 'circle' | 'text' | 'edit';

// Same 3-decimal rounding formatNumber applies when the polygon is written,
// done here so the preview, the snap targets and the committed source all
// carry identical numbers. `+ 0` turns -0 into 0.
function round3(n: number): number {
  return Math.round(n * 1000) / 1000 + 0;
}

function roundPoint([u, v]: Vec2): Vec2 {
  return [round3(u), round3(v)];
}

const EPS = 1e-9;

// Axis-aligned rectangle from two opposite corners, counter-clockwise from
// the first corner. Null when it would have no area.
export function rectanglePoints(a: Vec2, b: Vec2): Vec2[] | null {
  if (Math.abs(a[0] - b[0]) < EPS || Math.abs(a[1] - b[1]) < EPS) return null;
  const pts: Vec2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
  // Keep the winding counter-clockwise regardless of drag direction, so two
  // rectangles drawn in different directions read the same in the source.
  const area = signedArea(pts);
  return area < 0 ? [pts[0], pts[3], pts[2], pts[1]] : pts;
}

// A circle as a regular polygon. The point clicked to set the radius is
// itself the first vertex, so it lands exactly where the person clicked
// (and where they snapped it). Null for a zero radius.
export function circlePoints(center: Vec2, rim: Vec2, segments: number): Vec2[] | null {
  const r = Math.hypot(rim[0] - center[0], rim[1] - center[1]);
  if (r < EPS || segments < 3) return null;
  const start = Math.atan2(rim[1] - center[1], rim[0] - center[0]);
  const pts: Vec2[] = [rim];
  for (let i = 1; i < segments; i++) {
    const t = start + (i * 2 * Math.PI) / segments;
    pts.push(roundPoint([center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)]));
  }
  return pts;
}

// The points a 3-point arc adds after `start`: the arc runs from start to
// end and passes through `through`. The result excludes start (it is
// already in the profile) and ends exactly on `end`. `segments` is the
// count a full circle of the same radius would get, so an arc's smoothness
// matches a circle drawn with the same setting. When the three points are
// collinear there is no arc, and the result is just [end] (a straight edge).
export function arcPoints(start: Vec2, end: Vec2, through: Vec2, segments: number): Vec2[] {
  const center = circumcenter(start, end, through);
  if (!center) return [end];
  const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const am = Math.atan2(through[1] - center[1], through[0] - center[0]);
  const ccwSweep = normalizeAngle(a1 - a0);
  // Counter-clockwise from start reaches `through` before `end` exactly when
  // the arc is the counter-clockwise one; otherwise it goes the other way.
  const sweep = normalizeAngle(am - a0) < ccwSweep ? ccwSweep : ccwSweep - 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * segments));
  const pts: Vec2[] = [];
  for (let i = 1; i < steps; i++) {
    const t = a0 + (sweep * i) / steps;
    pts.push(roundPoint([center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)]));
  }
  pts.push(end);
  return pts;
}

function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  return ((a % twoPi) + twoPi) % twoPi;
}

function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  // Relative to the triangle's size, so tiny and huge sketches behave alike.
  const scale = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), 1e-6);
  if (Math.abs(d) < 1e-6 * scale * scale) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

export function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

// What a tool would add if the next click landed at `cursor`, given the
// anchor clicks it has already collected and the open profile's last point.
// Used for the live preview only; the commit path calls the same shape
// functions directly. `closed` says whether to draw the result as a loop.
export function toolPreview(
  tool: SketchTool,
  anchors: Vec2[],
  lastOpenPoint: Vec2 | null,
  cursor: Vec2,
  segments: number,
): { points: Vec2[]; closed: boolean } | null {
  if (tool === 'rect' && anchors.length === 1) {
    const pts = rectanglePoints(anchors[0], cursor);
    return pts ? { points: pts, closed: true } : null;
  }
  if (tool === 'circle' && anchors.length === 1) {
    const pts = circlePoints(anchors[0], cursor, segments);
    return pts ? { points: pts, closed: true } : null;
  }
  if (tool === 'arc' && anchors.length === 1 && lastOpenPoint) {
    return { points: [lastOpenPoint, ...arcPoints(lastOpenPoint, anchors[0], cursor, segments)], closed: false };
  }
  return null;
}
