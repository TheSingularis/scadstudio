// Regression fixture from a crash report (2026-11-25): a real, module-heavy
// 3D-print model (gag_trophy1.scad) that took the app down on open. The
// crash was the render (see test/integration/gagTrophyRender.test.ts and the
// e2e spec), but the file also exercises renderer-side code paths no other
// fixture does together: a top-level if / else-if chain choosing the part,
// pillow() modules built on children(), function definitions, resize(...,
// auto = true), text(), color() with names and vectors, 2D-only branches.
// Everything the app computes from the text on open, and every drill-in
// reachable from the top level, must work on it without throwing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docOf, resolverFor } from '../helpers/drill';
import { parse, parseWithGraph } from '../helpers/parse';
import { FIXTURES_DIR } from '../helpers/paths';
import {
  canDrill,
  drillInto,
  drillLabel,
  isolatedRender,
  resolveFocus,
  topLevelSet,
  type FocusEntry,
  type WorkingSet,
} from '../../src/renderer/src/drillIn';
import { analyzeSource, toolsFromAnalyzed } from '../../src/renderer/src/moduleIntrospection';

const SOURCE = readFileSync(join(FIXTURES_DIR, 'gag_trophy1.scad'), 'utf8');
// The if / else-if chain can't be drilled into (M9 drills into booleans,
// blocks, extrusions and document modules), so the drill walk starts from
// the same file with each part called directly instead.
const PARTS = ['assembly', 'base', 'plaque', 'blade', 'fob_half', 'mug_half', 'foam', 'head2d', 'foam2d', 'pill2d'];
const DIRECT = SOURCE.slice(0, SOURCE.indexOf('if (part == "assembly")')) + PARTS.map((p) => `${p}();`).join('\n') + '\n';

describe('gag_trophy1.scad regression fixture (crash report 2026-11-25)', () => {
  it('parses cleanly', async () => {
    const { errorCount } = await parseWithGraph(SOURCE);
    expect(errorCount).toBe(0);
  });

  it('the scene graph has the one top-level if / else-if chain as its only node', async () => {
    const { graph } = await parseWithGraph(SOURCE);
    expect(graph.nodes).toHaveLength(1);
    expect(SOURCE.slice(graph.nodes[0].startIndex, graph.nodes[0].endIndex)).toMatch(/^if \(part == "assembly"\) assembly\(\);/);
  });

  it('every document module becomes a Custom tool', async () => {
    const tree = await parse(SOURCE);
    const tools = toolsFromAnalyzed([analyzeSource({ path: null, useDirective: null, tree })]);
    const names = tools.map((t) => t.callName);
    expect(tools.length).toBe(27);
    expect(names).toEqual(expect.arrayContaining(['pillow', 'rrect', 'fob_half', 'mug_half', 'plaque', 'assembly', 'key_assembled']));
  });

  it('every working set reachable by drilling in resolves and builds an isolated render for each node', async () => {
    const doc = await docOf(DIRECT);
    expect(topLevelSet(doc).nodes).toHaveLength(PARTS.length);
    const resolve = resolverFor(doc);
    let visited = 0;
    const walk = (set: WorkingSet, focus: FocusEntry[], depth: number) => {
      visited++;
      for (const node of set.nodes) {
        const job = isolatedRender(set, node, '');
        expect(job.source.length).toBeGreaterThan(0);
        if (depth >= 6 || !canDrill(set, node.index, resolve)) continue;
        expect(drillLabel(set, node.index, resolve)).toBeTruthy();
        const target = drillInto(set, node.index, resolve);
        expect(target).not.toBeNull();
        const next = [...focus, { index: node.index, siblings: set.fingerprints }];
        const r = resolveFocus(doc, next, resolve);
        expect(r.lost).toBe(false);
        walk(r.sets[r.sets.length - 1], next, depth + 1);
      }
    };
    walk(topLevelSet(doc), [], 0);
    expect(visited).toBeGreaterThan(30);
  });
});
