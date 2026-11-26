import type { Node, Tree } from 'web-tree-sitter';
import type { SceneNode } from './sceneGraph';
import { decomposeNode, lineIndentAt, topConcreteNode, transformPrefixParts } from './targetedPatch';
import { precedenceOf } from './linExpr';
import { uniqueName, type TextEdit } from './variables';

// M11 patterns: N copies of a part, as a plain OpenSCAD for loop.
//
// Linear (PLAN.md M11 decision 5: spacing is center-to-center pitch):
//     translate(p) for (i = [0 : n - 1]) translate([i * pitch, 0, 0]) rotate(r) part();
// The copies step along a world axis: the step sits between the part's
// own translate (outside, so the gizmo still moves the whole pattern) and
// its rotate/scale (inside).
//
// Circular, about a world axis through the origin:
//     for (i = [0 : n - 1]) rotate([0, 0, i * 360 / n]) translate(p) part();
// `i * 360 / n` spreads the copies around the full circle; a fixed step
// angle writes `i * step` instead.
//
// readPattern recognizes exactly these shapes, so the pattern panel can
// edit the count and spacing after the fact.

export type PatternOptions =
  | { kind: 'linear'; axis: 0 | 1 | 2; count: string; spacing: string }
  | { kind: 'circular'; axis: 0 | 1 | 2; count: string; step: string | null };

const atom = (text: string) => {
  const t = text.trim();
  const p = precedenceOf(t);
  return p === 'atom' ? t : `(${t})`;
};

const isNumber = (t: string) => /^\s*\d+\s*$/.test(t);

/** The range end for `count` copies: `n - 1`, folded when n is a number. */
export function rangeEnd(count: string): string {
  const t = count.trim();
  if (isNumber(t)) return String(Math.max(0, Number(t) - 1));
  return `${precedenceOf(t) === 'atom' || precedenceOf(t) === 'mul' ? t : `(${t})`} - 1`;
}

function vector(axis: number, text: string): string {
  return `[${[0, 1, 2].map((k) => (k === axis ? text : '0')).join(', ')}]`;
}

export function wrapInPattern(source: string, tree: Tree, node: SceneNode, opts: PatternOptions): string | null {
  const root = tree.rootNode;
  const it = uniqueName(root, 'i');
  const baseIndent = lineIndentAt(source, node.startIndex);
  const sep = `\n${baseIndent}    `;
  const range = `[0 : ${rangeEnd(opts.count)}]`;
  if (opts.kind === 'linear') {
    const d = decomposeNode(root, node);
    if (!d) return null;
    const { outer, inner } = transformPrefixParts(d.transform, baseIndent);
    const primitive = source.slice(d.primitiveStart, node.endIndex);
    const text = `${outer}for (${it} = ${range})${sep}translate(${vector(opts.axis, `${it} * ${atom(opts.spacing)}`)})${sep}${inner}${primitive}`;
    return source.slice(0, d.wrapStart) + text + source.slice(node.endIndex);
  }
  const angle = opts.step === null ? `${it} * 360 / ${atom(opts.count)}` : `${it} * ${atom(opts.step)}`;
  const statement = source.slice(node.startIndex, node.endIndex);
  const text = `for (${it} = ${range})${sep}rotate(${vector(opts.axis, angle)})${sep}${statement.replace(/\n/g, '\n    ')}`;
  return source.slice(0, node.startIndex) + text + source.slice(node.endIndex);
}

export interface PatternInfo {
  kind: 'linear' | 'circular';
  axis: 0 | 1 | 2;
  iterator: string;
  // What the panel shows: the copy count, and the pitch (linear) or step
  // angle (circular; null for a full circle).
  countText: string;
  spacingText: string | null;
  // Nodes the edits replace.
  endNode: Node;
  spacingNode: Node | null;
  // Full circle: the n in `i * 360 / n`.
  divisorNode: Node | null;
}

