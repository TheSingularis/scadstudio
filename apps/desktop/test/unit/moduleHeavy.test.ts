// Files that build everything inside one module and call it once at the end
// (Jordan's rack mount, test/fixtures/rack_mount_single_keystone.scad):
// `if` statements can be drilled into, modules defined inside another
// module's body resolve by name, `if ($preview) ... else ...` resolves to
// the branch the rendered part takes, and "Show parts" drills straight
// through single-statement levels.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docOf, resolverFor } from '../helpers/drill';
import { expectCleanParse } from '../helpers/parse';
import {
  callDefinition,
  drillInto,
  guardInactive,
  insertIntoContainer,
  isolatedRender,
  partPath,
  resolveFocus,
  staticCondition,
  topLevelSet,
  type FocusEntry,
  type SourceDoc,
} from '../../src/renderer/src/drillIn';

export const RACK = readFileSync(new URL('../fixtures/rack_mount_single_keystone.scad', import.meta.url), 'utf8');

async function focusAt(text: string, path: number[]) {
  const doc = await docOf(text);
  const resolve = resolverFor(doc);
  let focus: FocusEntry[] = [];
  for (const index of path) {
    const r = resolveFocus(doc, focus, resolve);
    focus = [...r.focus, { index, siblings: r.sets[r.sets.length - 1].fingerprints }];
  }
  return { doc, resolve, resolved: resolveFocus(doc, focus, resolve) };
}

const nodeTexts = (set: { doc: SourceDoc; nodes: { startIndex: number; endIndex: number }[] }) =>
  set.nodes.map((n) => set.doc.text.slice(n.startIndex, n.endIndex));

describe('staticCondition', () => {
  it('knows $preview (false when rendering), literals and their negations; nothing else', () => {
    expect(staticCondition('$preview')).toBe(false);
    expect(staticCondition('!$preview')).toBe(true);
    expect(staticCondition('( ! ( $preview ) )')).toBe(true);
    expect(staticCondition('true')).toBe(true);
    expect(staticCondition('false')).toBe(false);
    expect(staticCondition('keystones')).toBeNull();
    expect(staticCondition('$preview && x')).toBeNull();
    expect(staticCondition('($preview) || (x)')).toBeNull();
  });
});

describe('drilling into if statements', () => {
  it('shows both branches, each under its condition; else-if is one drillable statement', async () => {
    const text = 'if (a) { w = 2; cube(w); sphere(1); } else if (b) cylinder(); else { cube(3); }\n';
    const doc = await docOf(text);
    const resolve = resolverFor(doc);
    const target = drillInto(topLevelSet(doc), 0, resolve)!;
    expect(target.label).toBe('If (a) #1');
    expect(nodeTexts(target.set)).toEqual(['cube(w);', 'sphere(1);', 'if (b) cylinder(); else { cube(3); }']);
    expect(target.set.guards.map((g) => [g?.condition, g?.negated, g?.context])).toEqual([
      ['a', false, 'w = 2;'],
      ['a', false, 'w = 2;'],
      ['a', true, ''],
    ]);
    expect(target.set.containerCall).toBe('if');
    const inner = drillInto(target.set, 2, resolve)!;
    expect(nodeTexts(inner.set)).toEqual(['cylinder();', 'cube(3);']);
    // The else-if level renders inside the outer else: `!(a)` around it all.
    const source = isolatedRender(inner.set, inner.set.nodes[1], '').source;
    expect(source).toMatch(/if \(!\(a\)\) __scadstudio_branch_2\(\);/);
    expect(source).toMatch(/if \(!\(b\)\) __scadstudio_branch_node\(\);/);
    await expectCleanParse(source);
  });

  it('an if with no geometry, and a statement with no if, are not drillable as ifs', async () => {
    const doc = await docOf('if (a) x = 1;\ncube(1);\n');
    const set = topLevelSet(doc);
    expect(drillInto(set, 0, resolverFor(doc))).toBeNull();
    expect(set.guards).toEqual([null, null]);
  });

  it('a $preview branch is statically inactive; inserts go into the branch the part takes', async () => {
    const text = 'if ($preview) {\n    rotate([90, 0, 0]) part();\n} else {\n    part();\n}\nmodule part() cube(1);\n';
    const { resolved } = await focusAt(text, [0]);
    const set = resolved.sets[1];
    expect(set.guards.map(guardInactive)).toEqual([true, false]);
    const next = insertIntoContainer(text, set.container!, 'sphere(2);');
    expect(next).toBe('if ($preview) {\n    rotate([90, 0, 0]) part();\n} else {\n    part();\n    sphere(2);\n}\nmodule part() cube(1);\n');
    // The editor keeps the whole if statement in focus, both branches.
    expect(set.container!.focus).toEqual({ start: 0, end: text.indexOf('\nmodule') });
  });

  it('module definitions never end up inside an if block (OpenSCAD rejects that)', async () => {
    const text = 'module outer(s) {\n    if (s > 1) {\n        inner(s);\n    }\n    module inner(k) { cube(k); sphere(k); }\n}\nif (!$preview) outer(2);\n';
    const { resolved } = await focusAt(text, [0, 0, 0, 0]);
    expect(resolved.crumbs.map((c) => c.label)).toEqual(['Assembly', 'If (!$preview) #1', 'outer() #1', 'If (s > 1) #1', 'inner() #1']);
    const set = resolved.sets[4];
    const source = isolatedRender(set, set.nodes[1], '').source;
    // Every guarded body is a module of its own; only the call is inside if.
    for (const m of source.matchAll(/if \(([^)]*\)?)\) (\S+)\(\)/g)) expect(m[2]).toMatch(/^__scadstudio_branch_/);
    expect(source).not.toMatch(/if \([^\n]*\{\s*\n\s*module/);
    await expectCleanParse(source);
  });
});

