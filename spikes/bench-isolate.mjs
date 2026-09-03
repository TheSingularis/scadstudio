import { createOpenSCAD } from 'openscad-wasm';

const cases = {
  'cube+cylinder(fn=32) union': `union() { cube(10); translate([0,0,10]) cylinder(h=20,r=5,$fn=32); }`,
  'difference (bracket)': `module bracket(w=20,h=10,t=3){difference(){cube([w,h,t]);translate([t,t,-1])cube([w-2*t,h-2*t,t+2]);}} bracket(30,15,4);`,
  'intersection sphere+cube': `intersection(){sphere(r=10);cube([15,15,15],center=true);}`,
  'linear_extrude with twist': `linear_extrude(height=10, twist=90) circle(r=3);`,
  'linear_extrude no twist': `linear_extrude(height=10) circle(r=3);`,
  'rotate_extrude': `rotate_extrude(angle=180) translate([5,0,0]) square([2,4]);`,
  'transforms chain': `rotate([0,0,45]) scale([1,2,1]) mirror([1,0,0]) color("red") cube(5);`,
};

for (const [label, code] of Object.entries(cases)) {
  const openscad = await createOpenSCAD({ print: () => {}, printErr: () => {} });
  const t0 = performance.now();
  await openscad.renderToStl(code);
  const t1 = performance.now();
  console.log(`${(t1 - t0).toFixed(0).padStart(6)}ms  ${label}`);
}
