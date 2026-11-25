// Gag trophy: "God's drunkest driver"
// Two-faced key (car fob on the front, beer mug on the back) standing in a wood base.
// Pick a part to render, or "assembly" to preview everything together.
part = "assembly"; // [assembly, base, plaque, blade, fob_half, mug_half, foam, buttons_grey, button_accent]

// ---- plaque text (edit these) ----
line1 = "GOD'S DRUNKEST DRIVER";
line1_width = 98;     // line 1 is scaled to this width, mm (plaque is 110 wide)
line1_y = 4.2;        // line 1 centre, mm above the plaque centre
line2 = "2026";       // set to "" for a one-line plaque
line2_height = 5.6;   // line 2 is scaled to this letter height, mm
line2_y = -5.4;       // line 2 centre, mm below the plaque centre
font  = "DejaVu Sans:style=Bold";
text_style = "raised"; // [raised, engraved]
text_relief = 0.8;     // how far the text stands up, or how deep it is cut

$fn = 120;
smooth_edges = true; // false = square edges (used by smooth_parts.py, which lofts true curves instead)
dome_res = 0.1;      // mm, largest step in any rounded surface (lower = smoother and much slower)
cl  = 0.2;   // clearance per side for anything that slots or insets

// ---- key head ----
head_w = 54;      // body width
body_h = 90;      // body height, before foam
head_r = 11;      // body corner radius
half_t = 6;       // thickness of each head half
inset_d = 1.2;    // pocket depth for foam and buttons
edge_r = 1.2;     // rounded outer edge on each half

// ---- blade ----
blade_w   = 18;
blade_t   = 7;
blade_vis = 115;  // visible length between head and base
tab       = 22;   // hidden in the base
tang      = 28;   // hidden inside the head
track_d   = 1.2;  // depth of the wavy track, both faces

// ---- base ----
base_h = 45;      // total, three tiers
pl_w = 110; pl_h = 22; pl_t = 2; pl_rec = 2.2;

pin_d = 2.1;      // alignment holes for 1.75 mm filament offcuts
pin_depth = 3.5;
pin_pos = [[-15, 82], [15, 82]];

// ================= 2D helpers =================
module closing(r) { offset(r = -r) offset(r = r) children(); }           // fills creases
module rounding(r) { offset(r = r) offset(r = -2 * r) offset(r = r) children(); }
module rrect(w, h, r) { hull() for (sx = [-1, 1], sy = [-1, 1]) translate([sx * (w / 2 - r), sy * (h / 2 - r)]) circle(r); }

// domed solid: straight wall, then a quarter-round edge of radius r.
// The curve is built from slices no taller or wider than dome_res, so set dome_res
// well under your layer height and the print comes out as a continuous curve.
module pillow(h, r) {
  if (!smooth_edges) linear_extrude(h) children();
  else {
    steps = ceil(r * PI / 2 / dome_res);
    linear_extrude(h - r) children();
    for (i = [0 : steps - 1]) {
      a0 = 90 * i / steps; a1 = 90 * (i + 1) / steps; am = (a0 + a1) / 2;
      translate([0, 0, h - r + r * sin(a0)])
        linear_extrude(r * (sin(a1) - sin(a0)) + 0.0005)
          offset(delta = -r * (1 - cos(am))) children();
    }
  }
}

// ================= key head =================
module body2d() { translate([0, body_h / 2]) rrect(head_w, body_h, head_r); }

// Foam crown: three overlapping bumps, then a closing pass melts them into one soft cloud
module head2d() {
  closing(8) union() {
    body2d();
    translate([-15, body_h - 1]) circle(10);
    translate([1, body_h + 3]) circle(13);
    translate([16, body_h]) circle(9.5);
  }
}

foam_line = body_h - 14;
module foam2d() {
  rounding(1.5) closing(3) intersection() {
    offset(delta = -1.8) head2d();
    union() {
      translate([-50, foam_line]) square([100, 60]);
      for (d = [[-18, 10], [-6, 5], [7, 14], [19, 6]])
        hull() {
          translate([d[0], foam_line]) circle(5.5);
          translate([d[0], foam_line - d[1]]) circle(5.5);
        }
    }
  }
}

btn_y = [34, 51, 68];
module pill2d() { rrect(30, 12, 6); }
module flip2d() { circle(d = 13); }

module tang_pocket() {
  translate([-(blade_w / 2 + cl), -1, -0.01]) cube([blade_w + 2 * cl, tang + cl + 1, blade_t / 2 + cl]);
}
module pin_holes() { for (p = pin_pos) translate([p[0], p[1], -0.01]) cylinder(d = pin_d, h = pin_depth, $fn = 24); }

module fob_half() {
  difference() {
    pillow(half_t, edge_r) head2d();
    tang_pocket();
    pin_holes();
    translate([0, 0, half_t - inset_d]) linear_extrude(inset_d + 1) {
      for (y = btn_y) translate([0, y]) offset(delta = cl) pill2d();
      translate([0, 13]) offset(delta = cl) flip2d();
    }
  }
}

