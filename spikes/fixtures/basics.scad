// basic primitives, transforms, booleans, modules, functions
module bracket(w=20, h=10, thickness=3) {
    difference() {
        cube([w, h, thickness]);
        translate([thickness, thickness, -1])
            cube([w - 2 * thickness, h - 2 * thickness, thickness + 2]);
    }
}

function midpoint(a, b) = (a + b) / 2;

union() {
    bracket(30, 15, 4);
    translate([0, 0, 10]) {
        cylinder(h=20, r=5, $fn=32);
    }
}

intersection() {
    sphere(r=10);
    cube([15, 15, 15], center=true);
}

rotate([0, 0, 45])
    scale([1, 2, 1])
        mirror([1, 0, 0])
            color("red")
                cube(5);

linear_extrude(height=10, twist=90)
    circle(r=3);

rotate_extrude(angle=180)
    translate([5, 0, 0])
        square([2, 4]);
