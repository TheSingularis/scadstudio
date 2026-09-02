// library module intended for `use <lib.scad>`
module gear_stub(teeth=10, radius=8, height=4) {
    cylinder(h=height, r=radius, $fn=teeth * 2);
}

function tooth_pitch(teeth, radius) = (2 * 3.14159265 * radius) / teeth;
