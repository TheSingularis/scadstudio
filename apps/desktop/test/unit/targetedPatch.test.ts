// Patch-engine tests (M4 translate gizmo, M5 full transform set + params,
// M6 modifiers + booleans, M7/M7.5 extrude-the-selection and sketch
// profiles). Every case runs against the real tree-sitter grammar, and every
// edit is re-parsed to prove the result is still valid OpenSCAD that reads
// back to the value that was written (the round-trip PLAN.md asks for).
import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { audit } from '../helpers/audit';
import { expectCleanParse, nodeAt, parse, parseWithGraph } from '../helpers/parse';
import {
  IDENTITY_TRANSFORM,
  decomposeNode,
  formatNumber,
  formatSketchPoints,
  patchArgument,
  patchModifier,
  patchSketchPoints,
  parseColorString,
  patchTransform,
  primitiveArgs,
  primitiveOnlySlice,
  quaternionToRotateDeg,
  readVectorCall,
  readModifier,
  readSketchProfile,
  transformToQuaternion,
  wrapAsThinExtrude,
  wrapInBoolean,
  wrapInExtrude,
  type NodeTransform,
} from '../../src/renderer/src/targetedPatch';

const T = (partial: Partial<NodeTransform>): NodeTransform => ({ ...IDENTITY_TRANSFORM, ...partial });

async function decompose(source: string, index = 0) {
  const { tree, node } = await nodeAt(source, index);
  return decomposeNode(tree.rootNode, node);
}

/** patchTransform, then re-parse and decompose the same node again. */
async function patchAndReread(source: string, transform: NodeTransform, index = 0) {
  const { tree, node } = await nodeAt(source, index);
  const patched = patchTransform(source, tree, node, transform);
  const reparsed = await expectCleanParse(patched);
  const again = reparsed.graph.nodes[index];
  return { patched, reread: decomposeNode(reparsed.tree.rootNode, again)?.transform, reparsed };
}

describe('formatNumber', () => {
  it('rounds float noise from repeated drags to 3 decimals', () => {
    expect(formatNumber(4.999999999)).toBe('5');
    expect(formatNumber(1.23456)).toBe('1.235');
    expect(formatNumber(-0.0004)).toBe('0');
    expect(formatNumber(10)).toBe('10');
  });
});

describe('rotation conventions (M5)', () => {
  it('quaternion round-trips OpenSCAD rotate([x,y,z]) angles', () => {
    for (const deg of [
      [0, 0, 0],
      [90, 0, 0],
      [0, 45, 0],
      [10, 20, 30],
      [-30, 60, 120],
    ] as [number, number, number][]) {
      const back = quaternionToRotateDeg(transformToQuaternion(deg));
      back.forEach((v, i) => expect(v).toBeCloseTo(deg[i], 6));
    }
  });

  it('matches OpenSCAD order Rz·Ry·Rx (X applied first)', () => {
    const composed = transformToQuaternion([0, 0, 30])
      .multiply(transformToQuaternion([0, 20, 0]))
      .multiply(transformToQuaternion([10, 0, 0]));
    const direct = transformToQuaternion([10, 20, 30]);
    expect(Math.abs(direct.dot(composed))).toBeCloseTo(1, 9);
    expect(direct).toBeInstanceOf(Quaternion);
  });
});

