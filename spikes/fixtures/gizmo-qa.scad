// scadstudio gizmo QA fixture — M4/M5 manual testing
// Every shape below is deliberately asymmetric (no spheres as the primary
// test target — a sphere's rotational symmetry hides pivot and rotation-
// composition bugs, which is exactly how two rounds of real bugs slipped
// past earlier automated verification). Each shape is annotated with what
// it's specifically meant to exercise; see the accompanying checklist.

// 1. Bare cube, no wraps yet.
// Tests: first-ever translate/rotate/scale drag inserts a brand-new wrap.
cube([14, 8, 4]);

// 2. Translated-only cylinder, default (non-centered) orientation.
// Tests: rotate pivot correctness. This exact shape (a plain translate +
// off-center-bbox cylinder) is what revealed the original pivot bug —
// rotating it must spin it in place, never shift its position.
translate([30, 0, 0])
    cylinder(h=20, r=5, $fn=32);

// 3. Translated + already-rotated asymmetric block.
// Tests: patching an existing rotate (drag it again, confirm one updated
// rotate([...]) rather than a duplicate), and inserting a brand-new scale
// on top of an existing rotate (must land outside it in the source — the
// "resizes right while dragging, wrong after re-render" bug).
translate([-30, 0, 0])
    rotate([0, 0, 30])
        cube([16, 6, 6], center=true);

// 4. Translated + already non-uniformly scaled cylinder.
// Tests: scale composes multiplicatively (drag again, confirm the factors
// multiply into one scale([...]) rather than duplicating).
translate([0, 30, 0])
    scale([1.5, 1, 1])
        cylinder(h=10, r=6, center=true, $fn=32);

// 5. Translated wedge with a negative coordinate already present.
// Tests: negative numbers (parsed as unary_expression, not a plain number
// literal) are still recognized as an existing wrap — drag it again and
// confirm it patches in place instead of inserting a duplicate.
translate([-15, -25, 0])
    cylinder(h=12, r1=6, r2=2, $fn=24);
