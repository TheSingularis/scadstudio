// M13: 2D corner fillet and chamfer on one vertex of a sketch profile.
//
// OpenSCAD has no fillet for polygon corners, so, as with every curve in
// sketch mode (sketchShapes.ts), a filleted corner becomes points in the
// polygon(): the vertex is replaced by a circular arc tangent to both
// edges, and a chamfered one by two points cut back along them. This is
// the usual way to round the vertical edges of an extruded sketch, and it
// needs no library. Works on convex and concave (inside) corners alike.
//
// Rounded to 3 decimals like the rest of the sketch's points, so the
// preview and the written source carry identical numbers.

export type Vec2 = [number, number];

const EPS = 1e-9;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000 + 0;
}

export interface CornerInfo {
  /** Interior angle at the vertex, in degrees (0-180), whichever side is inside. */
  angleDeg: number;
  /** The largest fillet radius that fits on the two edges. */
  maxRadius: number;
  /** The largest equal-distance chamfer that fits. */
  maxChamfer: number;
}

export type CornerResult = { ok: true; loop: Vec2[]; added: number } | { ok: false; why: string };

function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function len(v: Vec2): number {
  return Math.hypot(v[0], v[1]);
}

function neighbours(loop: Vec2[], index: number): { prev: Vec2; p: Vec2; next: Vec2 } | null {
  const n = loop.length;
  if (n < 3 || index < 0 || index >= n) return null;
  return { prev: loop[(index - 1 + n) % n]!, p: loop[index]!, next: loop[(index + 1) % n]! };
}

/** The corner's angle and how big a fillet or chamfer fits, or null when the vertex isn't a corner. */
export function cornerInfo(loop: Vec2[], index: number): CornerInfo | null {
  const nb = neighbours(loop, index);
  if (!nb) return null;
  const a = sub(nb.prev, nb.p);
  const b = sub(nb.next, nb.p);
  const la = len(a);
  const lb = len(b);
  if (la < EPS || lb < EPS) return null;
  const cos = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)));
  const theta = Math.acos(cos);
  // Straight (or folded back on itself): nothing to round.
  if (theta > Math.PI - 1e-6 || theta < 1e-6) return null;
  const shorter = Math.min(la, lb);
  return { angleDeg: (theta * 180) / Math.PI, maxRadius: shorter * Math.tan(theta / 2), maxChamfer: shorter };
}

/**
 * Replaces vertex `index` with an arc of radius `r`, tangent to both
 * edges. `segments` is the count a full circle would get (sketch mode's
 * circle resolution), so a fillet is as smooth as a drawn circle.
 */
export function filletCorner(loop: Vec2[], index: number, r: number, segments: number): CornerResult {
  const info = cornerInfo(loop, index);
  if (!info) return { ok: false, why: 'that point isn’t a corner (its edges are in line)' };
  if (!(r > 0)) return { ok: false, why: 'the radius must be more than 0' };
  if (r > info.maxRadius + 1e-9) return { ok: false, why: `a radius of ${round3(r)} doesn’t fit there; the most is ${round3(info.maxRadius)}` };
  const { prev, p, next } = neighbours(loop, index)!;
  const theta = (info.angleDeg * Math.PI) / 180;
  const ua = unit(sub(prev, p));
  const ub = unit(sub(next, p));
  const t = r / Math.tan(theta / 2);
  const t1: Vec2 = [p[0] + ua[0] * t, p[1] + ua[1] * t];
  const t2: Vec2 = [p[0] + ub[0] * t, p[1] + ub[1] * t];
  const bis = unit([ua[0] + ub[0], ua[1] + ub[1]]);
  const d = r / Math.sin(theta / 2);
  const c: Vec2 = [p[0] + bis[0] * d, p[1] + bis[1] * d];
  // The arc turns by the corner's exterior angle, the short way from t1 to t2.
  const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
  let sweep = Math.atan2(t2[1] - c[1], t2[0] - c[0]) - a1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * Math.max(3, segments)));
  const arc: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const ang = a1 + (sweep * k) / steps;
    arc.push(k === 0 ? t1 : k === steps ? t2 : [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]);
  }
  return replaceVertex(loop, index, arc);
}

/** Replaces vertex `index` with two points `d` back along each edge. */
export function chamferCorner(loop: Vec2[], index: number, d: number): CornerResult {
  const info = cornerInfo(loop, index);
  if (!info) return { ok: false, why: 'that point isn’t a corner (its edges are in line)' };
  if (!(d > 0)) return { ok: false, why: 'the size must be more than 0' };
  if (d > info.maxChamfer + 1e-9) return { ok: false, why: `a chamfer of ${round3(d)} doesn’t fit there; the most is ${round3(info.maxChamfer)}` };
  const { prev, p, next } = neighbours(loop, index)!;
  const ua = unit(sub(prev, p));
  const ub = unit(sub(next, p));
  return replaceVertex(loop, index, [
    [p[0] + ua[0] * d, p[1] + ua[1] * d],
    [p[0] + ub[0] * d, p[1] + ub[1] * d],
  ]);
}

function unit(v: Vec2): Vec2 {
  const l = len(v);
  return [v[0] / l, v[1] / l];
}

function replaceVertex(loop: Vec2[], index: number, pts: Vec2[]): CornerResult {
  const rounded = pts.map(([u, v]): Vec2 => [round3(u), round3(v)]);
  // A fillet or chamfer that uses a whole edge lands exactly on the
  // neighbouring vertex; don't write that point twice.
  const n = loop.length;
  const prev = loop[(index - 1 + n) % n]!;
  const next = loop[(index + 1) % n]!;
  const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (rounded.length > 0 && same(rounded[0]!, prev)) rounded.shift();
  while (rounded.length > 0 && same(rounded[rounded.length - 1]!, next)) rounded.pop();
  const out = [...loop.slice(0, index), ...rounded, ...loop.slice(index + 1)];
  return { ok: true, loop: out, added: rounded.length - 1 };
}