describe('decomposeNode (M4/M5)', () => {
  it('reads a bare primitive as identity', async () => {
    const d = await decompose('cube(5);');
    expect(d?.transform).toEqual(IDENTITY_TRANSFORM);
    expect(d?.wrapStart).toBe(0);
    expect(d?.primitiveStart).toBe(0);
  });

  it('reads translate/rotate/mirror/scale chains, folding mirror into scale sign', async () => {
    const d = await decompose('translate([-1.5, 2, 0]) rotate([0,0,45]) mirror([1,0,0]) scale([2,2,2]) cube(1);');
    expect(d?.transform).toEqual(T({ translate: [-1.5, 2, 0], rotateDeg: [0, 0, 45], scale: [-2, 2, 2] }));
  });

  it('reads negative literals (unary minus)', async () => {
    const d = await decompose('translate([-95.406, -1, +2]) cube(1);');
    expect(d?.transform.translate).toEqual([-95.406, -1, 2]);
  });

  it('reads an RGB color wrap', async () => {
    const d = await decompose('color([1, 0.5, 0]) cube(1);');
    expect(d?.transform.color).toEqual([1, 0.5, 0]);
  });

  it('leaves vectors it cannot evaluate alone (stops walking)', async () => {
    const source = 'translate([$t, 0, 0]) cube(1);';
    const d = await decompose(source);
    expect(d?.transform).toEqual(IDENTITY_TRANSFORM);
  });

  it('M11: reads expression components that use top-level variables, keeping their text', async () => {
    const d = await decompose('x = 3;\ngap = 2;\ntranslate([x + gap, 0, 0]) rotate([0, 0, x * 10]) cube(1);');
    expect(d?.transform.translate).toEqual([5, 0, 0]);
    expect(d?.transform.rotateDeg).toEqual([0, 0, 30]);
    expect(d?.transform.exprs).toEqual({ translate: ['x + gap', null, null], rotateDeg: [null, null, 'x * 10'], scale: [null, null, null] });
  });

  it('M11: a module parameter shadows a top-level variable, so that expression is not evaluated', async () => {
    const tree = await parse('w = 100;\nmodule m(w = 5) { translate([w, 0, 0]) cube(1); }\nm();\n');
    const call = tree.rootNode.descendantsOfType('module_instantiation').find((n) => n?.childForFieldName('name')?.text === 'translate')!;
    expect(readVectorCall(call)).toBeNull();
  });

  it('does not treat a diagonal mirror as an axis flip', async () => {
    const d = await decompose('mirror([1,1,0]) cube(1);');
    expect(d?.transform.scale).toEqual([1, 1, 1]);
  });

  it('returns null for non-instantiation statements', async () => {
    const d = await decompose('if (true) cube(1);');
    expect(d).toBeNull();
  });

  it('M11: a for loop is its own primitive, so the gizmo can move it', async () => {
    const source = 'for (i = [0:2]) translate([i*10,0,0]) cube(1);';
    const { tree, node } = await nodeAt(source, 0);
    const d = decomposeNode(tree.rootNode, node)!;
    expect(d.primitiveNode.type).toBe('for_statement');
    expect(d.transform).toEqual(IDENTITY_TRANSFORM);
    const moved = patchTransform(source, tree, node, { ...IDENTITY_TRANSFORM, translate: [5, 0, 0] });
    expect(moved).toBe('translate([5, 0, 0])\n    for (i = [0:2]) translate([i*10,0,0]) cube(1);');
    await expectCleanParse(moved);
  });

  it(audit('H2', 'translate(v) { ... } is not double-applied (block body)'), async () => {
    // Either the wrap is consumed (and the primitive slice excludes it), or
    // it is left in the slice and not recorded in the transform. Today it is
    // both recorded *and* left in the slice, so it renders at 2v.
    const source = 'translate([30,0,0]) { cube(5); }';
    const { tree, node } = await nodeAt(source);
    const d = decomposeNode(tree.rootNode, node)!;
    const slice = primitiveOnlySlice(tree.rootNode, node, source);
    const translateInSlice = slice.includes('translate');
    const translateInTransform = d.transform.translate.some((v) => v !== 0);
    expect(translateInSlice && translateInTransform).toBe(false);
  });

  it(audit('M1', 'stacked same-kind wraps are not overwritten: the inner one stays in the rendered slice'), async () => {
    // The audit allowed folding or falling back; the fix falls back, so the
    // user's own text is never restructured. The outer translate is the
    // editable slot and the inner one renders baked in, so the node still
    // sits at x=3 (decomposition.test.ts checks that against real OpenSCAD).
    const source = 'translate([1,0,0]) translate([2,0,0]) cube(1);';
    const { tree, node } = await nodeAt(source);
    const d = decomposeNode(tree.rootNode, node)!;
    expect(d.transform.translate).toEqual([1, 0, 0]);
    expect(primitiveOnlySlice(tree.rootNode, node, source)).toBe('translate([2,0,0]) cube(1);');
  });

  it(audit('M1', 'a non-canonical rotate() translate() keeps the inner translate in the slice'), async () => {
    const source = 'rotate([0,0,90]) translate([5,0,0]) cube(1);';
    const { tree, node } = await nodeAt(source);
    const d = decomposeNode(tree.rootNode, node)!;
    expect(d.transform.rotateDeg).toEqual([0, 0, 90]);
    expect(d.transform.translate).toEqual([0, 0, 0]);
    expect(primitiveOnlySlice(tree.rootNode, node, source)).toBe('translate([5,0,0]) cube(1);');
  });

  it(audit('M2', 'color([r,g,b,a]) keeps its alpha'), async () => {
    const d = await decompose('color([1,0,0,0.5]) cube(3);');
    expect(d?.transform.color).toHaveLength(4);
  });
});