function forStatementOf(root: Node, node: SceneNode): Node | null {
  const top = topConcreteNode(root, node);
  if (top?.type === 'for_statement') return top;
  const d = decomposeNode(root, node);
  return d?.primitiveNode.type === 'for_statement' ? d.primitiveNode : null;
}

function unparen(n: Node): Node {
  return n.type === 'parenthesized_expression' && n.namedChild(0) ? unparen(n.namedChild(0)!) : n;
}

function isMul(n: Node, op: string): boolean {
  return n.type === 'binary_expression' && n.childForFieldName('operator')?.type === op;
}

export function readPattern(tree: Tree, node: SceneNode): PatternInfo | null {
  const loop = forStatementOf(tree.rootNode, node);
  if (!loop) return null;
  const iterator = loop.childForFieldName('iterator')?.text;
  const range = loop.childForFieldName('range');
  if (!iterator || range?.type !== 'range_expression' || range.childForFieldName('step')) return null;
  if (range.childForFieldName('start')?.text !== '0') return null;
  const endNode = range.childForFieldName('end');
  if (!endNode) return null;
  const body = loop.namedChildren.find((c) => c?.type === 'statement')?.child(0);
  const name = body?.childForFieldName('name')?.text;
  if (body?.type !== 'module_instantiation' || (name !== 'translate' && name !== 'rotate')) return null;
  const vec = body.childForFieldName('arguments')?.namedChild(0)?.namedChild(0)?.child(0);
  if (vec?.type !== 'vector_expression' || vec.namedChildCount !== 3) return null;
  let axis = -1;
  let step: Node | null = null;
  for (let k = 0; k < 3; k++) {
    const c = vec.namedChild(k)!;
    if (c.text.trim() === '0') continue;
    if (axis >= 0) return null;
    axis = k;
    step = c;
  }
  if (axis < 0 || !step) return null;
  let countText: string;
  if (endNode.type === 'number') countText = String(Number(endNode.text) + 1);
  else if (isMul(endNode, 'subtraction_operator') && endNode.childForFieldName('right')?.text === '1') countText = unparen(endNode.childForFieldName('left')!).text;
  else countText = `${endNode.text} + 1`;
  const leadsWithIterator = (n: Node) => isMul(n, 'multiplication_operator') && n.childForFieldName('left')?.text === iterator;
  if (name === 'translate') {
    if (!leadsWithIterator(step)) return null;
    const spacing = step.childForFieldName('right')!;
    return { kind: 'linear', axis: axis as 0 | 1 | 2, iterator, countText, spacingText: unparen(spacing).text, endNode, spacingNode: spacing, divisorNode: null };
  }
  // rotate: i * 360 / n (full circle) or i * step.
  if (isMul(step, 'division_operator')) {
    const left = step.childForFieldName('left')!;
    if (!leadsWithIterator(left) || left.childForFieldName('right')?.text !== '360') return null;
    return { kind: 'circular', axis: axis as 0 | 1 | 2, iterator, countText, spacingText: null, endNode, spacingNode: null, divisorNode: step.childForFieldName('right') };
  }
  if (!leadsWithIterator(step)) return null;
  const angle = step.childForFieldName('right')!;
  return { kind: 'circular', axis: axis as 0 | 1 | 2, iterator, countText, spacingText: unparen(angle).text, endNode, spacingNode: angle, divisorNode: null };
}

/** Edits that set the copy count (and a full circle's divisor with it). */
export function patternCountEdits(p: PatternInfo, count: string): TextEdit[] {
  const edits: TextEdit[] = [{ start: p.endNode.startIndex, end: p.endNode.endIndex, text: rangeEnd(count) }];
  if (p.divisorNode) edits.push({ start: p.divisorNode.startIndex, end: p.divisorNode.endIndex, text: atom(count) });
  return edits;
}

export function patternSpacingEdits(p: PatternInfo, spacing: string): TextEdit[] {
  return p.spacingNode ? [{ start: p.spacingNode.startIndex, end: p.spacingNode.endIndex, text: atom(spacing) }] : [];
}
