// PLAN.md risk 4: structural-edit codegen (wrap in a boolean, wrap in an
// extrude/offset, insert into a block, rewrite a transform prefix, toggle a
// modifier) is more failure-prone than replacing one value, and M9 runs all
// of it on nested statements at any indentation. These are property-based
// round-trip tests (fast-check): over randomly generated documents (nested
// booleans, blocks, modules, transforms, modifiers, comments, 2-space /
// 4-space / tab indentation), every edit on every working set the drill-in
// can reach must
//   1. produce a document that parses cleanly,
//   2. read back as intended (the transform, the new children, ...), and
//   3. leave everything outside the edited statement byte-for-byte alone.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { docOf, resolverFor } from '../helpers/drill';
import { parse } from '../helpers/parse';
import {
  decomposeNode,
  patchModifier,
  patchTransform,
  readModifier,
  wrapInBoolean,
  wrapInExtrude,
  type BooleanOp,
  type NodeTransform,
} from '../../src/renderer/src/targetedPatch';
import { drillInto, insertIntoContainer, resolveFocus, topLevelSet, type WorkingSet } from '../../src/renderer/src/drillIn';
import { normalizeText } from '../../src/renderer/src/nodeIdentity';

const RUNS = Number(process.env['PROPERTY_RUNS'] ?? 120);

// --- document generator -----------------------------------------------------

type Stmt =
  | { kind: 'leaf'; text: string }
  | { kind: 'wrap'; prefix: string; inner: Stmt }
  | { kind: 'op'; name: string; braces: boolean; children: Stmt[] }
  | { kind: 'block'; children: Stmt[] };

const num = fc.integer({ min: -20, max: 20 });
const pos = fc.integer({ min: 1, max: 9 });
const leaf: fc.Arbitrary<Stmt> = fc.oneof(
  fc.tuple(pos, pos, pos).map(([a, b, c]) => ({ kind: 'leaf' as const, text: `cube([${a}, ${b}, ${c}]);` })),
  pos.map((r) => ({ kind: 'leaf' as const, text: `sphere(r=${r});` })),
  fc.tuple(pos, pos).map(([h, r]) => ({ kind: 'leaf' as const, text: `cylinder(h=${h}, r=${r}, $fn=12);` })),
  pos.map((s) => ({ kind: 'leaf' as const, text: `part(${s});` })),
);
const wrapPrefix = fc.oneof(
  fc.tuple(num, num, num).map(([x, y, z]) => `translate([${x}, ${y}, ${z}]) `),
  fc.tuple(num, num, num).map(([x, y, z]) => `rotate([${x * 9}, ${y * 9}, ${z * 9}]) `),
  fc.constant('mirror([1, 0, 0]) '),
  fc.constant('color([1, 0, 0]) '),
  fc.constant('#'),
  fc.constant('%'),
);

const { stmt } = fc.letrec<{ stmt: Stmt }>((tie) => ({
  stmt: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.tuple(wrapPrefix, tie('stmt')).map(([prefix, inner]) => ({ kind: 'wrap' as const, prefix, inner })),
    fc
      .tuple(fc.constantFrom('union', 'difference', 'intersection', 'hull'), fc.boolean(), fc.array(tie('stmt'), { minLength: 1, maxLength: 3 }))
      .map(([name, braces, children]) => ({ kind: 'op' as const, name, braces: braces || children.length > 1, children: braces || children.length > 1 ? children : children.slice(0, 1) })),
    fc.array(tie('stmt'), { minLength: 1, maxLength: 2 }).map((children) => ({ kind: 'block' as const, children })),
  ),
}));

function render(s: Stmt, indent: string, unit: string, comment: boolean): string {
  const tail = comment ? ' // note' : '';
  switch (s.kind) {
    case 'leaf':
      return `${s.text}${tail}`;
    case 'wrap':
      // A modifier only prefixes a call, never a bare block.
      if ((s.prefix === '#' || s.prefix === '%') && (s.inner.kind === 'block' || s.inner.kind === 'wrap')) return render(s.inner, indent, unit, comment);
      return `${s.prefix}${render(s.inner, indent, unit, comment)}`;
    case 'op':
      if (!s.braces) return `${s.name}() ${render(s.children[0], indent, unit, comment)}`;
      return `${s.name}() {\n${s.children.map((c) => `${indent}${unit}${render(c, indent + unit, unit, false)}`).join('\n')}\n${indent}}`;
    case 'block':
      return `{\n${s.children.map((c) => `${indent}${unit}${render(c, indent + unit, unit, false)}`).join('\n')}\n${indent}}`;
  }
}