describe('primitiveOnlySlice (M3 isolated render)', () => {
  it('strips the placement wraps and keeps the primitive verbatim', async () => {
    const source = 'translate([0, 0, 10])\n    cylinder(h=20, r=5, $fn=32);';
    const { tree, node } = await nodeAt(source);
    expect(primitiveOnlySlice(tree.rootNode, node, source)).toBe('cylinder(h=20, r=5, $fn=32);');
  });

  it('keeps a leading modifier out of the slice', async () => {
    const source = '%cube(10);';
    const { tree, node } = await nodeAt(source);
    expect(primitiveOnlySlice(tree.rootNode, node, source)).toBe('cube(10);');
  });

  it('falls back to the whole statement for non-instantiations', async () => {
    const source = 'if (true) cube(1);';
    const { tree, node } = await nodeAt(source);
    expect(primitiveOnlySlice(tree.rootNode, node, source)).toBe(source);
  });
});

describe('patchTransform round-trip (M4 gizmo commit)', () => {
  it('adds a translate to a bare primitive', async () => {
    const { patched, reread } = await patchAndReread('cube(5);', T({ translate: [40, 0, 0] }));
    expect(patched).toBe('translate([40, 0, 0])\n    cube(5);');
    expect(reread?.translate).toEqual([40, 0, 0]);
  });

  it('replaces an existing translate instead of nesting a new one', async () => {
    const { patched } = await patchAndReread('translate([30,0,0]) cube(5);', T({ translate: [40, 0, 0] }));
    expect(patched.match(/translate/g)).toHaveLength(1);
  });

  it('round-trips the full transform set (M5)', async () => {
    const t = T({ translate: [1.5, -2, 3], rotateDeg: [10, 20, 30], scale: [-2, 1, 0.5], color: [0.2, 0.4, 0.6] });
    const { reread } = await patchAndReread('sphere(r=8);', t);
    expect(reread).toEqual(t);
  });

  it('omits identity components entirely', async () => {
    const { patched } = await patchAndReread('translate([1,2,3]) rotate([0,0,90]) cube(1);', T({ translate: [1, 2, 3] }));
    expect(patched).not.toContain('rotate');
    expect(patched).not.toContain('scale');
  });

  it('writes mirror() rather than a negative scale()', async () => {
    const { patched } = await patchAndReread('cube(1);', T({ scale: [-1, 1, 1] }));
    expect(patched).toContain('mirror([1, 0, 0])');
    expect(patched).not.toMatch(/scale\(\[-/);
  });

  it('rounds float noise when writing', async () => {
    const { patched } = await patchAndReread('cube(1);', T({ translate: [4.999999999, 0.1 + 0.2, 0] }));
    expect(patched).toContain('translate([5, 0.3, 0])');
  });

  it('preserves the primitive text, comments and surrounding statements', async () => {
    const source = '// header\na = 1;\ncube(5); // keep me\nsphere(2);\n';
    const { patched } = await patchAndReread(source, T({ translate: [1, 0, 0] }));
    expect(patched).toBe('// header\na = 1;\ntranslate([1, 0, 0])\n    cube(5); // keep me\nsphere(2);\n');
  });

  it('patches the right node in a multi-node file', async () => {
    const source = 'cube(1);\ntranslate([5,0,0]) sphere(1);\ncylinder(h=1, r=1);\n';
    const { patched, reread } = await patchAndReread(source, T({ translate: [9, 0, 0] }), 1);
    expect(reread?.translate).toEqual([9, 0, 0]);
    expect(patched.startsWith('cube(1);\n')).toBe(true);
    expect(patched.endsWith('cylinder(h=1, r=1);\n')).toBe(true);
  });

  it('keeps a modifier through a gizmo drag (M6)', async () => {
    const { patched } = await patchAndReread('#translate([1,2,3]) sphere(r=2);', T({ translate: [4, 5, 6] }));
    expect(patched).toBe('#translate([4, 5, 6])\n    sphere(r=2);');
  });

  it('is stable when the same value is committed twice', async () => {
    const t = T({ translate: [3, 0, 0], rotateDeg: [0, 0, 45] });
    const first = await patchAndReread('cube(1);', t);
    const second = await patchAndReread(first.patched, t);
    expect(second.patched).toBe(first.patched);
  });

  it(audit('H2', 'gizmo commit on translate(v) { ... } does not nest a second translate'), async () => {
    const { patched } = await patchAndReread('translate([30,0,0]) { cube(5); }', T({ translate: [40, 0, 0] }));
    expect(patched.match(/translate/g)).toHaveLength(1);
  });

  it(audit('M1', 'gizmo commit on stacked translates keeps the real position'), async () => {
    // translate([1,0,0]) translate([2,0,0]) is at x=3; committing an
    // unchanged transform must not move it, and the inner translate stays.
    const source = 'translate([1,0,0]) translate([2,0,0]) cube(1);';
    const before = await decompose(source);
    const { patched, reread } = await patchAndReread(source, before!.transform);
    expect(reread?.translate).toEqual([1, 0, 0]);
    expect(patched).toMatch(/translate\(\[1, 0, 0\]\)\s+translate\(\[2,0,0\]\) cube\(1\);/);
  });

  it(audit('M2', 'mirroring a color([r,g,b,a]) node keeps the alpha in the file'), async () => {
    const source = 'color([1,0,0,0.5]) cube(3);';
    const before = await decompose(source);
    const { patched } = await patchAndReread(source, { ...before!.transform, scale: [-1, 1, 1] });
    expect(patched).toContain('0.5');
  });
});

describe('modifiers (M6)', () => {
  it('reads each modifier character', async () => {
    for (const m of ['#', '%', '!', '*'] as const) {
      const { tree, node } = await nodeAt(`${m}cube(1);`);
      expect(readModifier(tree.rootNode, node)).toBe(m);
    }
  });

  it('adds, replaces and toggles off', async () => {
    const add = await nodeAt('translate([1,0,0]) cube(1);');
    const added = patchModifier(add.source, add.tree, add.node, '#');
    expect(added).toBe('#translate([1,0,0]) cube(1);');

    const rep = await nodeAt(added);
    const replaced = patchModifier(rep.source, rep.tree, rep.node, '%');
    expect(replaced).toBe('%translate([1,0,0]) cube(1);');

    const tog = await nodeAt(replaced);
    expect(patchModifier(tog.source, tog.tree, tog.node, '%')).toBe('translate([1,0,0]) cube(1);');
    await expectCleanParse(added);
    await expectCleanParse(replaced);
  });
});

describe('parameter panel (M5)', () => {
  it('lists positional and named args with byte ranges', async () => {
    const { tree, node, source } = await nodeAt('translate([1,0,0]) cube([20,20,20], center=true);');
    const result = primitiveArgs(tree.rootNode, node)!;
    expect(result.callName).toBe('cube');
    expect(result.args.map((a) => [a.name, a.valueText])).toEqual([
      [null, '[20,20,20]'],
      ['center', 'true'],
    ]);
    for (const a of result.args) expect(source.slice(a.valueStart, a.valueEnd)).toBe(a.valueText);
  });

  it('handles a zero-arg call', async () => {
    const { tree, node } = await nodeAt('sphere();');
    expect(primitiveArgs(tree.rootNode, node)).toEqual({ callName: 'sphere', args: [], closeParen: 7 });
  });

  it('patches one argument and leaves everything else byte-identical', async () => {
    const { tree, node, source } = await nodeAt('cylinder(h=20, r=5, $fn=32); // c');
    const patched = patchArgument(source, tree, node, 1, 'r * 2');
    expect(patched).toBe('cylinder(h=20, r=r * 2, $fn=32); // c');
    await expectCleanParse(patched);
  });

  it('is a no-op for an out-of-range argument', async () => {
    const { tree, node, source } = await nodeAt('cube(1);');
    expect(patchArgument(source, tree, node, 5, '2')).toBe(source);
  });

  it(audit('H2', 'parameter panel shows the primitive args, not the brace-body translate'), async () => {
    const { tree, node } = await nodeAt('translate([30,0,0]) { cube(5); }');
    expect(primitiveArgs(tree.rootNode, node)?.callName).toBe('cube');
  });
});

describe('wrapInBoolean (M6)', () => {
  const source = 'cube(10);\nsphere(6);\ncylinder(h=2, r=1);\n';

  it('wraps in selection order and places the block at the earliest node', async () => {
    const p = await parseWithGraph(source);
    const [a, b] = p.graph.nodes;
    const out = wrapInBoolean(source, [b, a], 'difference');
    expect(out).toBe('difference() {\n    sphere(6);\n    cube(10);\n}\ncylinder(h=2, r=1);\n');
    const re = await expectCleanParse(out);
    expect(re.graph.nodes).toHaveLength(2);
  });

  it('handles non-adjacent nodes and leaves unselected ones in place', async () => {
    const p = await parseWithGraph(source);
    const [a, , c] = p.graph.nodes;
    const out = wrapInBoolean(source, [a, c], 'union');
    expect(out).toBe('union() {\n    cube(10);\n    cylinder(h=2, r=1);\n}\nsphere(6);\n');
    await expectCleanParse(out);
  });

  it('needs at least two nodes', async () => {
    const p = await parseWithGraph(source);
    expect(wrapInBoolean(source, [p.graph.nodes[0]], 'intersection')).toBe(source);
  });

  it(audit('L1', 'trailing same-line comments stay with their statement'), async () => {
    const src = 'cube(5); // base\nsphere(3); // tool\n';
    const p = await parseWithGraph(src);
    const out = wrapInBoolean(src, p.graph.nodes, 'difference');
    expect(out).toMatch(/cube\(5\);\s*\/\/ base/);
    expect(out).toMatch(/sphere\(3\);\s*\/\/ tool/);
  });
});

describe('extrusions (M7 / M7.5 extrude-the-selection)', () => {
  it('wraps a bare 2D shape in place', async () => {
    const { tree, node, source } = await nodeAt('circle(r=5);\n');
    const out = wrapInExtrude(source, tree.rootNode, node, 'linear_extrude');
    expect(out).toBe('linear_extrude(height=10) {\n    circle(r=5);\n}\n');
    await expectCleanParse(out);
  });

  it('keeps the placement wrap outside the extrude', async () => {
    const { tree, node, source } = await nodeAt('translate([5,0,0]) rotate([90,0,0]) square(2);');
    const out = wrapInExtrude(source, tree.rootNode, node, 'rotate_extrude');
    expect(out).toBe('translate([5, 0, 0])\n    rotate([90, 0, 0])\n    rotate_extrude($fn=48) {\n    square(2);\n}');
    const re = await expectCleanParse(out);
    const d = decomposeNode(re.tree.rootNode, re.graph.nodes[0]);
    expect(d?.transform.translate).toEqual([5, 0, 0]);
    expect(d?.transform.rotateDeg).toEqual([90, 0, 0]);
  });

  it('wrapAsThinExtrude keeps context outside the synthetic block', () => {
    const out = wrapAsThinExtrude('module m() { square(1); }', 'm();');
    expect(out).toBe('module m() { square(1); }\nlinear_extrude(height=0.01) {\nm();\n}');
  });
});

describe('sketch profiles (M7.5 on-plane editing)', () => {
  it('reads a committed sketch polygon with its plane', async () => {
    const source = 'translate([0, 0, 5]) rotate([90, 0, 0]) polygon(points=[[0, 0], [10, 0], [10, -5]]);';
    const { tree, node } = await nodeAt(source);
    const profile = readSketchProfile(tree.rootNode, node)!;
    expect(profile.origin).toEqual([0, 0, 5]);
    expect(profile.rotationDeg).toEqual([90, 0, 0]);
    expect(profile.loops).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, -5],
      ],
    ]);
    expect(profile.pathsRange).toBeNull();
    expect(source.slice(profile.pointsStart, profile.pointsEnd)).toBe('[[0, 0], [10, 0], [10, -5]]');
  });

  it('reads a sketch under linear_extrude, positional points too', async () => {
    const source = 'linear_extrude(height=10) {\n    polygon([[0,0],[1,0],[0,1]]);\n}';
    const { tree, node } = await nodeAt(source);
    expect(readSketchProfile(tree.rootNode, node)?.loops[0]).toHaveLength(3);
  });

  it('refuses shapes it cannot round-trip exactly', async () => {
    for (const source of [
      'polygon(points=[[0,0],[1,0]]);', // < 3 points
      'p = 1;\npolygon(points=[[p,0],[1,0],[0,1]]);', // non-literal
      'scale([2,2,2]) polygon(points=[[0,0],[1,0],[0,1]]);', // scaled
      'rotate_extrude() polygon(points=[[1,0],[2,0],[2,1]]);', // revolved
      'linear_extrude(height=1) { polygon([[0,0],[1,0],[0,1]]); square(1); }', // two children
      'square(1);',
    ]) {
      const { tree, node } = await nodeAt(source, 0);
      expect(readSketchProfile(tree.rootNode, node), source).toBeNull();
    }
  });

  it('save rewrites only the points vector', async () => {
    const source = '#color([1,0,0]) translate([1,0,0]) polygon(points=[[0,0],[1,0],[0,1]], paths=undef); // s';
    const { tree, node } = await nodeAt(source);
    const profile = readSketchProfile(tree.rootNode, node)!;
    const out = patchSketchPoints(source, profile, [
      [
        [0, 0],
        [2.0000001, 0],
        [2, 2],
        [0, 2],
      ],
    ]);
    expect(out).toBe('#color([1,0,0]) translate([1,0,0]) polygon(points=[[0, 0], [2, 0], [2, 2], [0, 2]], paths=undef); // s');
    await expectCleanParse(out);
  });

  it('formatSketchPoints rounds like formatNumber', () => {
    expect(formatSketchPoints([[0.1 + 0.2, -1.00001]])).toBe('[[0.3, -1]]');
  });
});

