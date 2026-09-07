import type { Node, Tree } from 'web-tree-sitter';
import type { SceneNode } from './sceneGraph';

export interface TranslateVector {
  startIndex: number;
  endIndex: number;
  xyz: [number, number, number];
}

// Locates `translate([x, y, z]) <body>;` when it is the *outermost* call of a
// scene node, and returns the byte range of just the vector literal plus its
// current values. Returns null for anything else (bare geometry with no wrap,
// or an outermost call that isn't `translate`) — M4 scope is proving the
// gizmo-edits-AST-via-targeted-patch loop, not handling every wrap shape.
export function findTranslateVector(root: Node, node: SceneNode): TranslateVector | null {
  for (let i = 0; i < root.childCount; i++) {
    const stmt = root.child(i);
    if (!stmt || stmt.startIndex !== node.startIndex || stmt.endIndex !== node.endIndex) continue;

    const concrete = stmt.type === 'statement' ? stmt.child(0) : stmt;
    if (!concrete || concrete.type !== 'module_instantiation') return null;
    if (concrete.childForFieldName('name')?.text !== 'translate') return null;

    const args = concrete.childForFieldName('arguments')?.namedChild(0); // `arguments` node
    const firstArg = args?.namedChild(0); // `argument` node
    const vec = firstArg?.child(0);
    if (!vec || vec.type !== 'vector_expression' || vec.namedChildCount < 3) return null;

    const nums = [0, 1, 2].map((n) => vec.namedChild(n));
    if (nums.some((n) => !n || n.type !== 'number')) return null;

    return {
      startIndex: vec.startIndex,
      endIndex: vec.endIndex,
      xyz: [parseFloat(nums[0]!.text), parseFloat(nums[1]!.text), parseFloat(nums[2]!.text)],
    };
  }
  return null;
}

function formatNumber(n: number): string {
  // Round away float noise from repeated drags (e.g. 4.999999999) without
  // mangling intentionally-precise values.
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function formatVector([x, y, z]: [number, number, number]): string {
  return `[${formatNumber(x)}, ${formatNumber(y)}, ${formatNumber(z)}]`;
}

// The M4 "targeted patch" loop: given a gizmo drag delta on a scene node,
// compute the minimal text edit needed to persist it as real OpenSCAD source.
// If the node is already `translate(...)`-wrapped, only the vector literal's
// byte range is replaced (comments/formatting elsewhere untouched). Otherwise
// a new `translate([...])` wrap is inserted immediately before the node —
// still a pure insertion, not a full-file regen.
export function patchTranslate(
  source: string,
  tree: Tree,
  node: SceneNode,
  delta: [number, number, number],
): string {
  const existing = findTranslateVector(tree.rootNode, node);
  if (existing) {
    const [x, y, z] = existing.xyz;
    const newVec = formatVector([x + delta[0], y + delta[1], z + delta[2]]);
    return source.slice(0, existing.startIndex) + newVec + source.slice(existing.endIndex);
  }
  const newVec = formatVector(delta);
  return `${source.slice(0, node.startIndex)}translate(${newVec})\n    ${source.slice(node.startIndex)}`;
}
