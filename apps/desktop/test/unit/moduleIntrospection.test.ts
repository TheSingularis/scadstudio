// M8: module introspection against the real tree-sitter grammar.
import { describe, expect, it } from 'vitest';
import { parse } from '../helpers/parse';
import {
  buildCustomTools,
  collectCallSites,
  extractModuleDefs,
  extractModuleDefsRecovering,
  formatModuleCall,
  inferParam,
  textShape,
} from '../../src/renderer/src/moduleIntrospection';

describe('M8 extractModuleDefs', () => {
  it('reads names, parameters, defaults, line and the comment above', async () => {
    const tree = await parse(
      'x = 1;\n// A mounting bracket\nmodule bracket(w=20, h=10, thickness=3, holes=true, label="A", offset=[0, 0, 1], n) {\n  cube([w, h, thickness]);\n}\nfunction f(a) = a;\n',
    );
    const [def, ...rest] = extractModuleDefs(tree, null);
    expect(rest).toHaveLength(0);
    expect(def.name).toBe('bracket');
    expect(def.line).toBe(3);
    expect(def.description).toBe('A mounting bracket');
    expect(def.params.map((p) => [p.name, p.defaultText, p.defaultShape])).toEqual([
      ['w', '20', 'number'],
      ['h', '10', 'number'],
      ['thickness', '3', 'number'],
      ['holes', 'true', 'bool'],
      ['label', '"A"', 'string'],
      ['offset', '[0, 0, 1]', 'vec3'],
      ['n', null, null],
    ]);
  });

  it('negative numbers are numbers, expressions and 2-vectors are not literals', async () => {
    const tree = await parse('module m(a=-1.5, b=w*2, c=[1, 2], $fn=16) {}\n');
    expect(extractModuleDefs(tree, null)[0].params.map((p) => [p.name, p.defaultShape])).toEqual([
      ['a', 'number'],
      ['b', 'other'],
      ['c', 'other'],
      ['$fn', 'number'],
    ]);
  });

  it('only top-level modules, and still finds ones a parse error swallowed', async () => {
    const tree = await parse('module outer() { module inner() {} inner(); }\n2d = 3;\nmodule after(s=1) { cube(s); }\n');
    expect(extractModuleDefs(tree, '/lib.scad').map((d) => d.name)).toEqual(['outer', 'after']);
  });

  it('detects parameters used as angles', async () => {
    const tree = await parse('module arm(len=10, a=30, b=5, tilt=0) { rotate([0, 0, a]) translate([sin(b) * len, 0, 0]) cube(len); }\n');
    const def = extractModuleDefs(tree, null)[0];
    expect([...def.angleParams].sort()).toEqual(['a', 'b']);
  });
});

describe('M8 widget inference', () => {
  async function toolParams(src: string, extra = '') {
    const tree = await parse(src + extra);
    const defs = extractModuleDefs(tree, null);
    const sites = collectCallSites([tree], defs);
    return defs[0].params.map((p) => inferParam(defs[0], p, sites));
  }

  it('maps defaults to widgets: bool, number, angle, 3-vector, string, other', async () => {
    const params = await toolParams('module m(on=false, w=2, angle=45, rot=0, v=[1,2,3], s="hi", e=w+1) {}\n');
    expect(params.map((p) => [p.name, p.widget, p.required])).toEqual([
      ['on', 'checkbox', false],
      ['w', 'number', false],
      ['angle', 'angle', false],
      ['rot', 'angle', false],
      ['v', 'xyz', false],
      ['s', 'text', false],
      ['e', 'generic', false],
    ]);
  });

  it('no default: required, widget from the shapes existing calls pass', async () => {
    const params = await toolParams(
      'module m(size, flag, mystery) {}\n',
      'm([1, 2, 3], true);\nm(size=[4, 5, 6], flag=false, mystery=x);\nm(7);\n',
    );
    expect(params.map((p) => [p.name, p.widget, p.required, p.exampleText])).toEqual([
      ['size', 'xyz', true, '[1, 2, 3]'],
      ['flag', 'checkbox', true, 'true'],
      ['mystery', 'generic', true, null],
    ]);
  });

  it('textShape agrees with the CST classification', () => {
    expect(['true', '-2.5', '1e3', '"a\\"b"', '[1, -2, 3.5]', '[1,2]', 'x', '10 + 2'].map(textShape)).toEqual([
      'bool',
      'number',
      'number',
      'string',
      'vec3',
      'other',
      'other',
      'other',
    ]);
  });
});