describe('brace-body wraps and color alpha (audit H2 / M2 follow-ups)', () => {
  it(audit('H2', 'a gizmo commit back to identity leaves a valid bare block'), async () => {
    const { patched } = await patchAndReread('translate([30,0,0]) { cube(5); }', T({}));
    expect(patched).toBe('{ cube(5); }');
  });

  it(audit('H2', 'a bare top-level block can be moved again'), async () => {
    const { patched, reread } = await patchAndReread('{ cube(5); }', T({ translate: [1, 2, 3] }));
    expect(patched).toBe('translate([1, 2, 3]) { cube(5); }');
    expect(reread?.translate).toEqual([1, 2, 3]);
  });

  it(audit('H2', 'a modifier on a brace body survives a commit to identity'), async () => {
    const { patched } = await patchAndReread('#translate([3,0,0]) { cube(5); sphere(2); }', T({}));
    expect(patched).toBe('#union() { cube(5); sphere(2); }');
  });

  it(audit('M2', 'a color() with four components outside other wraps is read'), async () => {
    const d = await decompose('color([0,1,0,0.25]) translate([1,0,0]) cube(1);');
    expect(d?.transform.color).toEqual([0, 1, 0, 0.25]);
    expect(d?.transform.translate).toEqual([1, 0, 0]);
  });

  it('a five-component vector is not mistaken for a color', async () => {
    const d = await decompose('color([1,0,0,0.5,9]) cube(1);');
    expect(d?.transform.color).toBeNull();
  });
});

