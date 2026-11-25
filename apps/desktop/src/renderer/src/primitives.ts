import { Vector3 } from 'three';
import { formatNumber, formatSketchPolygonArgs, transformToQuaternion } from './targetedPatch';
import type { SketchPoint } from './sketchEditing';

// M5 toolbar primitive insertion. Deliberately minimal codegen: append a new
// statement with sensible defaults at the end of the document. Insertion at
// the cursor/a chosen point is still out of scope; booleans (M6) are their
// own toolbar path (wrap-in-block, not append). M7 adds the two extrusions
// here — each is just a primitive pre-wrapped around a default 2D profile,
// so they reuse the exact same append path as every other primitive; no
// interactive sketching (that's M7.5, see PLAN.md).
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'square' | 'circle' | 'text' | 'linear_extrude' | 'rotate_extrude';

export const PRIMITIVE_DEFAULTS: Record<PrimitiveKind, string> = {
  cube: 'cube([10, 10, 10]);',
  sphere: 'sphere(r=5);',
  cylinder: 'cylinder(h=10, r=5, $fn=32);',
  square: 'square([10, 10]);',
  circle: 'circle(r=5, $fn=32);',
  // M15: flat 2D text like square()/circle(), extruded with the Extrude
  // tools afterwards (the CAD convention: sketch text, then extrude). The
  // font is written out so the panel and other machines agree on it.
  text: 'text("Text", size=10, font="Liberation Sans");',
  // linear_extrude pushes a 2D profile straight up; rotate_extrude spins one
  // around the Z axis (so its profile must sit at positive X to form a solid
  // of revolution — a circle at x=15 gives a torus, the canonical demo).
  linear_extrude: 'linear_extrude(height=10) circle(r=5, $fn=32);',
  rotate_extrude: 'rotate_extrude($fn=48) translate([15, 0, 0]) circle(r=4, $fn=32);',
};

export function appendStatement(source: string, statement: string): string {
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${statement}\n`;
}

export function appendPrimitive(source: string, kind: PrimitiveKind): string {
  return appendStatement(source, PRIMITIVE_DEFAULTS[kind]);
}

// M7.5: the sketch→SCAD hand-off. `origin`/`rotationDeg` must be the exact
// same ActiveSketchPlane values SketchPointsPreview used to render the live
// in-progress points (Viewport.tsx) — using one shared source of truth for
// both is what guarantees the committed polygon lands exactly where the
// preview showed it, not just approximately. Slice 3 generalized this from
// rotation-only (global planes always pass through the origin) to also
// carry a translate(), needed once a plane can come from a picked face
// sitting anywhere in space. Identity components are omitted entirely,
// matching how patchTransform/formatTransformPrefix already skip them
// elsewhere — a global-plane sketch (origin always [0,0,0]) still emits a
// bare rotate()-or-nothing wrap, unchanged from before this generalization.
export function appendSketchPolygon(
  source: string,
  origin: [number, number, number],
  rotationDeg: [number, number, number],
  loops: SketchPoint[][],
): string {
  return appendStatement(source, sketchPolygonStatement(origin, rotationDeg, loops));
}

// The statement appendSketchPolygon appends; M9 also inserts it into a
// drilled-into container instead (drillIn.ts insertIntoContainer).
export function sketchPolygonStatement(
  origin: [number, number, number],
  rotationDeg: [number, number, number],
  loops: SketchPoint[][],
): string {
  // One loop writes the plain polygon(points=[...]) it always has; several
  // add paths=, which OpenSCAD fills even-odd (a loop inside another is a
  // hole). See profilesToPolygon.
  return wrapInPlane(origin, rotationDeg, `polygon(${formatSketchPolygonArgs(loops)});`);
}

// M15: the sketch-mode Text tool's statement: PRIMITIVE_DEFAULTS.text
// placed on the sketch plane with its baseline start at the clicked point
// `at` (plane-local u, v). The click is folded into the plane's own
// translate(), so the result is the same canonical translate() rotate()
// wrap a sketch polygon gets, which the gizmo and panel already handle.
export function sketchTextStatement(origin: [number, number, number], rotationDeg: [number, number, number], at: SketchPoint): string {
  const p = new Vector3(at[0], at[1], 0).applyQuaternion(transformToQuaternion(rotationDeg)).add(new Vector3(...origin));
  const clean = (v: number) => Math.round(v * 1000) / 1000 + 0;
  return wrapInPlane([clean(p.x), clean(p.y), clean(p.z)], rotationDeg, PRIMITIVE_DEFAULTS.text);
}

function wrapInPlane(origin: [number, number, number], rotationDeg: [number, number, number], inner: string): string {
  let statement = inner;
  if (rotationDeg.some((v) => v !== 0)) {
    statement = `rotate([${rotationDeg.map(formatNumber).join(', ')}]) ${statement}`;
  }
  if (origin.some((v) => v !== 0)) {
    statement = `translate([${origin.map(formatNumber).join(', ')}]) ${statement}`;
  }
  return statement;
}
