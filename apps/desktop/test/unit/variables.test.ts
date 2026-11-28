import { describe, expect, it } from 'vitest';
import {
  deleteVariable,
  insertVariable,
  makeVariable,
  moduleAt,
  nameAvailable,
  readModuleVariables,
  parseAnnotation,
  readVariables,
  renameVariable,
  uniqueName,
  variableReferences,
} from '../../src/renderer/src/variables';
import { expectCleanParse, parse } from '../helpers/parse';

const CUSTOMIZER = `use <lib.scad>

// Width of the base
width = 30; // [10:100]
/* [Holes] */
hole_d = 3; // [1:0.5:10]
style = "round"; // [round:Round, square:Square]
count = 4; // [2, 4, 6]
label = "abc"; // 8
derived = width * 2;
/* [Hidden] */
secret = 1;
module part() { cube(width); }
after = 5;
part();
`;

describe('M11 variables: reading', () => {
  it('reads values, descriptions, Customizer annotations and groups', async () => {
    const tree = await parse(CUSTOMIZER);
    const vars = readVariables(tree.rootNode);
    expect(vars.map((v) => v.name)).toEqual(['width', 'hole_d', 'style', 'count', 'label', 'derived', 'secret', 'after']);
    const by = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(by.width.description).toBe('Width of the base');
    expect(by.width.annotation).toEqual({ kind: 'slider', min: 10, step: null, max: 100 });
    expect(by.width.group).toBe('Parameters');
    expect(by.hole_d.annotation).toEqual({ kind: 'slider', min: 1, step: 0.5, max: 10 });
    expect(by.hole_d.group).toBe('Holes');
    // A trailing annotation on the line above is not a description.
    expect(by.style.description).toBeNull();
    expect(by.style.annotation).toEqual({ kind: 'choice', options: [{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }] });
    expect(by.count.annotation).toEqual({ kind: 'choice', options: ['2', '4', '6'].map((v) => ({ value: v, label: v })) });
    expect(by.label.annotation).toEqual({ kind: 'maxLength', length: 8 });
    expect(by.derived.display).toBe('60');
    expect(by.derived.literal).toBe(false);
    expect(by.derived.inCustomizer).toBe(false);
    expect(by.width.inCustomizer).toBe(true);
    expect(by.secret.hidden).toBe(true);
    expect(by.secret.inCustomizer).toBe(false);
    // After the first module with a { } body: not in the Customizer.
    expect(by.after.inCustomizer).toBe(false);
    expect(by.width.uses.length).toBe(2); // derived, and cube(width) in part()
  });

  it('parses the slider-with-max form and ignores unsupported ones', () => {
    expect(parseAnnotation('// [50]')).toEqual({ kind: 'slider', min: 0, step: null, max: 50 });
    expect(parseAnnotation('// [::non-negative integer]')).toBeNull();
    expect(parseAnnotation('// just a note')).toBeNull();
  });

  it('does not count a shadowing parameter, loop variable, argument name or call name as a use', async () => {
    const tree = await parse(`w = 5;\nmodule m(w = 2) { cube(w); }\nfor (w = [1:2]) cube(w);\nfunction f(w) = w;\ncube(size = w);\nm(w = 3);\nlet_v = let (w = 1) w;\n`);
    const refs = variableReferences(tree.rootNode, 'w');
    expect(refs.map((r) => r.startPosition.row)).toEqual([4]);
  });

  it('marks a name assigned twice', async () => {
    const tree = await parse('a = 1;\na = 2;\ncube(a);\n');
    expect(readVariables(tree.rootNode).map((v) => v.reassigned)).toEqual([true, true]);
  });
});