const documentArb = fc
  .record({
    top: fc.array(stmt, { minLength: 1, maxLength: 4 }),
    body: fc.array(stmt, { minLength: 1, maxLength: 2 }),
    unit: fc.constantFrom('    ', '  ', '\t'),
    comments: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  })
  .map(({ top, body, unit, comments }) => {
    const moduleDef = `module part(s=2) {\n${body.map((b) => `${unit}${render(b, unit, unit, false)}`).join('\n')}\n}`;
    return `// generated\n${moduleDef}\n\n${top.map((t, i) => render(t, '', unit, comments[i])).join('\n')}\n`;
  });

// --- helpers ------------------------------------------------------------------

async function cleanErrors(text: string): Promise<number> {
  const tree = await parse(text);
  let n = 0;
  const visit = (node: import('web-tree-sitter').Node) => {
    if (node.type === 'ERROR' || node.isMissing) n++;
    for (const c of node.children) if (c) visit(c);
  };
  visit(tree.rootNode);
  return n;
}

interface Reached {
  set: WorkingSet;
  // The drill path from the top level: child indices, one per level.
  path: number[];
}

/** Every working set reachable by drilling (document only), up to `max`, with its path. */
function reachable(doc: Awaited<ReturnType<typeof docOf>>, max = 12): Reached[] {
  const resolve = resolverFor(doc);
  const out: Reached[] = [];
  const queue: Reached[] = [{ set: topLevelSet(doc), path: [] }];
  while (queue.length > 0 && out.length < max) {
    const r = queue.shift()!;
    if (r.set.doc.kind !== 'document') continue;
    out.push(r);
    for (let i = 0; i < r.set.nodes.length; i++) {
      // Bounded so recursion through module calls can't run away.
      const t = drillInto(r.set, i, resolve);
      if (t && out.length + queue.length < max * 2) queue.push({ set: t.set, path: [...r.path, i] });
    }
  }
  return out;
}

function workingSets(_text: string, doc: Awaited<ReturnType<typeof docOf>>, max = 12): WorkingSet[] {
  return reachable(doc, max).map((r) => r.set);
}

const nodeText = (set: WorkingSet, i: number) => set.doc.text.slice(set.nodes[i].startIndex, set.nodes[i].endIndex);

// Outside [start, end) nothing changed: same prefix, same suffix.
function expectOnlyChanged(before: string, after: string, start: number, end: number) {
  expect(after.slice(0, start)).toBe(before.slice(0, start));
  expect(after.slice(after.length - (before.length - end))).toBe(before.slice(end));
}

// The set at the same drill path in a re-parsed document. The edits under
// test only change statements inside the set (or the set's own container
// body), so the path from the top level down to it is still valid.
async function sameSet(text: string, original: WorkingSet, before: Awaited<ReturnType<typeof docOf>>): Promise<WorkingSet | null> {
  const key = (w: WorkingSet) => `${w.container?.statementStart ?? -1}|${w.nodes.map((n) => `${n.startIndex}-${n.endIndex}`).join(',')}`;
  const found = reachable(before, 40).find((r) => key(r.set) === key(original));
  if (!found) return null;
  const doc = await docOf(text);
  const resolve = resolverFor(doc);
  let set: WorkingSet = topLevelSet(doc);
  for (const i of found.path) {
    const t = drillInto(set, i, resolve);
    if (!t) return null;
    set = t.set;
  }
  return set;
}

// --- properties -----------------------------------------------------------------

