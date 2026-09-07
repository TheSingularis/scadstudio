// scadstudio test file
// Click any shape in the viewport, or click inside its code below, to see the
// bidirectional selection sync. Try editing a number (e.g. bolt_count) and
// watch the render update after a short pause. Try breaking a line on purpose
// (delete a semicolon) to see the parse-error count without losing the render.

module mounting_bracket(w=40, h=20, thickness=4) {
    difference() {
        cube([w, h, thickness]);
        translate([thickness, thickness, -1])
            cube([w - 2 * thickness, h - 2 * thickness, thickness + 2]);
    }
}

function bolt_spacing(count, span) = span / (count - 1);

bolt_count = 4;
bolt_span = 60;

mounting_bracket(80, 30, 5);

for (i = [0 : bolt_count - 1])
    translate([i * bolt_spacing(bolt_count, bolt_span), -10, 0])
        cylinder(h=10, r=2.5, $fn=24);

translate([0, 40, 0])
    cube([20, 20, 20]);

translate([40, 40, 10])
    sphere(r=10, $fn=32);

translate([70, 40, 0])
    cylinder(h=25, r1=10, r2=4, $fn=32);

translate([0, -30, 0])
    linear_extrude(height=6, twist=45, slices=30)
        circle(r=8, $fn=32);
