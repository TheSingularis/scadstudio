// M13: deciding whether one isolated render needs BOSL2. The engine check
// (same solid with and without the include) is in
// test/integration/bosl2.test.ts; this pins the reachability rules.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../helpers/parse';
import { BOSL2_DIR } from '../helpers/paths';
import { bosl2NamesFromSources, usesBosl2, withoutUnusedBosl2 } from '../../src/renderer/src/bosl2Usage';

const names = bosl2NamesFromSources(
  readdirSync(BOSL2_DIR)
    .filter((f) => f.endsWith('.scad'))
    .map((f) => readFileSync(path.join(BOSL2_DIR, f), 'utf8')),
);
const INC = 'include <BOSL2/std.scad>\n';
const uses = async (body: string) => usesBosl2(await parse(INC + body), names);

describe('BOSL2 names', () => {
  it('reads modules, functions and variables from the library', () => {
    expect(names.modules.has('cuboid')).toBe(true);
    expect(names.modules.has('diff')).toBe(true);
    expect(names.functions.has('fwd')).toBe(true);
    expect(names.variables.has('TOP')).toBe(true);
    expect(names.variables.has('EDGES_ALL')).toBe(true);
    expect(names.modules.size).toBeGreaterThan(250);
  });
});

describe('usesBosl2', () => {
  it('plain OpenSCAD does not', async () => {
    expect(await uses('cube(10);')).toBe(false);
    expect(await uses('translate([1, 2, 3]) rotate([0, 0, 45]) cylinder(h = 10, r = 3, $fn = 24);')).toBe(false);
    expect(await uses('difference() { cube(10, center = true); sphere(6); }')).toBe(false);
    expect(await uses('linear_extrude(5) square([4, 2]);')).toBe(false);
  });

  it('a BOSL2 module, function or constant does', async () => {
    expect(await uses('cuboid(10, rounding = 1);')).toBe(true);
    expect(await uses('translate(fwd(5)) cube(1);')).toBe(true);
    expect(await uses('translate(5 * TOP) cube(1);')).toBe(true);
    expect(await uses('x = EDGES_ALL;\ncube(1);')).toBe(true);
  });

  it('a built-in BOSL2 redefines counts only with BOSL2’s own arguments', async () => {
    expect(await uses('cube(10, anchor = TOP);')).toBe(true);
    expect(await uses('cube(10, true, CENTER);')).toBe(true);
    expect(await uses('cylinder(h = 10, r = 2, spin = 45);')).toBe(true);
    expect(await uses('scale([1, 2, 1], cp = [1, 0, 0]) cube(1);')).toBe(true);
    expect(await uses('cube([1, 2, 3], true);')).toBe(false);
  });

  it('follows the file’s own modules, functions and variables', async () => {
    const lib = 'module part() { cuboid(5, rounding = 1); }\nmodule plain() { cube(5); }\nfunction w() = fwd(2);\nh = 3;\n';
    expect(await uses(`${lib}part();`)).toBe(true);
    expect(await uses(`${lib}plain();`)).toBe(false);
    expect(await uses(`${lib}translate(w()) cube(1);`)).toBe(true);
    expect(await uses(`${lib}translate([h, 0, 0]) cube(1);`)).toBe(false);
  });

  it('top-level assignments are evaluated even when nothing reads them', async () => {
    expect(await uses('unused = up(3);\ncube(1);')).toBe(true);
  });

  it('a name the file defines itself shadows BOSL2’s', async () => {
    expect(await uses('module cuboid(s) { cube(s); }\ncuboid(4);')).toBe(false);
    expect(await uses('TOP = [0, 0, 1];\ntranslate(TOP) cube(1);')).toBe(false);
  });

  it('parameters and loop variables are not BOSL2 names', async () => {
    expect(await uses('module m(TOP) { translate(TOP) cube(1); }\nm([0, 0, 1]);')).toBe(false);
    expect(await uses('for (UP = [1, 2]) translate([UP, 0, 0]) cube(1);')).toBe(false);
  });

  it('the drill-in scope wrapper is followed like any module', async () => {
    const src = 'module bracket(w = 2) { cuboid(w); }\nmodule __scadstudio_scope_1(w = 2) {\ncube(w);\n}\n__scadstudio_scope_1(3);';
    expect(await uses(src)).toBe(false);
  });
});

describe('withoutUnusedBosl2', () => {
  it('blanks the BOSL2 directives, keeping line numbers', async () => {
    const src = `${INC}include <BOSL2/screws.scad>\nuse <parts.scad>\ncube(10);`;
    const out = withoutUnusedBosl2(src, await parse(src), names);
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out).not.toMatch(/BOSL2/);
    expect(out).toMatch(/use <parts\.scad>/);
  });

  it('leaves a render that uses BOSL2 alone', async () => {
    const src = `${INC}cuboid(10, rounding = 1);`;
    expect(withoutUnusedBosl2(src, await parse(src), names)).toBe(src);
  });
});
