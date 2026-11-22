import type { Tree } from 'web-tree-sitter';

export interface SceneNode {
  index: number;
  label: string;
  startIndex: number;
  endIndex: number;
}

export interface SceneGraph {
  nodes: SceneNode[];
  /** Top-level assignments/module+function defs/use+include, concatenated —
   *  prepended to each node's isolated render so it can resolve variables and
   *  custom modules. M3 simplification: order-independent (real OpenSCAD is
   *  top-to-bottom), fine while files put definitions before use. */
  context: string;
}

// Top-level statement kinds that are *not* themselves geometry: definitions,
// assignments, and library directives. Everything else at the top level
// (module_instantiation, if/for statements, ...) is treated as a selectable,
// individually-isolated-renderable scene node. See PLAN.md M3 build notes for
// why isolating per top-level statement is a reasonable scope for this
// milestone rather than the full per-nested-node strategy in the architecture.
const CONTEXT_TYPES = new Set([
  'assignment_statement',
  'module_definition',
  'function_definition',
  'use_statement',
  'include_statement',
]);

export function buildSceneGraph(tree: Tree, source: string): SceneGraph {
  const root = tree.rootNode;
  const nodes: SceneNode[] = [];
  const contextParts: string[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) continue;
    if (child.type === 'comment') continue;
    // source_file's direct children are wrapped in a generic `statement`
    // supertype node (tree-sitter-openscad's grammar) — the concrete kind
    // (module_instantiation, assignment_statement, ...) is its one inner
    // child, not `child.type` itself.
    const concrete = child.type === 'statement' ? child.child(0) : child;
    if (!concrete) continue;
    if (CONTEXT_TYPES.has(concrete.type)) {
      contextParts.push(source.slice(child.startIndex, child.endIndex));
      continue;
    }
    nodes.push({
      index: nodes.length,
      label: source.slice(child.startIndex, Math.min(child.endIndex, child.startIndex + 40)).replace(/\s+/g, ' '),
      startIndex: child.startIndex,
      endIndex: child.endIndex,
    });
  }

  return { nodes, context: contextParts.join('\n') };
}
