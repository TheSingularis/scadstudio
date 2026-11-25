// Jordan's rack mount (test/fixtures/rack_mount_single_keystone.scad):
// everything is built inside one module, switch_mount(), out of modules
// defined inside it, and called once at the end through
// `if ($preview) { <posed> } else { <the part> }`. Drilled in through that
// if, the module and its computed translate, each part's isolated render
// must land where OpenSCAD's own full render puts it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/main/engine';
import { Matrix4, type BufferGeometry } from 'three';
import { applyNodeTransform, bbox, parseStl } from '../helpers/stl';
import { docOf, resolverFor } from '../helpers/drill';
import { buildSceneGraph } from '../../src/renderer/src/sceneGraph';
import { guardInactive, isolatedRender, partPath, resolveFocus, topLevelSet, type FocusEntry, type SourceDoc, type WorkingSet } from '../../src/renderer/src/drillIn';

const RACK = readFileSync(new URL('../fixtures/rack_mount_single_keystone.scad', import.meta.url), 'utf8');

async function renderDirect(source: string): Promise<Uint8Array | null> {
  const instance = await createEngine({ print: () => {}, printErr: () => {} });
  instance.FS.writeFile('/input.scad', source);
  const code = instance.callMain(['/input.scad', '-o', '/output.stl', '--backend=Manifold']);
  if (code !== 0) return null;
  return instance.FS.readFile('/output.stl') as Uint8Array;
}

async function focusAt(doc: SourceDoc, path: number[]) {
  const resolve = resolverFor(doc);
  let focus: FocusEntry[] = [];
  for (const index of path) {
    const r = resolveFocus(doc, focus, resolve);
    focus = [...r.focus, { index, siblings: r.sets[r.sets.length - 1].fingerprints }];
  }
  return resolveFocus(doc, focus, resolve);
}

/** Each node's isolated render placed in the world (null: renders nothing). */
async function placedNodes(doc: SourceDoc, set: WorkingSet): Promise<(BufferGeometry | null)[]> {
  const context = buildSceneGraph(doc.tree, doc.text).context;
  const out: (BufferGeometry | null)[] = [];
  for (const node of set.nodes) {
    if (guardInactive(set.guards[node.index] ?? null)) {
      out.push(null);
      continue;
    }
    const job = isolatedRender(set, node, context);
    const bytes = (await renderDirect(job.source)) ?? (await renderDirect(job.flatSource));
    out.push(bytes ? applyNodeTransform(parseStl(bytes), job.transform).applyMatrix4(new Matrix4().fromArray(set.frame)) : null);
  }
  return out;
}

function union(boxes: { min: number[]; max: number[] }[]) {
  return {
    min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))),
    max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))),
  };
}

function expectBoxClose(a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) {
  for (let i = 0; i < 3; i++) {
    expect(a.min[i], `min[${i}]`).toBeCloseTo(b.min[i], 2);
    expect(a.max[i], `max[${i}]`).toBeCloseTo(b.max[i], 2);
  }
}

describe('a module-heavy file: the rack mount fixture', () => {
  it('"Show parts" lands on the body and the keystone, which together are the full part', async () => {
    const doc = await docOf(RACK);
    const path = partPath(topLevelSet(doc), 0, resolverFor(doc));
    const r = await focusAt(doc, path);
    const set = r.sets[r.sets.length - 1];
    const placed = await placedNodes(doc, set);
    expect(placed.every((g) => g !== null)).toBe(true);
    const full = await renderDirect(RACK);
    expect(full).not.toBeNull();
    expectBoxClose(union(placed.map((g) => bbox(g!))), bbox(parseStl(full!)));
    // The keystone sits on the left, at the edge of the full part's box.
    const keystone = bbox(placed[1]!);
    expect(keystone.max[0]).toBeLessThan(bbox(placed[0]!).max[0]);
  }, 180_000);

  it('the body and every cutter inside the difference render; the false front_wire_holes one is empty', async () => {
    const doc = await docOf(RACK);
    const difference = (await focusAt(doc, [0, 1, 0, 0])).sets[4];
    const [body] = await placedNodes(doc, { ...difference, nodes: [difference.nodes[0]] });
    expect(body).not.toBeNull();
    const cutters = await placedNodes(doc, (await focusAt(doc, [0, 1, 0, 0, 1])).sets[5]);
    expect(cutters.map((g) => g !== null)).toEqual([true, true, true, false, true, true]);
    // The switch cutout is centred in the chassis, inside the body's box.
    const b = bbox(body!);
    const cut = bbox(cutters[0]!);
    for (const i of [0, 1]) {
      expect(cut.min[i]).toBeGreaterThan(b.min[i]);
      expect(cut.max[i]).toBeLessThan(b.max[i]);
    }

    // Inside main_body() (a module defined inside switch_mount), its one
    // union renders exactly where main_body() did one level up.
    const inside = (await focusAt(doc, [0, 1, 0, 0, 0])).sets[5];
    const [own] = await placedNodes(doc, inside);
    expectBoxClose(bbox(own!), b);
  }, 300_000);
});
