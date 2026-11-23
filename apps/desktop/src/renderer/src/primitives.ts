import { formatNumber, formatSketchPolygonArgs } from './targetedPatch';
import type { SketchPoint } from './sketchEditing';

// M5 toolbar primitive insertion. Deliberately minimal codegen: append a new
// statement with sensible defaults at the end of the document. Insertion at
// the cursor/a chosen point is still out of scope; booleans (M6) are their
// own toolbar path (wrap-in-block, not append). M7 adds the two extrusions
// here — each is just a primitive pre-wrapped around a default 2D profile,
// so they reuse the exact same append path as every other primitive; no
// interactive sketching (that's M7.5, see PLAN.md).
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'square' | 'circle' | 'linear_extrude' | 'rotate_extrude';

const PRIMITIVE_DEFAULTS: Record<PrimitiveKind, string> = {
  cube: 'cube([10, 10, 10]);',
  sphere: 'sphere(r=5);',
  cylinder: 'cylinder(h=10, r=5, $fn=32);',
  square: 'square([10, 10]);',
  circle: 'circle(r=5, $fn=32);',
  // linear_extrude pushes a 2D profile straight up; rotate_extrude spins one
  // around the Z axis (so its profile must sit at positive X to form a solid
  // of revolution — a circle at x=15 gives a torus, the canonical demo).
  linear_extrude: 'linear_extrude(height=10) circle(r=5, $fn=32);',
  rotate_extrude: 'rotate_extrude($fn=48) translate([15, 0, 0]) circle(r=4, $fn=32);',
};

function appendStatement(source: string, statement: string): string {
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
  // One loop writes the plain polygon(points=[...]) it always has; several
  // add paths=, which OpenSCAD fills even-odd (a loop inside another is a
  // hole). See profilesToPolygon.
  let statement = `polygon(${formatSketchPolygonArgs(loops)});`;
  if (rotationDeg.some((v) => v !== 0)) {
    statement = `rotate([${rotationDeg.map(formatNumber).join(', ')}]) ${statement}`;
  }
  if (origin.some((v) => v !== 0)) {
    statement = `translate([${origin.map(formatNumber).join(', ')}]) ${statement}`;
  }
  return appendStatement(source, statement);
}