describe('M11 variables: editing', () => {
  it('inserts into the existing variables block, after an annotation', async () => {
    const src = 'use <x.scad>\n\na = 1; // [0:10]\nb = 2;\n\ncube(a);\n';
    const next = insertVariable(src, (await parse(src)).rootNode, 'gap', '5');
    expect(next).toBe('use <x.scad>\n\na = 1; // [0:10]\nb = 2;\ngap = 5;\n\ncube(a);\n');
    await expectCleanParse(next);
  });

  it('starts a block after use/include, or at the top, with a blank line before the geometry', async () => {
    const withUse = 'use <x.scad>\ncube(1);\n';
    expect(insertVariable(withUse, (await parse(withUse)).rootNode, 'gap', '5')).toBe('use <x.scad>\n\ngap = 5;\ncube(1);\n'.replace('gap = 5;\ncube', 'gap = 5;\n\ncube'));
    const bare = 'cube(1);\n';
    expect(insertVariable(bare, (await parse(bare)).rootNode, 'gap', '5')).toBe('gap = 5;\n\ncube(1);\n');
    const titled = '// My part\n// v2\ncube(1);\n';
    expect(insertVariable(titled, (await parse(titled)).rootNode, 'gap', '5')).toBe('// My part\n// v2\n\ngap = 5;\n\ncube(1);\n');
  });

  it('makes a variable from an argument value', async () => {
    const src = 'cube([30, 20, 10]);\n';
    const tree = await parse(src);
    const start = src.indexOf('30');
    const next = makeVariable(src, tree.rootNode, { start, end: start + 2 }, 'width');
    expect(next).toBe('width = 30;\n\ncube([width, 20, 10]);\n');
    const parsed = await expectCleanParse(next);
    expect(readVariables(parsed.tree.rootNode)[0].uses).toHaveLength(1);
  });

  it('renames a variable and its uses, not shadowing names', async () => {
    const src = 'w = 5;\nmodule m(w = 2) { cube(w); }\ncube(w + 1);\nx = w * 2;\n';
    const next = renameVariable(src, (await parse(src)).rootNode, 'w', 'width');
    expect(next).toBe('width = 5;\nmodule m(w = 2) { cube(w); }\ncube(width + 1);\nx = width * 2;\n');
  });

  it('deletes an unused variable line, and inlines a used one only when asked', async () => {
    const src = '// the gap\ngap = 2 + 1; // [0:10]\nw = 3;\ncube(w * gap);\n';
    const tree = await parse(src);
    const gap = readVariables(tree.rootNode).find((v) => v.name === 'gap')!;
    expect(deleteVariable(src, tree.rootNode, gap, false)).toBe(src);
    const inlined = deleteVariable(src, tree.rootNode, gap, true);
    expect(inlined).toBe('w = 3;\ncube(w * (2 + 1));\n');
    await expectCleanParse(inlined);
    const w = readVariables(tree.rootNode).find((v) => v.name === 'w')!;
    const src2 = 'w = 3;\ncube(1);\n';
    const t2 = await parse(src2);
    expect(deleteVariable(src2, t2.rootNode, readVariables(t2.rootNode)[0], false)).toBe('cube(1);\n');
    expect(w.uses).toHaveLength(1);
  });

  it('picks unused names and validates new ones', async () => {
    const tree = await parse('gap = 1;\ngap_2 = 2;\ncube(gap);\n');
    expect(uniqueName(tree.rootNode, 'gap')).toBe('gap_3');
    expect(uniqueName(tree.rootNode, '3d size')).toBe('v_3d_size');
    expect(nameAvailable(tree.rootNode, 'gap')).toBe(false);
    expect(nameAvailable(tree.rootNode, 'for')).toBe(false);
    expect(nameAvailable(tree.rootNode, 'width')).toBe(true);
  });
});

describe('M11 variables: visible scopes', () => {
  const SRC = `w = 10;\nmodule box(size = 5, h) {\n    w = size * 2;\n    gap = 1; // [0:5]\n    if (h) { gap = 3; cube(gap); }\n    translate([gap, 0, 0]) cube([w, size, h]);\n}\nbox(3, 4);\ncube(w);\n`;

  it('reads a module body as its own scope, with its parameters', async () => {
    const tree = await parse(SRC);
    const def = moduleAt(tree.rootNode, SRC.indexOf('gap = 1'))!;
    expect(def.childForFieldName('name')?.text).toBe('box');
    expect(moduleAt(tree.rootNode, SRC.indexOf('box(3'))).toBeNull();
    const m = readModuleVariables(tree.rootNode, def)!;
    expect(m.name).toBe('box');
    expect(m.parameters).toEqual([
      { name: 'size', defaultText: '5', line: 1 },
      { name: 'h', defaultText: null, line: 1 },
    ]);
    expect(m.variables.map((v) => v.name)).toEqual(['w', 'gap']);
    const [w, gap] = m.variables;
    // Reads the parameter: no value to show. Not a Customizer variable.
    expect(w.display).toBeNull();
    expect(w.inCustomizer).toBe(false);
    expect(w.group).toBe('Local');
    expect(gap.display).toBe('1');
    expect(gap.annotation).toEqual({ kind: 'slider', min: 0, step: null, max: 5 });
    // The if block's own gap shadows it there: one use, in translate.
    expect(gap.uses.map((u) => u.line)).toEqual([5]);
    expect(w.uses.map((u) => u.line)).toEqual([5]);
    // The file's w is not read inside box(), which assigns its own.
    expect(readVariables(tree.rootNode)[0].uses.map((u) => u.line)).toEqual([8]);
  });

  it('renames and deletes inside a module without touching the file scope', async () => {
    const tree = await parse(SRC);
    const def = moduleAt(tree.rootNode, SRC.indexOf('gap = 1'))!;
    const body = def.childForFieldName('body')!;
    const renamed = renameVariable(SRC, tree.rootNode, 'w', 'width', body);
    expect(renamed).toContain('w = 10;');
    expect(renamed).toContain('    width = size * 2;');
    expect(renamed).toContain('cube([width, size, h])');
    expect(renamed).toContain('cube(w);');
    await expectCleanParse(renamed);
    const gap = readModuleVariables(tree.rootNode, def)!.variables[1];
    const inlined = deleteVariable(SRC, tree.rootNode, gap, true, body);
    expect(inlined).not.toContain('gap = 1;');
    expect(inlined).toContain('translate([1, 0, 0])');
    expect(inlined).toContain('{ gap = 3; cube(gap); }');
    await expectCleanParse(inlined);
  });
});
