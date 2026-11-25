// M9: working sets one level (or several) deeper — what can be drilled
// into, the frame and scope a drilled-in set renders in, following the
// focus through edits, and inserting into the focused node.
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { docOf, resolverFor } from '../helpers/drill';
import { expectCleanParse } from '../helpers/parse';
import {
  canDrill,
  drillInto,
  frameIsRigid,
  frameToWorld,
  insertIntoContainer,
  isolatedRender,
  resolveFocus,
  topLevelSet,
  worldToFrame,
  type FocusEntry,
  type SourceDoc,
} from '../../src/renderer/src/drillIn';

async function focusAt(text: string, path: number[], libraries: SourceDoc[] = []) {
  const doc = await docOf(text);
  const resolve = resolverFor(doc, libraries);
  let focus: FocusEntry[] = [];
  for (const index of path) {
    const r = resolveFocus(doc, focus, resolve);
    focus = [...r.focus, { index, siblings: r.sets[r.sets.length - 1].fingerprints }];
  }
  return { doc, resolve, resolved: resolveFocus(doc, focus, resolve) };
}

const nodeTexts = (set: { doc: SourceDoc; nodes: { startIndex: number; endIndex: number }[] }) =>
  set.nodes.map((n) => set.doc.text.slice(n.startIndex, n.endIndex));

describe('drillInto (M9)', () => {
  it('booleans, blocks, extrusions and document modules can be drilled into; leaves, loops and unknown calls cannot', async () => {
    const text = [
      'module m(s=1) { cube(s); sphere(s); }',
      'cube(1);',
      'difference() { cube(2); sphere(1); }',
      '{ cube(1); }',
      'linear_extrude(3) circle(2);',
      'm(2);',
      'for (i = [0:2]) cube(i);',
      'unknown_module(3);',
      'translate([1, 0, 0]) rotate([0, 0, 9]) union() { cube(1); }',
      '',
    ].join('\n');
    const doc = await docOf(text);
    const set = topLevelSet(doc);
    const resolve = resolverFor(doc);
    expect(set.nodes.map((_, i) => canDrill(set, i, resolve))).toEqual([false, true, true, true, true, false, false, true]);
    expect(set.nodes.map((_, i) => drillInto(set, i, resolve)?.label ?? null)).toEqual([
      null,
      'Difference #2',
      'Group #3',
      'Linear extrude #4',
      'm() #5',
      null,
      null,
      'Union #8',
    ]);
    expect(nodeTexts(drillInto(set, 1, resolve)!.set)).toEqual(['cube(2);', 'sphere(1);']);
    expect(nodeTexts(drillInto(set, 4, resolve)!.set)).toEqual(['cube(s);', 'sphere(s);']);
    expect(drillInto(set, 4, resolve)!.set.editingModule).toBe('m');
  });

  it("frames compose the statement's own placement and literal transform calls", async () => {
    const { resolved } = await focusAt('translate([1, 2, 3]) rotate([0, 0, 90]) translate([5, 0, 0]) { cube(1); }\n', [0]);
    const set = resolved.sets[1];
    expect(set.bakedPrefix).toBe('');
    // (1,2,3) + Rz(90)·(5,0,0) = (1, 7, 3)
    const origin = new Vector3().applyMatrix4(new Matrix4().fromArray(set.frame));
    expect(origin.toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 7, 3]);
    expect(frameIsRigid(set.frame)).toBe(true);
  });

  it('a mirrored or scaled frame is not rigid (no sketch planes in it)', async () => {
    expect(frameIsRigid((await focusAt('mirror([1, 0, 0]) union() { cube(1); }\n', [0])).resolved.sets[1].frame)).toBe(false);
    expect(frameIsRigid((await focusAt('scale([2, 1, 1]) union() { cube(1); }\n', [0])).resolved.sets[1].frame)).toBe(false);
  });

  it('a non-literal transform becomes baked text, and so does everything below it', async () => {
    const { resolved } = await focusAt('w = 2;\ntranslate([w, 0, 0]) {\n    translate([1, 0, 0]) union() { cube(1); }\n}\n', [0, 0]);
    expect(resolved.sets[1].bakedPrefix).toBe('translate([w, 0, 0]) ');
    expect(resolved.sets[2].bakedPrefix).toBe('translate([w, 0, 0]) translate([1, 0, 0]) ');
    const r = isolatedRender(resolved.sets[2], resolved.sets[2].nodes[0], 'w = 2;');
    expect(r.transformEditable).toBe(false);
    expect(r.source).toContain('translate([w, 0, 0]) translate([1, 0, 0]) {\ncube(1);\n}');
  });

  it("a module body renders inside a copy of the module, called with the instance's own arguments", async () => {
    const { resolved } = await focusAt('module m(a, b=2) { x = a + b; cube(x); }\nm(1, b=5) sphere(1);\n', [0]);
    const set = resolved.sets[1];
    const r = isolatedRender(set, set.nodes[0], 'module m(a, b=2) { x = a + b; cube(x); }');
    expect(r.source).toContain('module __scadstudio_scope_1(a, b=2) {\nx = a + b;\ncube(x);\n}\n__scadstudio_scope_1(1, b=5) sphere(1);');
  });

  it('a module from a library file is view-only; the document module of the same name wins', async () => {
    const lib = await docOf('module peg(d=4) { difference() { cylinder(d=d, h=5); cylinder(d=1, h=5); } }\n', 'library', '/libs/parts.scad');
    const { resolved } = await focusAt('use <parts.scad>\npeg();\n', [0], [lib]);
    expect(resolved.sets[1].readOnly).toEqual({ path: '/libs/parts.scad', moduleName: 'peg' });
    expect(resolved.sets[1].doc).toBe(lib);
    expect(resolved.sets[1].container).toBeNull();
    const shadowed = await focusAt('module peg() { cube(1); }\npeg();\n', [0], [lib]);
    expect(shadowed.resolved.sets[1].readOnly).toBeNull();
  });
});

