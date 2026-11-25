import { BufferGeometry, EdgesGeometry, Matrix4, Vector3 } from 'three';
import { transformToQuaternion, type NodeTransform } from './targetedPatch';

// M7.5 snap-while-drawing: the cheap, solver-free constraints tier from
// PLAN.md's "Sketch mode (M7.5)" write-up. Everything here works in
// sketch-local (u, v) space — the same space SketchDrawingPlane already
// converts clicks into and appendSketchPolygon emits — so a snapped point
// is exactly the number that lands in the committed polygon(), with no
// second conversion step that could drift from what the preview showed.

export type Vec2 = [number, number];

export interface SnapSettings {
  grid: boolean;
  gridSize: number;
  // Existing geometry (on-plane vertices/edges/midpoints), the plane's own
  // origin, closing the loop on the first point, and horizontal/vertical
  // alignment with points already placed this session.
  geometry: boolean;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = { grid: true, gridSize: 1, geometry: true };

export type SnapKind = 'close' | 'endpoint' | 'midpoint' | 'origin' | 'edge' | 'align' | 'grid' | 'none';

export interface SnapSegment {
  a: Vec2;
  b: Vec2;
}

// Existing geometry that lies *in* the sketch plane, already converted to
// sketch-local coordinates — see extractOnPlaneGeometry below.
export interface PlaneSnapGeometry {
  points: Vec2[];
  segments: SnapSegment[];
}

export const EMPTY_PLANE_SNAP_GEOMETRY: PlaneSnapGeometry = { points: [], segments: [] };

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  // Set when the result shares its u (vertical guide) or v (horizontal
  // guide) with a point already placed this session — the reference point
  // the preview draws its alignment guide line from.
  alignedU: Vec2 | null;
  alignedV: Vec2 | null;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function closestOnSegment(p: Vec2, { a, b }: SnapSegment): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return a;
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return [a[0] + t * dx, a[1] + t * dy];
}

function roundTo(value: number, step: number): number {
  // `+ 0` normalizes -0 so a snapped point never prints as "-0".
  return Math.round(value / step) * step + 0;
}

// Priority, highest first: an exact point target (close-the-loop on the
// first point, an on-plane vertex of existing geometry, an edge midpoint,
// the plane origin) → a point along an existing on-plane edge → per-axis
// horizontal/vertical alignment with this session's points → the grid →
// the raw cursor position. `tolerance` is in sketch-local units; the caller
// derives it from a fixed on-screen pixel radius so snapping feels the same
// at any zoom level.
export function snapSketchPoint(
  raw: Vec2,
  sketchPoints: Vec2[],
  geometry: PlaneSnapGeometry,
  settings: SnapSettings,
  tolerance: number,
  // Closing is only meaningful while drawing a new, still-open profile —
  // not while dragging a point or editing an already-closed one.
  allowClose = true,
): SnapResult {
  if (settings.geometry) {
    const targets: { point: Vec2; kind: SnapKind }[] = [];
    // Only the first point is a target, and only once there are enough
    // points for a real polygon: clicking it closes the loop. Every other
    // already-placed point is deliberately not a target — landing exactly
    // on one would just add a duplicate/self-touching vertex.
    if (allowClose && sketchPoints.length >= 3) targets.push({ point: sketchPoints[0], kind: 'close' });
    for (const p of geometry.points) targets.push({ point: p, kind: 'endpoint' });
    for (const s of geometry.segments) {
      targets.push({ point: [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], kind: 'midpoint' });
    }
    targets.push({ point: [0, 0], kind: 'origin' });

    // Ties go to whichever target was pushed first, i.e. the order above.
    let best: { point: Vec2; kind: SnapKind } | null = null;
    let bestDist = tolerance;
    for (const t of targets) {
      const d = dist(raw, t.point);
      if (d <= bestDist && (best === null || d < bestDist)) {
        best = t;
        bestDist = d;
      }
    }
    if (best) return { point: best.point, kind: best.kind, alignedU: null, alignedV: null };

    let bestEdge: Vec2 | null = null;
    let bestEdgeDist = tolerance;
    for (const s of geometry.segments) {
      const c = closestOnSegment(raw, s);
      const d = dist(raw, c);
      if (d <= bestEdgeDist) {
        bestEdge = c;
        bestEdgeDist = d;
      }
    }
    if (bestEdge) return { point: bestEdge, kind: 'edge', alignedU: null, alignedV: null };
  }

  let u = raw[0];
  let v = raw[1];
  let alignedU: Vec2 | null = null;
  let alignedV: Vec2 | null = null;
  if (settings.geometry) {
    // Most recent point first, so the guide prefers "straight on from the
    // last point" — the common rectangle-drawing case — over older ones.
    for (let i = sketchPoints.length - 1; i >= 0; i--) {
      const p = sketchPoints[i];
      if (!alignedU && Math.abs(raw[0] - p[0]) <= tolerance) alignedU = p;
      if (!alignedV && Math.abs(raw[1] - p[1]) <= tolerance) alignedV = p;
    }
  }
  const gridOn = settings.grid && settings.gridSize > 0;
  if (alignedU) u = alignedU[0];
  else if (gridOn) u = roundTo(u, settings.gridSize);
  if (alignedV) v = alignedV[1];
  else if (gridOn) v = roundTo(v, settings.gridSize);
  const kind: SnapKind = alignedU || alignedV ? 'align' : gridOn ? 'grid' : 'none';
  return { point: [u, v], kind, alignedU, alignedV };
}