describe('M8 buildCustomTools', () => {
  it('emits ToolDefinitions with named-argument calls, document first, private names hidden', async () => {
    const doc = await parse('module bracket(w=20, h=10) { cube([w, h, 1]); }\nbracket(30, 15);\n');
    const lib = await parse('module bracket(x=1) {}\nmodule peg(d=3, len) { cylinder(d=d, h=len); }\nmodule _helper() {}\npeg(len=12);\n');
    const nested = await parse('module deep(on=true) {}\n');
    const tools = buildCustomTools([
      { path: null, tree: doc, useDirective: null },
      { path: '/libs/parts.scad', tree: lib, useDirective: null },
      { path: '/libs/deep.scad', tree: nested, useDirective: 'deep.scad' },
    ]);
    expect(tools.map((t) => [t.label, t.statement, t.useDirective, t.origin?.file ?? null])).toEqual([
      ['bracket', 'bracket(w = 20, h = 10);', null, null],
      ['peg', 'peg(d = 3, len = 12);', null, '/libs/parts.scad'],
      ['deep', 'deep(on = true);', 'deep.scad', '/libs/deep.scad'],
    ]);
    expect(tools.every((t) => t.section === 'custom')).toBe(true);
  });

  it('long calls put one argument per line; unknown required values are undef', () => {
    const p = (name: string, defaultText: string | null) => ({ name, defaultText, widget: 'generic' as const, required: defaultText === null, exampleText: null });
    expect(formatModuleCall('m', [p('a', '1'), p('b', null)])).toBe('m(a = 1, b = undef);');
    expect(formatModuleCall('m', [p('a', 'undef'), p('b', '2')])).toBe('m(b = 2);');
    expect(formatModuleCall('m', [p('a', 'undef')])).toBe('m();');
    const long = formatModuleCall('enclosure', ['width', 'depth', 'height', 'wall', 'lid_clearance', 'corner_radius'].map((n) => p(n, '[10, 20, 30]')));
    expect(long).toBe(
      'enclosure(\n    width = [10, 20, 30],\n    depth = [10, 20, 30],\n    height = [10, 20, 30],\n    wall = [10, 20, 30],\n    lid_clearance = [10, 20, 30],\n    corner_radius = [10, 20, 30]\n);',
    );
  });
});

describe('M8 grammar-gap recovery', () => {
  // `assert(...) let(...)` chains in a function body are a real grammar gap
  // (BOSL2's transforms.scad); error recovery swallows what follows.
  const GAP = [
    'module first(a=1) { cube(a); }',
    'function f(v, p) =',
    '    is_string(v) ? (',
    '        assert(is_list(p), "x")',
    '        let(c = v == "a" ? 1 : assert(false, str("bad ", v)))',
    '        f(-c, p=p)',
    '      ) : p;',
    '',
    '// Moves left',
    'module left(x=0) { translate([-x, 0, 0]) children(); }',
    'module right(x=0) { translate([x, 0, 0]) children(); }',
    '',
  ].join('\n');

  it('modules hidden by an error elsewhere are re-read on their own, with their line and comment', async () => {
    const { parseScadSync } = await import('../../src/renderer/src/scadParser');
    const tree = await parse(GAP);
    const plain = extractModuleDefs(tree, null).map((d) => d.name);
    const defs = extractModuleDefsRecovering(tree, GAP, null, parseScadSync);
    expect(defs.map((d) => d.name)).toEqual(['first', 'left', 'right']);
    const left = defs.find((d) => d.name === 'left')!;
    expect([left.line, left.description, left.params.map((p) => p.defaultText)]).toEqual([10, 'Moves left', ['0']]);
    // The point of the recovery: the plain tree misses at least one of them.
    expect(plain.length).toBeLessThan(3);
  });
});

describe('M8 grammar-gap recovery inside a module body', () => {
  it('falls back to the signature alone', async () => {
    const { parseScadSync } = await import('../../src/renderer/src/scadParser');
    const src = 'module cyl(h, r=1, center=false /* (paren) */, s="a)") {\n    d = !x ? 0 :\n      echo("a")\n      echo("b");\n    cylinder(h, r);\n}\n';
    const tree = await parse(src);
    const defs = extractModuleDefsRecovering(tree, src, null, parseScadSync);
    expect(defs.map((d) => [d.name, d.params.map((p) => p.name)])).toEqual([['cyl', ['h', 'r', 'center', 's']]]);
  });
});