describe('M11 expression components through patchTransform', () => {
  const ctx = 'w = 10;\ngap = 2;\n';
  async function commit(statement: string, change: (t: NodeTransform) => NodeTransform) {
    const source = `${ctx}${statement}`;
    const { tree, node } = await nodeAt(source, 0);
    const current = decomposeNode(tree.rootNode, node)!.transform;
    const next = patchTransform(source, tree, node, change(current));
    await expectCleanParse(next);
    return next.slice(ctx.length);
  }

  it('a gizmo drag (no exprs passed) moves the literal axes and keeps the expression text', async () => {
    const out = await commit('translate([w + gap, 0, 5]) cube(1);', (t) => ({ ...t, exprs: undefined, translate: [99, 3, 7] }));
    expect(out).toBe('translate([w + gap, 3, 7])\n    cube(1);');
  });

  it('keeps a wrap whose expression comes to the identity value', async () => {
    const out = await commit('translate([gap - 2, 0, 0]) rotate([0, 0, w - 10]) cube(1);', (t) => ({ ...t, exprs: undefined }));
    expect(out).toBe('translate([gap - 2, 0, 0])\n    rotate([0, 0, w - 10])\n    cube(1);');
  });

  it('explicit exprs set an expression on a literal axis, or detach one back to a number', async () => {
    const set = await commit('translate([3, 0, 0]) cube(1);', (t) => ({
      ...t,
      translate: [12, 0, 0],
      exprs: { translate: ['w + gap', null, null], rotateDeg: [null, null, null], scale: [null, null, null] },
    }));
    expect(set).toBe('translate([w + gap, 0, 0])\n    cube(1);');
    const detached = await commit('translate([w + gap, 0, 0]) cube(1);', (t) => ({
      ...t,
      exprs: { translate: [null, null, null], rotateDeg: [null, null, null], scale: [null, null, null] },
    }));
    expect(detached).toBe('translate([12, 0, 0])\n    cube(1);');
  });

  it('mirroring an expression scale writes mirror() and keeps the expression', async () => {
    const out = await commit('scale([w / 5, 1, 1]) cube(1);', (t) => ({ ...t, scale: [-t.scale[0], 1, 1] }));
    expect(out).toBe('mirror([1, 0, 0])\n    scale([w / 5, 1, 1])\n    cube(1);');
  });

  it('an expression color() or mirror() stops the walk (they are rewritten from numbers)', async () => {
    const source = `${ctx}color([w / 10, 0, 0]) translate([1, 0, 0]) cube(1);`;
    const { tree, node } = await nodeAt(source, 0);
    expect(decomposeNode(tree.rootNode, node)!.transform.color).toBeNull();
  });
});