// Feature edges only (EdgesGeometry's angle threshold): the edges a person
// would call "the edges" of a shape, not every triangle seam of its STL
// tessellation — a box face's diagonal, or a sphere's shallow facet seams,
// aren't snap-worthy. Cached per STL buffer, same lifetime as the parsed
// geometry itself (see Viewport.tsx's geometry cache).
const FEATURE_EDGE_ANGLE_DEG = 20;
const featureEdgeCache = new WeakMap<BufferGeometry, Float32Array>();

function featureEdgePositions(geometry: BufferGeometry): Float32Array {
  let cached = featureEdgeCache.get(geometry);
  if (!cached) {
    const edges = new EdgesGeometry(geometry, FEATURE_EDGE_ANGLE_DEG);
    cached = edges.getAttribute('position').array as Float32Array;
    edges.dispose();
    featureEdgeCache.set(geometry, cached);
  }
  return cached;
}

// How far off the plane (in world units) an edge endpoint may sit and
// still count as lying on it. STL coordinates come back from openscad-wasm
// with limited precision, and a face-picked plane's origin is itself a
// raycast hit on that same geometry, so exact equality would miss real
// on-plane edges.
const ON_PLANE_EPSILON = 5e-3;

// Existing shapes' feature edges that lie in the sketch plane, converted to
// sketch-local (u, v). Only on-plane geometry counts — the bottom outline of
// a part sitting on XY, or the edges of the very face a sketch was picked
// from — not a projection of everything in the scene, which would make
// every off-plane silhouette a snap target the drawn polygon can't actually
// touch.
export function extractOnPlaneGeometry(
  shapes: { geometry: BufferGeometry; transform: NodeTransform; frame?: number[] }[],
  plane: { origin: [number, number, number]; rotationDeg: [number, number, number] },
): PlaneSnapGeometry {
  const inverse = transformToQuaternion(plane.rotationDeg).invert();
  const origin = new Vector3(...plane.origin);
  const toLocal = (v: Vector3) => v.sub(origin).applyQuaternion(inverse);
  const points: Vec2[] = [];
  const segments: SnapSegment[] = [];
  const seen = new Set<string>();
  const addPoint = (p: Vec2) => {
    const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push(p);
  };

  const matrix = new Matrix4();
  const a = new Vector3();
  const b = new Vector3();
  for (const { geometry, transform, frame } of shapes) {
    // Same T·R·S composition NodeModel's pivot group applies, so these are
    // the exact world positions the shape is drawn at — inside its working
    // set's frame when drilled in (M9).
    matrix.compose(new Vector3(...transform.translate), transformToQuaternion(transform.rotateDeg), new Vector3(...transform.scale));
    if (frame) matrix.premultiply(new Matrix4().fromArray(frame));
    const pos = featureEdgePositions(geometry);
    for (let i = 0; i + 5 < pos.length; i += 6) {
      toLocal(a.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(matrix));
      toLocal(b.set(pos[i + 3], pos[i + 4], pos[i + 5]).applyMatrix4(matrix));
      if (Math.abs(a.z) > ON_PLANE_EPSILON || Math.abs(b.z) > ON_PLANE_EPSILON) continue;
      const pa: Vec2 = [a.x, a.y];
      const pb: Vec2 = [b.x, b.y];
      segments.push({ a: pa, b: pb });
      addPoint(pa);
      addPoint(pb);
    }
  }
  return { points, segments };
}
