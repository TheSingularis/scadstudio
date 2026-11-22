// Real-world corpus (PLAN.md M0 and Verification): MCAD, OpenSCAD's own
// examples and BOSL2, fetched at pinned commits by fetch-corpus.mjs.
//
// For every file:
//  - parse errors may not exceed the recorded baseline (baseline.json), so a
//    grammar or parser regression fails, and known grammar gaps don't;
//  - every scene-graph reader runs on every top-level node without throwing;
//  - for every node the patch engine can decompose, committing its own
//    transform back (what a no-op gizmo drag does) produces valid source that
//    reads back to the same transform.
//
// Skipped when the corpus hasn't been fetched (run `npm run corpus:fetch`).
// After an intentional change, refresh the baseline with
// `UPDATE_CORPUS_BASELINE=1 npx vitest run test/corpus`.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWithGraph } from '../helpers/parse';
import { DESKTOP_DIR } from '../helpers/paths';
import { decomposeNode, patchTransform, primitiveArgs, readModifier, readSketchProfile } from '../../src/renderer/src/targetedPatch';

const CORPUS_DIR = join(DESKTOP_DIR, 'test/corpus/.cache');
const BASELINE_PATH = join(DESKTOP_DIR, 'test/corpus/baseline.json');
const UPDATE = process.env.UPDATE_CORPUS_BASELINE === '1';

function scadFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? scadFiles(p) : name.endsWith('.scad') ? [p] : [];
  });
}

const files = scadFiles(CORPUS_DIR).sort();
const baseline: Record<string, number> = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

describe.skipIf(files.length === 0)('real-world corpus (M0)', () => {
  const observed: Record<string, number> = {};

  it.each(files.map((f) => [relative(CORPUS_DIR, f), f]))('%s', async (name, file) => {
    const source = readFileSync(file, 'utf8');
    const parsed = await parseWithGraph(source);
    observed[name] = parsed.errorCount;
    if (!UPDATE) expect(parsed.errorCount, 'parse errors vs baseline.json').toBeLessThanOrEqual(baseline[name] ?? 0);

    // The readers and the patch round-trip only mean something on files that
    // parse cleanly; files with grammar gaps are covered by the baseline.
    if (parsed.errorCount > 0) return;
    const root = parsed.tree.rootNode;
    for (const node of parsed.graph.nodes) {
      readModifier(root, node);
      primitiveArgs(root, node);
      readSketchProfile(root, node);
      const d = decomposeNode(root, node);
      if (!d) continue;
      const patched = patchTransform(source, parsed.tree, node, d.transform);
      const again = await parseWithGraph(patched);
      expect(again.errorCount, `identity patch of node ${node.index} (${node.label})`).toBe(0);
      const reread = decomposeNode(again.tree.rootNode, again.graph.nodes[node.index]);
      expect(reread?.transform, `node ${node.index} (${node.label}) reads back`).toEqual(d.transform);
    }
  });

  it('baseline has no stale entries', () => {
    if (UPDATE) {
      const nonZero = Object.fromEntries(Object.entries(observed).filter(([, n]) => n > 0));
      writeFileSync(BASELINE_PATH, `${JSON.stringify(nonZero, null, 2)}\n`);
      return;
    }
    const improved = Object.entries(baseline).filter(([name, n]) => name in observed && observed[name] < n);
    expect(improved, 'files now parse with fewer errors: refresh baseline.json').toEqual([]);
  });
});