describe('named and hex colors (M10a)', () => {
  it('parses OpenSCAD color names (any case) and hex forms', () => {
    expect(parseColorString('goldenrod')).toEqual([218 / 255, 165 / 255, 32 / 255, null]);
    expect(parseColorString('SaddleBrown')).toEqual([139 / 255, 69 / 255, 19 / 255, null]);
    expect(parseColorString('#f00')).toEqual([1, 0, 0, null]);
    expect(parseColorString('#ff000080')).toEqual([1, 0, 0, 128 / 255]);
    expect(parseColorString('#0f08')).toEqual([0, 1, 0, 136 / 255]);
    expect(parseColorString('not-a-color')).toBeNull();
    expect(parseColorString('#12345')).toBeNull();
  });

  it('reads color("name") and color("#hex", alpha) wraps, so the node takes that color', async () => {
    expect((await decompose('color("goldenrod") cube(1);'))?.transform.color).toEqual([218 / 255, 165 / 255, 32 / 255]);
    const d = await decompose('color("#ff0000", 0.5) translate([1, 0, 0]) cube(1);');
    expect(d?.transform.color).toEqual([1, 0, 0, 0.5]);
    expect(d?.transform.translate).toEqual([1, 0, 0]);
    expect((await decompose('color(c = "red", alpha = 0.25) cube(1);'))?.transform.color).toEqual([1, 0, 0, 0.25]);
  });

  it('leaves what it cannot read in the render: unknown names, variables, alpha given twice', async () => {
    for (const src of ['color("nope") cube(1);', 'color(c) cube(1);', 'color("#ff000080", 0.5) cube(1);', 'color("red", a) cube(1);']) {
      const d = await decompose(`c = "red"; a = 1;\n${src}`, 0);
      expect(d, src).not.toBeNull();
      expect(d!.transform.color, src).toBeNull();
    }
  });

  it('a gizmo edit writes the name back as it was written', async () => {
    const source = 'color("goldenrod") translate([1, 0, 0]) cube(1);';
    const before = await decompose(source);
    const { patched, reread } = await patchAndReread(source, { ...before!.transform, translate: [5, 0, 0] });
    expect(patched).toMatch(/^color\("goldenrod"\)\s+translate\(\[5, 0, 0\]\)\s+cube\(1\);$/);
    expect(reread?.colorText).toBe('"goldenrod"');
  });

  it('a new color from the picker replaces the name with a vector', async () => {
    const source = 'color("goldenrod", 0.5) cube(1);';
    const before = await decompose(source);
    const { patched } = await patchAndReread(source, { ...before!.transform, color: [0, 0, 1, 0.5], colorText: undefined });
    expect(patched).toMatch(/^color\(\[0, 0, 1, 0.5\]\)\s+cube\(1\);$/);
  });
});
