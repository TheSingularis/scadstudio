import type { Node, Tree } from 'web-tree-sitter';
import { operatorOf } from './scadExpr';
import { parseScadSync } from './scadParser';
import { isValidName, type VariableInfo } from './variables';
import type { NodeTransform } from './targetedPatch';

// M11 linked drag (Jordan, 2026-11-26, from testing PR #21): parts tied
// together by Distance move together. A translate axis set by an
// expression drags when the expression is `anchor + ...`, where the anchor
// is a position variable: a top-level variable assigned once to a plain
// number that some part uses as its whole translate component on that
// axis (`translate([cube_x, ...])`, written by Distance/Align with Follow).
// Dragging rewrites the anchor's number by the drag's distance, so every
// part that reads it moves the same way and the expressions (the distance)
// stay as they are. Any other expression axis stays locked (PLAN.md M11
// decision 8).

export interface DrivenAxis {
  axis: 0 | 1 | 2;
  anchor: VariableInfo;
}

/** The terms of a `a + b - c` chain, with their signs (null: not a chain). */
function sumTerms(node: Node, sign: 1 | -1, out: { node: Node; sign: 1 | -1 }[]): void {
  if (node.type === 'binary_expression') {
    const op = operatorOf(node);
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if ((op === '+' || op === '-') && left && right) {
      sumTerms(left, sign, out);
      sumTerms(right, op === '-' ? (-sign as 1 | -1) : sign, out);
      return;
    }
  }
  if (node.type === 'parenthesized_expression' && node.namedChildCount === 1 && sign === 1) {
    sumTerms(node.namedChild(0)!, sign, out);
    return;
  }
  out.push({ node, sign });
}

/** The names added (with a + sign) at the top level of an expression. */
export function addedNames(text: string): string[] {
  if (isValidName(text.trim())) return [text.trim()];
  const tree = parseScadSync(`__m11_drag = ${text};`);
  if (!tree) return [];
  try {
    const stmt = tree.rootNode.namedChild(0);
    const assign = stmt?.type === 'statement' ? stmt.namedChild(0) : stmt;
    const value = assign?.childForFieldName('value');
    if (!value || tree.rootNode.hasError) return [];
    const terms: { node: Node; sign: 1 | -1 }[] = [];
    sumTerms(value, 1, terms);
    return terms.filter((t) => t.sign === 1 && t.node.type === 'identifier').map((t) => t.node.text);
  } finally {
    tree.delete();
  }
}

/** Position variables, per axis: what can anchor a linked drag. */
export function positionAnchors(variables: VariableInfo[], transforms: NodeTransform[]): Map<string, VariableInfo>[] {
  const byName = new Map<string, VariableInfo>();
  for (const v of variables) if (!v.reassigned && v.literal && v.shape === 'number') byName.set(v.name, v);
  const out = [new Map<string, VariableInfo>(), new Map<string, VariableInfo>(), new Map<string, VariableInfo>()];
  for (const t of transforms) {
    t.exprs?.translate.forEach((text, axis) => {
      const v = text !== null ? byName.get(text.trim()) : undefined;
      if (v) out[axis].set(v.name, v);
    });
  }
  return out;
}

/**
 * Which of a part's translate axes drag by moving an anchor, and which
 * anchor. The part must read the top-level variable (not a same-named
 * module parameter or loop variable).
 */
export function drivenAxes(
  tree: Tree | null,
  node: { startIndex: number; endIndex: number },
  transform: NodeTransform,
  anchors: Map<string, VariableInfo>[],
): DrivenAxis[] {
  const texts = transform.exprs?.translate;
  if (!tree || !texts) return [];
  const out: DrivenAxis[] = [];
  texts.forEach((text, axis) => {
    if (text === null) return;
    const anchor = addedNames(text)
      .map((name) => anchors[axis].get(name))
      .find((v): v is VariableInfo => v !== undefined && v.uses.some((u) => u.start >= node.startIndex && u.end <= node.endIndex));
    if (anchor) out.push({ axis: axis as 0 | 1 | 2, anchor });
  });
  return out;
}
