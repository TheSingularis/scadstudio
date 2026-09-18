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

export function appendPrimitive(source: string, kind: PrimitiveKind): string {
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${PRIMITIVE_DEFAULTS[kind]}\n`;
}