describe('modules defined inside a module (rack mount fixture)', () => {
  it('resolve by name, drill in, and Go to definition finds them', async () => {
    const { resolved, resolve } = await focusAt(RACK, [0, 1, 0, 0]);
    expect(resolved.crumbs.map((c) => c.label)).toEqual(['Assembly', 'If ($preview) #1', 'switch_mount() #2', 'Group #1', 'Difference #1']);
    const difference = resolved.sets[4];
    expect(nodeTexts(difference).map((t) => t.split('\n')[0])).toEqual(['main_body();', 'union() {']);
    const def = callDefinition(difference, 0, resolve)!;
    expect(def.name).toBe('main_body');
    expect(RACK.slice(def.nameStart, def.nameEnd)).toBe('main_body');
    expect(RACK.slice(def.start, def.start + 20)).toBe('module main_body() {');
    // A built-in has no definition to go to.
    expect(callDefinition(difference, 1, resolve)).toBeNull();

    const body = drillInto(difference, 0, resolve)!;
    expect(body.label).toBe('main_body() #1');
    expect(body.set.editingModule).toBe('main_body');
    expect(body.set.envs[body.set.envs.length - 1].context).toBe('chassis_height = min(switch_height + (2 * case_thickness), height);');
  });

  it('a nested module shadows a top-level one of the same name', async () => {
    const text = 'module m() cube(1);\nmodule outer() {\n    module m() { sphere(1); cylinder(); }\n    m();\n}\nouter();\n';
    const { resolved } = await focusAt(text, [0, 0]);
    expect(nodeTexts(resolved.sets[2])).toEqual(['sphere(1);', 'cylinder();']);
  });

  it('"Show parts" drills through the $preview if, the module and its one translate', async () => {
    const doc = await docOf(RACK);
    const resolve = resolverFor(doc);
    const top = topLevelSet(doc);
    expect(top.nodes).toHaveLength(1);
    const path = partPath(top, 0, resolve);
    expect(path).toEqual([0, 1, 0]);
    const { resolved } = await focusAt(RACK, path);
    expect(resolved.crumbs.map((c) => c.label)).toEqual(['Assembly', 'If ($preview) #1', 'switch_mount() #2', 'Group #1']);
    const parts = resolved.sets[3];
    expect(nodeTexts(parts).map((t) => t.split('\n')[0])).toEqual(['difference() {', 'if (keystones) {']);
    // M11: the translate's vector reads only top-level variables, so it is
    // evaluated (scadExpr.ts) and the frame is a real matrix, not baked text.
    expect(parts.bakedPrefix).toBe('');
    expect(parts.frame[12]).toBeCloseTo(-127);
    // Nothing to show parts of in a leaf.
    expect(partPath(top, 5, resolve)).toEqual([]);
  });

  it('the cutters inside the union: an if (flag) is a node, rendered under its flag', async () => {
    const { resolved } = await focusAt(RACK, [0, 1, 0, 0, 1]);
    const union = resolved.sets[5];
    expect(nodeTexts(union).map((t) => t.split('\n')[0])).toEqual([
      'switch_cutout();',
      'all_rack_holes();',
      'zip_tie_features();',
      'if (front_wire_holes) {',
      'if (air_holes) {',
      'if (keystones) {',
    ]);
    // switch_mount's parameters, locals and nested modules are all in scope,
    // and the whole thing sits inside the else of if ($preview).
    const source = isolatedRender(union, union.nodes[0], '').source;
    expect(source).toContain('module __scadstudio_scope_2(switch_width, switch_height, switch_depth) {');
    expect(source).toContain('module switch_cutout() {');
    expect(source).toContain('cutout_x = chassis_left_x + (chassis_width - cutout_w) / 2;');
    expect(source).toMatch(/if \(!\(\$preview\)\) __scadstudio_branch_2\(\);/);
    expect(source).toContain('__scadstudio_scope_2(component_width, component_height, component_depth);');
    await expectCleanParse(source);
  });
});