describe('resolveFocus (M9)', () => {
  it('follows the drilled-into node through an edit above it, and reports leaving a node that is gone', async () => {
    const before = await focusAt('cube(1);\ndifference() { cube(2); sphere(1); }\n', [1]);
    const moved = await docOf('sphere(9);\ncube(1);\ndifference() { cube(2); sphere(1.5); }\n');
    const r = resolveFocus(moved, before.resolved.focus, resolverFor(moved));
    expect(r.lost).toBe(false);
    expect(r.focus[0].index).toBe(2);
    expect(r.crumbs.map((c) => c.label)).toEqual(['Assembly', 'Difference #3']);
    expect(nodeTexts(r.sets[1])).toEqual(['cube(2);', 'sphere(1.5);']);

    const gone = await docOf('cube(1);\n');
    const r2 = resolveFocus(gone, before.resolved.focus, resolverFor(gone));
    expect(r2.lost).toBe(true);
    expect(r2.sets).toHaveLength(1);
  });
});

describe('insertIntoContainer (M9)', () => {
  async function insert(text: string, path: number[], statement = 'sphere(r=5);') {
    const { resolved } = await focusAt(text, path);
    const out = insertIntoContainer(text, resolved.sets[resolved.sets.length - 1].container!, statement);
    await expectCleanParse(out);
    return out;
  }

  it('adds before the closing brace, at the children indentation', async () => {
    expect(await insert('difference() {\n    cube(2);\n}\n', [0])).toBe('difference() {\n    cube(2);\n    sphere(r=5);\n}\n');
    expect(await insert('module m() {\n  union() {\n    cube(2);\n  }\n}\nm();\n', [0, 0])).toBe(
      'module m() {\n  union() {\n    cube(2);\n    sphere(r=5);\n  }\n}\nm();\n',
    );
  });

  it('opens up a one-line block', async () => {
    expect(await insert('union() { cube(2); }\n', [0])).toBe('union() {\n    cube(2);\n    sphere(r=5);\n}\n');
  });

  it("turns a single-statement body into a block", async () => {
    expect(await insert('translate([1, 0, 0]) difference() cube(2);\n', [0])).toBe(
      'translate([1, 0, 0]) difference() {\n    cube(2);\n    sphere(r=5);\n}\n',
    );
  });

  it("adds to a module's own body when drilled into a call of it", async () => {
    expect(await insert('module m() {\n    cube(1);\n}\nm();\n', [0])).toBe('module m() {\n    cube(1);\n    sphere(r=5);\n}\nm();\n');
  });
});

describe('worldToFrame / frameToWorld (M9 sketch planes in a drilled-in frame)', () => {
  it('round-trip a placement', async () => {
    const { resolved } = await focusAt('translate([10, 0, 0]) rotate([0, 0, 90]) union() { cube(1); }\n', [0]);
    const frame = resolved.sets[1].frame;
    const local = worldToFrame(frame, [10, 5, 0], [90, 0, 0]);
    expect(local.origin).toEqual([5, 0, 0]);
    const back = frameToWorld(frame, local.origin, local.rotationDeg);
    expect(back.origin).toEqual([10, 5, 0]);
    expect(back.rotationDeg).toEqual([90, 0, 0]);
  });
});