describe('structural edits round-trip on any working set (M9, PLAN.md risk 4)', () => {
  it('generated documents parse cleanly (generator sanity)', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, async (text) => {
        expect(await cleanErrors(text), text).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('patchTransform: clean parse, reads back, touches only its statement', async () => {
    await fc.assert(
      fc.asyncProperty(
        documentArb,
        fc.nat(),
        fc.nat(),
        fc.tuple(num, num, num),
        fc.tuple(num, num, num),
        fc.boolean(),
        async (text, si, ni, t, r, mirror) => {
          const doc = await docOf(text);
          const sets = workingSets(text, doc);
          const set = sets[si % sets.length];
          const node = set.nodes[ni % set.nodes.length];
          if (!decomposeNode(doc.tree.rootNode, node)) return;
          const transform: NodeTransform = { translate: t, rotateDeg: [r[0] * 4, 0, r[2] * 4], scale: [mirror ? -1 : 1, 2, 1], color: null };
          const out = patchTransform(text, doc.tree, node, transform);
          expect(await cleanErrors(out), out).toBe(0);
          expectOnlyChanged(text, out, node.startIndex, node.endIndex);
          const after = await docOf(out);
          const edited = { ...node, endIndex: node.endIndex + (out.length - text.length) };
          const back = decomposeNode(after.tree.rootNode, edited);
          expect(back, out).not.toBeNull();
          expect(back!.transform.translate).toEqual(transform.translate);
          expect(back!.transform.scale).toEqual(transform.scale);
          expect(back!.transform.rotateDeg.map((v) => Math.round(v))).toEqual(transform.rotateDeg);
          // The node keeps its modifier and its own primitive text.
          expect(readModifier(after.tree.rootNode, edited)).toBe(readModifier(doc.tree.rootNode, node));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('wrapInBoolean: clean parse, the new block holds exactly the selection in click order, siblings untouched', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, fc.nat(), fc.array(fc.nat(), { minLength: 2, maxLength: 3 }), fc.constantFrom<BooleanOp>('union', 'difference'), async (text, si, picks, op) => {
        const doc = await docOf(text);
        const sets = workingSets(text, doc).filter((s) => s.nodes.length >= 2);
        if (sets.length === 0) return;
        const set = sets[si % sets.length];
        const chosen = [...new Set(picks.map((p) => p % set.nodes.length))];
        if (chosen.length < 2) return;
        const selected = chosen.map((i) => set.nodes[i]);
        const out = wrapInBoolean(text, selected, op);
        expect(await cleanErrors(out), out).toBe(0);
        const first = Math.min(...selected.map((n) => n.startIndex));
        expect(out.slice(0, first)).toBe(text.slice(0, first));
        // Re-derive the same working set and find the new block in it.
        const same = await sameSet(out, set, doc);
        expect(same, out).not.toBeNull();
        const texts = same!.nodes.map((_, i) => nodeText(same!, i));
        // The new block: a `${op}() {` whose children, in click order, are the
        // selected statements (comments travel along, whitespace may be
        // re-indented). Another, pre-existing block of the same op can be in
        // the set too, so look for the one that matches.
        const wanted = selected.map((n) => normalizeText(text.slice(n.startIndex, n.endIndex)));
        const merged = texts.findIndex((tx, i) => {
          if (!tx.startsWith(`${op}() {`)) return false;
          const inner = drillInto(same!, i, resolverFor(same!.doc));
          return !!inner && JSON.stringify(inner.set.nodes.map((_, k) => normalizeText(nodeText(inner.set, k)))) === JSON.stringify(wanted);
        });
        expect(merged, out).toBeGreaterThanOrEqual(0);
        // The other siblings are all still there, unchanged.
        const others = set.nodes.filter((_, i) => !chosen.includes(i)).map((n) => normalizeText(text.slice(n.startIndex, n.endIndex)));
        expect(texts.filter((_, i) => i !== merged).map(normalizeText)).toEqual(others);
      }),
      { numRuns: RUNS },
    );
  });

  it('wrapInExtrude (offset / linear_extrude): clean parse, transform kept outside, body is the primitive', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, fc.nat(), fc.nat(), fc.constantFrom('linear_extrude', 'offset') as fc.Arbitrary<'linear_extrude' | 'offset'>, async (text, si, ni, op) => {
        const doc = await docOf(text);
        const sets = workingSets(text, doc);
        const set = sets[si % sets.length];
        const node = set.nodes[ni % set.nodes.length];
        const d = decomposeNode(doc.tree.rootNode, node);
        if (!d) return;
        const out = wrapInExtrude(text, doc.tree.rootNode, node, op);
        expect(await cleanErrors(out), out).toBe(0);
        expectOnlyChanged(text, out, node.startIndex, node.endIndex);
        const after = await docOf(out);
        const edited = { ...node, endIndex: node.endIndex + (out.length - text.length) };
        const back = decomposeNode(after.tree.rootNode, edited);
        expect(back!.transform).toEqual(d.transform);
        expect(back!.primitiveNode.childForFieldName('name')?.text).toBe(op);
        const primitive = normalizeText(text.slice(d.primitiveStart, node.endIndex));
        expect(normalizeText(out.slice(back!.primitiveStart, edited.endIndex))).toContain(primitive);
      }),
      { numRuns: RUNS },
    );
  });

  it('insertIntoContainer: clean parse, one more child equal to the statement, the rest untouched', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, fc.nat(), leaf, async (text, si, added) => {
        const doc = await docOf(text);
        const sets = workingSets(text, doc).filter((s) => s.container);
        if (sets.length === 0) return;
        const set = sets[si % sets.length];
        const statement = (added as { text: string }).text;
        const out = insertIntoContainer(text, set.container!, statement);
        expect(await cleanErrors(out), out).toBe(0);
        expect(out.slice(0, set.container!.statementStart)).toBe(text.slice(0, set.container!.statementStart));
        const same = await sameSet(out, set, doc);
        expect(same, out).not.toBeNull();
        const texts = same!.nodes.map((_, i) => normalizeText(nodeText(same!, i)));
        expect(texts).toEqual([...set.nodes.map((_, i) => normalizeText(nodeText(set, i))), statement]);
      }),
      { numRuns: RUNS },
    );
  });

  it('patchModifier: toggling the same modifier twice is the identity', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, fc.nat(), fc.nat(), fc.constantFrom('#', '%', '!', '*') as fc.Arbitrary<'#' | '%' | '!' | '*'>, async (text, si, ni, m) => {
        const doc = await docOf(text);
        const sets = workingSets(text, doc);
        const set = sets[si % sets.length];
        const node = set.nodes[ni % set.nodes.length];
        const once = patchModifier(text, doc.tree, node, m);
        if (once === text) return; // a bare block can't take a modifier
        expect(await cleanErrors(once), once).toBe(0);
        const d2 = await docOf(once);
        const edited = { ...node, endIndex: node.endIndex + (once.length - text.length) };
        const twice = patchModifier(once, d2.tree, edited, m);
        const before = readModifier(doc.tree.rootNode, node);
        // No modifier, or the same one: twice is the identity. A different
        // one: the first toggle replaced it with m, the second removes m.
        if (before === null || before === m) expect(twice).toBe(text);
        else expect(readModifier((await docOf(twice)).tree.rootNode, { ...node, endIndex: node.endIndex + (twice.length - text.length) })).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it('resolveFocus: an edit inside a drilled-in set keeps the focus on the same path', async () => {
    await fc.assert(
      fc.asyncProperty(documentArb, fc.nat(), fc.tuple(num, num, num), async (text, ni, t) => {
        const doc = await docOf(text);
        const resolve = resolverFor(doc);
        const top = topLevelSet(doc);
        const index = ni % top.nodes.length;
        const target = drillInto(top, index, resolve);
        if (!target || target.set.doc.kind !== 'document') return;
        const focus = [{ index, siblings: top.fingerprints }];
        const child = target.set.nodes[0];
        if (!decomposeNode(doc.tree.rootNode, child)) return;
        const out = patchTransform(text, doc.tree, child, { translate: t, rotateDeg: [0, 0, 0], scale: [1, 1, 1], color: null });
        const after = await docOf(out);
        const r = resolveFocus(after, focus, resolverFor(after));
        expect(r.lost, out).toBe(false);
        expect(r.focus[0].index).toBe(index);
        expect(r.sets[1].nodes).toHaveLength(target.set.nodes.length);
      }),
      { numRuns: RUNS },
    );
  });
});
