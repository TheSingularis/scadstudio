// M5 toolbar primitive insertion. Deliberately minimal codegen: append a new
// statement with sensible defaults at the end of the document. Insertion at
// the cursor/a chosen point, and the full built-in toolbar set (polyhedron,
// text, booleans, extrude — the latter two are their own milestones, M6/M7),
// are explicitly out of scope for this first cut.
export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'square' | 'circle';

const PRIMITIVE_DEFAULTS: Record<PrimitiveKind, string> = {
  cube: 'cube([10, 10, 10]);',
  sphere: 'sphere(r=5);',
  cylinder: 'cylinder(h=10, r=5, $fn=32);',
  square: 'square([10, 10]);',
  circle: 'circle(r=5, $fn=32);',
};

export function appendPrimitive(source: string, kind: PrimitiveKind): string {
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${PRIMITIVE_DEFAULTS[kind]}\n`;
}