// modeled mirrored so the outlines line up when the halves go back to back
module mug_half() {
  difference() {
    union() {
      pillow(half_t, edge_r) mirror([1, 0]) head2d();
      // glass flutes
      for (x = [-16.5, -5.5, 5.5, 16.5])
        translate([x, 30, half_t]) pillow(0.9, 0.6) rrect(4.5, 40, 2.25);
    }
    mirror([1, 0, 0]) tang_pocket();
    mirror([1, 0, 0]) pin_holes();
    translate([0, 0, half_t - inset_d]) linear_extrude(inset_d + 1) mirror([1, 0]) offset(delta = cl) foam2d();
  }
}

module foam() { pillow(inset_d + 2.4, 2.2) mirror([1, 0]) foam2d(); }
module pill() { pillow(inset_d + 1.0, 0.8) pill2d(); }
module flip() { pillow(inset_d + 1.0, 0.8) flip2d(); }

// ================= blade =================
function tp(i) = [3.2 * sin(i * 27), -10 - i * (blade_vis - 22) / 40];
module track2d() {
  for (i = [0 : 39]) hull() {
    translate(tp(i)) circle(d = 3.4, $fn = 20);
    translate(tp(i + 1)) circle(d = 3.4, $fn = 20);
  }
}
module tooth(d) { polygon([[-0.01, -d * 1.2], [d, 0], [-0.01, d * 1.2]]); }
module blade2d() {
  translate([-blade_w / 2, -(blade_vis + tab)]) square([blade_w, blade_vis + tab + tang]);
  for (t = [[-20, 4], [-48, 5], [-80, 4]]) translate([blade_w / 2, t[0]]) tooth(t[1]);
  for (t = [[-34, 4], [-62, 5], [-96, 4]]) translate([-blade_w / 2, t[0]]) mirror([1, 0]) tooth(t[1]);
}
module blade() {
  difference() {
    linear_extrude(blade_t) blade2d();
    translate([0, 0, blade_t - track_d]) linear_extrude(track_d + 1) track2d();
    translate([0, 0, -1]) linear_extrude(track_d + 1) track2d();
  }
}

// ================= base and plaque =================
module base() {
  difference() {
    union() {
      linear_extrude(30) rrect(140, 70, 3);
      translate([0, 0, 30]) linear_extrude(8) rrect(110, 54, 3);
      translate([0, 0, 38]) linear_extrude(7) rrect(80, 40, 3);
    }
    translate([0, 0, base_h - tab]) linear_extrude(tab + 1)
      square([blade_w + 2 * cl, blade_t + 2 * cl], center = true);
    translate([0, -35, 15]) cube([pl_w + 2 * cl, pl_rec * 2, pl_h + 2 * cl], center = true);
  }
}
module plaque_plate() { linear_extrude(pl_t) rrect(pl_w, pl_h, 1.5); }
module plaque_text2d() {
  if (line1 != "") translate([0, line1_y]) resize([line1_width, 0], auto = true)
    text(line1, size = 8, font = font, halign = "center", valign = "center");
  if (line2 != "") translate([0, line2_y]) resize([0, line2_height], auto = true)
    text(line2, size = 8, font = font, halign = "center", valign = "center");
}
// the lettering as its own solid; only used to colour the assembly preview
module plaque_text() {
  z = text_style == "engraved" ? pl_t - text_relief : pl_t - 0.01;
  translate([0, 0, z]) linear_extrude(text_relief + 0.01) plaque_text2d();
}
// one printable piece: plate and lettering together
module plaque() {
  if (text_style == "engraved") difference() { plaque_plate(); translate([0, 0, 0.01]) plaque_text(); }
  else union() { plaque_plate(); plaque_text(); }
}

// ================= assembly =================
module key_assembled() {
  color("goldenrod") translate([0, 0, -blade_t / 2]) blade();
  color([0.15, 0.15, 0.15]) fob_half();
  translate([0, 0, half_t - inset_d]) {
    color("silver") { for (y = [btn_y[1], btn_y[2]]) translate([0, y]) pill(); translate([0, 13]) flip(); }
    color("firebrick") translate([0, btn_y[0]]) pill();
  }
  rotate([0, 180, 0]) {
    color("goldenrod") mug_half();
    color("white") translate([0, 0, half_t - inset_d]) foam();
  }
}
module assembly() {
  color("saddlebrown") base();
  translate([0, -35 + pl_rec, 15]) rotate([90, 0, 0]) translate([0, 0, -pl_t]) {
    color("goldenrod") plaque();
    color([0.1, 0.1, 0.1]) plaque_text();
  }
  translate([0, 0, base_h + blade_vis]) rotate([90, 0, 0]) key_assembled();
}

if (part == "assembly") assembly();
else if (part == "base") base();
else if (part == "plaque") plaque();
else if (part == "blade") blade();
else if (part == "fob_half") fob_half();
else if (part == "mug_half") mug_half();
else if (part == "foam") foam();
else if (part == "buttons_grey") { pill(); translate([0, 16]) pill(); translate([0, -17]) flip(); }
else if (part == "button_accent") pill();
// 2D outlines, exported for smooth_parts.py
else if (part == "2d_head") head2d();
else if (part == "2d_foam") mirror([1, 0]) foam2d();
else if (part == "2d_pill") pill2d();
else if (part == "2d_flip") flip2d();
else if (part == "2d_flute") rrect(4.5, 40, 2.25);
