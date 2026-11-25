// M9: nested scene nodes and drill-in focus (PLAN.md "Nested selection &
// drill-in navigation").
//
// The scene graph used to be the document's top-level statements only. A
// *working set* generalizes it: the statements the user is working on right
// now, which is the top level until they drill into a node, and then that
// node's children:
//
// - a boolean, hull, extrusion, offset or other call with children
//   (`difference() { a; b; }`, `linear_extrude(5) circle(3);`),
// - a bare block (`{ a; b; }`),
// - a custom module call: the statements of the module's own body. A module
//   defined in the open document is edited in place (every call of it
//   changes, as in any CAD tool's "edit component"); one from a `use`d
//   library file is view-only (Jordan, 2026-11-24: no silent edits to shared
//   library files; editing needs the explicit "open the library" action).
//
// Each working-set node is a SceneNode (a byte range), exactly like a
// top-level one, so every targeted patch (gizmo, parameter panel, modifier,
// boolean wrap, extrude, sketch save) works on a nested node unchanged:
// targetedPatch.ts finds statements by range at any depth.
//
// Isolated renders go one level deeper the same way M3's did: a node's own
// primitive is rendered alone, and its translate/rotate/scale become a
// three.js transform. What is new is the node's *frame* (where its parent
// places it in the world) and its *scope* (what names it can see):
//
// - Frame: the product of every ancestor's transforms, as a matrix, when they
//   are all literal numbers. When one is not (`translate([w, 0, 0])` inside
//   a module), that part can't be a three.js matrix; from there down the
//   ancestors' transform text is kept in the render source instead
//   (`bakedPrefix`), the child renders with them baked in, and the gizmo is
//   off for that working set (its parameters stay editable).
// - Scope: a module body's statements see the module's parameters. The
//   render source wraps the node in a copy of the module, with the
//   instance's own argument list, so OpenSCAD itself binds positional,
//   named and default arguments: `module __scadstudio_scope_1(w=20, h=10) {
//   <body assignments> <node> } __scadstudio_scope_1(30, 15);`. Body-level
//   assignments of a block are kept the same way.
//
// Rendering stays lazy: only the focused working set and the dimmed
// context around it are rendered, and the per-node render cache (App.tsx)
// keeps a node's mesh across edits to its siblings and across stepping in
// and out.
import type { Node, Tree } from 'web-tree-sitter';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneNode } from './sceneGraph';
import {
  decomposeNode,
  lineIndentAt,
  quaternionToRotateDeg,
  readModifier,
  readVectorCall,
  reindent,
  topConcreteNode,
  transformToQuaternion,
  type NodeTransform,
} from './targetedPatch';
import { normalizeText, remapIndex, type NodeFingerprint } from './nodeIdentity';

/** A parsed source file whose byte ranges working-set nodes refer to. */
export interface SourceDoc {
  kind: 'document' | 'library';
  // Absolute path of a library file; null for the open document.
  path: string | null;
  text: string;
  tree: Tree;
}

export interface ModuleScope {
  name: string;
  // The definition's parameter list and the instance's argument list,
  // verbatim, parentheses included.
  paramsText: string;
  argsText: string;
  // The instance's own children (` cube(1);`, ` { ... }`), or `;`, so
  // children() inside the body still has something to show.
  childrenText: string;
}

/**
 * The condition a statement inside an `if` needs around it to render the way
 * it does in the full model: `if (c) { <branch assignments> <stmt> }`, or
 * `if (!(c)) ...` for the else branch.
 */
export interface BranchGuard {
  // The `if`'s condition, verbatim (no outer parentheses).
  condition: string;
  // True for the else branch.
  negated: boolean;
  // Assignments of the branch's own block, which only its statements see.
  context: string;
}

/** What one focus level adds around the statements inside it. */
export interface LevelEnv {
  // Non-geometry statements of the level's body: assignments, nested
  // module/function definitions.
  context: string;
  scope: ModuleScope | null;
  // The guard of the drilled-into node in its parent set, when that node is
  // inside an `if` branch: the whole level renders under it.
  guard: BranchGuard | null;
}

/** Where a working set lives in its source, for inserting into it. */
export interface ContainerInfo {
  // The statement that owns the body (the drilled-into statement, or the
  // module definition when drilled through a call), and the body itself
  // (a block, or one statement).
  statementStart: number;
  statementEnd: number;
  body: { start: number; end: number; isBlock: boolean };
  // What the editor leaves undimmed, when that isn't `body` (an `if`, whose
  // inserts go into one branch but whose working set is both).
  focus?: { start: number; end: number };
}

export interface WorkingSet {
  doc: SourceDoc;
  nodes: SceneNode[];
  fingerprints: NodeFingerprint[];
  // Column-major world matrix of this set's frame (the known part).
  frame: number[];
  // Ancestor transform text that couldn't become `frame` (see file comment);
  // '' when the frame is fully known and the gizmo can edit these nodes.
  bakedPrefix: string;
  envs: LevelEnv[];
  container: ContainerInfo | null;
  // Set once any level is inside a library module.
  readOnly: { path: string; moduleName: string } | null;
  // Set when this set is (inside) a document module's body: edits change
  // every call of it.
  editingModule: string | null;
  // The drilled-into call ("difference", "linear_extrude", a module name),
  // 'if' for an if statement, or null for the top level or a bare block.
  containerCall: string | null;
  // Per node (same order as `nodes`): the `if` branch it sits in, when this
  // set is the inside of an if statement.
  guards: (BranchGuard | null)[];
  // The drilled-into if statement's condition, for the branch note.
  condition: string | null;
}

export interface FocusEntry {
  // Position of the drilled-into node in its parent working set.
  index: number;
  // The parent set's fingerprints when this was last resolved, so the
  // position can follow the node through edits (nodeIdentity.ts).
  siblings: NodeFingerprint[];
}

export interface Crumb {
  label: string;
  // The working set this crumb shows (0 = the top level).
  depth: number;
}

export interface ResolvedFocus {
  // sets[0] is the top level; sets[k] is the inside of focus level k-1.
  sets: WorkingSet[];
  focus: FocusEntry[];
  crumbs: Crumb[];
  // True when a focus level's node could no longer be found (or no longer
  // has children), so that level and everything inside it were left.
  lost: boolean;
}

export type ModuleResolver = (name: string, from: SourceDoc) => { def: Node; doc: SourceDoc } | null;

const IDENTITY = new Matrix4().toArray();

// Top-level statement kinds that are not geometry (sceneGraph.ts's list).
const CONTEXT_TYPES = new Set(['assignment_statement', 'module_definition', 'function_definition', 'use_statement', 'include_statement']);

// Calls whose children are placed by the call: their frame is a matrix
// when the vector is literal. Every other call (booleans, hull, extrusions,
// offset, color, render, ...) leaves its children where they are.
const TRANSFORM_CALLS = new Set(['translate', 'rotate', 'scale', 'mirror', 'multmatrix', 'resize']);

function isGeometryStatement(stmt: Node): boolean {
  const concrete = stmt.type === 'statement' ? stmt.child(0) : stmt;
  return !!concrete && concrete.type !== 'comment' && !CONTEXT_TYPES.has(concrete.type);
}

function kindOf(root: Node, node: SceneNode): string {
  const d = decomposeNode(root, node);
  if (d) {
    if (d.primitiveNode.type === 'block') return 'block';
    return d.primitiveNode.childForFieldName('name')?.text ?? d.primitiveNode.type;
  }
  return topConcreteNode(root, node)?.type ?? 'unknown';
}

function makeNodes(stmts: Node[], doc: SourceDoc): { nodes: SceneNode[]; fingerprints: NodeFingerprint[] } {
  const nodes: SceneNode[] = [];
  const fingerprints: NodeFingerprint[] = [];
  for (const stmt of stmts) {
    if (!isGeometryStatement(stmt)) continue;
    const node: SceneNode = {
      index: nodes.length,
      label: doc.text.slice(stmt.startIndex, Math.min(stmt.endIndex, stmt.startIndex + 40)).replace(/\s+/g, ' '),
      startIndex: stmt.startIndex,
      endIndex: stmt.endIndex,
    };
    nodes.push(node);
    fingerprints.push({ text: normalizeText(doc.text.slice(stmt.startIndex, stmt.endIndex)), kind: kindOf(doc.tree.rootNode, node) });
  }
  return { nodes, fingerprints };
}

export function topLevelSet(doc: SourceDoc): WorkingSet {
  const stmts = doc.tree.rootNode.children.filter((c): c is Node => c !== null);
  const { nodes, fingerprints } = makeNodes(stmts, doc);
  return {
    doc,
    nodes,
    fingerprints,
    frame: IDENTITY,
    bakedPrefix: '',
    envs: [],
    container: null,
    readOnly: null,
    editingModule: null,
    containerCall: null,
    guards: nodes.map(() => null),
    condition: null,
  };
}

function transformMatrix(t: NodeTransform): Matrix4 {
  return new Matrix4().compose(new Vector3(...t.translate), transformToQuaternion(t.rotateDeg), new Vector3(...t.scale));
}

// The matrix a transform call applies to its children, or null when its
// arguments aren't literal (or it's multmatrix/resize, which aren't read).
function callMatrix(call: Node): Matrix4 | null {
  const name = call.childForFieldName('name')?.text;
  if (name !== 'translate' && name !== 'rotate' && name !== 'scale' && name !== 'mirror') return null;
  const vc = readVectorCall(call);
  if (!vc) return null;
  const [x, y, z] = vc.xyz;
  if (name === 'translate') return new Matrix4().makeTranslation(x, y, z);
  if (name === 'rotate') return new Matrix4().makeRotationFromQuaternion(transformToQuaternion([x, y, z]));
  if (name === 'scale') return new Matrix4().makeScale(x, y, z);
  // mirror(v): reflection across the plane through the origin normal to v.
  const n = new Vector3(x, y, z);
  if (n.lengthSq() === 0) return new Matrix4();
  n.normalize();
  return new Matrix4().set(
    1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
    -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
    -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
    0, 0, 0, 1,
  );
}

function prettyCallName(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface DrillTarget {
  set: WorkingSet;
  label: string;
}

/**
 * The working set inside node `index` of `parent`, or null when the node has
 * no children to drill into (a leaf primitive, a `for`/`if`, a call of an
 * unknown module).
 */
export function drillInto(parent: WorkingSet, index: number, resolveModule: ModuleResolver): DrillTarget | null {
  const node = parent.nodes[index];
  if (!node) return null;
  const root = parent.doc.tree.rootNode;
  const top = topConcreteNode(root, node);
  if (top?.type === 'if_statement') return drillIntoIf(parent, index, top);
  const decomposed = decomposeNode(root, node);
  if (!decomposed) return null;
  const p = decomposed.primitiveNode;
  const text = parent.doc.text;

  let doc = parent.doc;
  let bodyNode: Node | null = null;
  let stmts: Node[] = [];
  let scope: ModuleScope | null = null;
  let containerMatrix: Matrix4 | null = new Matrix4();
  // Text of the container call itself, for a baked frame.
  let containerHeader = '';
  let label: string;
  let containerCall: string | null = null;
  let readOnly = parent.readOnly;
  let editingModule = parent.editingModule;
  // The statement that owns the body (for indentation): the drilled node,
  // or the module definition when drilling through a call.
  let owner: { startIndex: number; endIndex: number } = node;

  if (p.type === 'block') {
    bodyNode = p;
    stmts = p.namedChildren.filter((c): c is Node => c?.type === 'statement');
    label = 'Group';
  } else {
    const name = p.childForFieldName('name')?.text ?? '';
    const args = p.childForFieldName('arguments');
    const last = p.child(p.childCount - 1);
    containerCall = name;
    const hasChildren = last?.type === 'block' || last?.type === 'statement';
    const resolved = TRANSFORM_CALLS.has(name) || BUILTIN_WITH_CHILDREN.has(name) ? null : resolveCall(p, parent.doc, resolveModule);
    if (resolved) {
      const body = resolved.def.childForFieldName('body');
      const params = resolved.def.childForFieldName('parameters');
      if (!body || !params || !args) return null;
      doc = resolved.doc;
      bodyNode = body;
      owner = resolved.def;
      stmts = body.type === 'block' ? body.namedChildren.filter((c): c is Node => c?.type === 'statement') : [body];
      scope = {
        name,
        paramsText: params.text,
        argsText: args.text,
        childrenText: hasChildren ? ` ${last!.text}` : ';',
      };
      label = `${name}()`;
      if (resolved.doc.kind === 'library' && !readOnly) readOnly = { path: resolved.doc.path ?? '', moduleName: name };
      if (resolved.doc.kind === 'document') editingModule = name;
    } else if (hasChildren) {
      bodyNode = last!;
      stmts = last!.type === 'block' ? last!.namedChildren.filter((c): c is Node => c?.type === 'statement') : [last!];
      label = prettyCallName(name);
      if (TRANSFORM_CALLS.has(name)) {
        containerMatrix = callMatrix(p);
        containerHeader = text.slice(p.startIndex, last!.startIndex);
      }
    } else {
      return null;
    }
  }

  const { nodes, fingerprints } = makeNodes(stmts, doc);
  if (nodes.length === 0) return null;

  // Frame: parent frame x the statement's own (decomposed) placement x the
  // container call's matrix. Once anything is unknown, the rest is text.
  const statementMatrix = transformMatrix(decomposed.transform);
  let frame = parent.frame;
  let bakedPrefix = parent.bakedPrefix;
  const wrapsText = text.slice(decomposed.wrapStart, decomposed.primitiveStart);
  if (bakedPrefix === '' && containerMatrix) {
    frame = new Matrix4().fromArray(parent.frame).multiply(statementMatrix).multiply(containerMatrix).toArray();
  } else if (bakedPrefix === '') {
    frame = new Matrix4().fromArray(parent.frame).multiply(statementMatrix).toArray();
    bakedPrefix = containerHeader;
  } else {
    bakedPrefix = `${bakedPrefix}${wrapsText}${containerHeader}`;
  }

  const context = bodyNode.type === 'block'
    ? stmts
        .filter((s) => !isGeometryStatement(s))
        .map((s) => s.text)
        .filter((t) => !t.startsWith('//') && !t.startsWith('/*'))
        .join('\n')
    : '';

  const container: ContainerInfo | null =
    doc.kind === 'document'
      ? {
          statementStart: owner.startIndex,
          statementEnd: owner.endIndex,
          body: { start: bodyNode.startIndex, end: bodyNode.endIndex, isBlock: bodyNode.type === 'block' },
        }
      : null;

  return {
    label: `${label} #${index + 1}`,
    set: {
      doc,
      nodes,
      fingerprints,
      frame,
      bakedPrefix,
      envs: [...parent.envs, { context, scope, guard: parent.guards[index] ?? null }],
      container,
      readOnly,
      editingModule,
      containerCall,
      guards: nodes.map(() => null),
      condition: null,
    },
  };
}

/**
 * The definition a module call resolves to, the way OpenSCAD looks it up:
 * a module defined in an enclosing block (a module nested in another
 * module's body, like `main_body()` inside `switch_mount()`) first, then the
 * file's top level and the files it uses (`resolveModule`).
 */
export function resolveCall(call: Node, from: SourceDoc, resolveModule: ModuleResolver): { def: Node; doc: SourceDoc } | null {
  const name = call.childForFieldName('name')?.text;
  if (!name) return null;
  for (let n = call.parent; n && n.type !== 'source_file'; n = n.parent) {
    if (n.type !== 'block') continue;
    for (const child of n.namedChildren) {
      const def = child?.type === 'statement' ? child.child(0) : child;
      if (def?.type === 'module_definition' && def.childForFieldName('name')?.text === name) return { def, doc: from };
    }
  }
  return resolveModule(name, from);
}

/**
 * The module definition node `index` calls, when it is a call of a module
 * (not a built-in), for "Go to definition".
 */
export function callDefinition(set: WorkingSet, index: number, resolveModule: ModuleResolver): { name: string; doc: SourceDoc; start: number; end: number; nameStart: number; nameEnd: number } | null {
  const node = set.nodes[index];
  if (!node) return null;
  const decomposed = decomposeNode(set.doc.tree.rootNode, node);
  const p = decomposed?.primitiveNode;
  if (!p || p.type !== 'module_instantiation') return null;
  const name = p.childForFieldName('name')?.text ?? '';
  if (TRANSFORM_CALLS.has(name) || BUILTIN_WITH_CHILDREN.has(name)) return null;
  const resolved = resolveCall(p, set.doc, resolveModule);
  const nameNode = resolved?.def.childForFieldName('name');
  if (!resolved || !nameNode) return null;
  return { name, doc: resolved.doc, start: resolved.def.startIndex, end: resolved.def.endIndex, nameStart: nameNode.startIndex, nameEnd: nameNode.endIndex };
}

function branchParts(branch: Node): { stmts: Node[]; context: string; isBlock: boolean } {
  if (branch.type !== 'block') return { stmts: [branch], context: '', isBlock: false };
  const stmts = branch.namedChildren.filter((c): c is Node => c?.type === 'statement');
  const context = stmts
    .filter((s) => !isGeometryStatement(s))
    .map((s) => s.text)
    .filter((t) => !t.startsWith('//') && !t.startsWith('/*'))
    .join('\n');
  return { stmts, context, isBlock: true };
}

/**
 * What an `if` condition is without evaluating anything, or null when that
 * needs the engine. `$preview` is false whenever ScadStudio renders (it
 * renders the exported part, never OpenSCAD's F5 preview), so a
 * `if ($preview) { <posed for viewing> } else { <the part> }` resolves to
 * the else branch.
 */
export function staticCondition(condition: string): boolean | null {
  let c = condition.replace(/\s+/g, '');
  let negate = false;
  for (;;) {
    if (/^\(.*\)$/.test(c) && balanced(c.slice(1, -1))) c = c.slice(1, -1);
    else if (c.startsWith('!')) {
      negate = !negate;
      c = c.slice(1);
    } else break;
  }
  const value = c === '$preview' || c === 'false' ? false : c === 'true' ? true : null;
  return value === null ? null : value !== negate;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** True when the guard is known to be false, so its statement renders nothing. */
export function guardInactive(guard: BranchGuard | null): boolean {
  if (!guard) return false;
  const value = staticCondition(guard.condition);
  return value !== null && value === guard.negated;
}

export function guardText(guard: BranchGuard): string {
  return guard.negated ? `!(${guard.condition})` : guard.condition;
}

// The inside of an if statement: the statements of both branches, each
// rendered under its branch's condition, so the one the model doesn't take
// renders empty (and one that is statically known not taken isn't rendered
// at all). An `else if` is the else branch's one statement, drillable in
// turn.
function drillIntoIf(parent: WorkingSet, index: number, ifNode: Node): DrillTarget | null {
  const conditionNode = ifNode.childForFieldName('condition');
  const consequence = ifNode.childForFieldName('consequence');
  const alternative = ifNode.childForFieldName('alternative');
  if (!conditionNode || !consequence) return null;
  const condition = conditionNode.text;
  const doc = parent.doc;
  const branches = [{ node: consequence, negated: false }];
  if (alternative) branches.push({ node: alternative, negated: true });
  const stmts: Node[] = [];
  const guards: BranchGuard[] = [];
  for (const branch of branches) {
    const parts = branchParts(branch.node);
    for (const stmt of parts.stmts) {
      if (!isGeometryStatement(stmt)) continue;
      stmts.push(stmt);
      guards.push({ condition, negated: branch.negated, context: parts.context });
    }
  }
  const { nodes, fingerprints } = makeNodes(stmts, doc);
  if (nodes.length === 0) return null;

  // Inserts go into the branch the model takes when that is known (the
  // else of `if ($preview)`), else into the if branch.
  const value = staticCondition(condition);
  const insertBranch = value === false && alternative ? alternative : consequence;
  const container: ContainerInfo | null =
    doc.kind === 'document'
      ? {
          statementStart: ifNode.startIndex,
          statementEnd: ifNode.endIndex,
          body: { start: insertBranch.startIndex, end: insertBranch.endIndex, isBlock: insertBranch.type === 'block' },
          focus: { start: ifNode.startIndex, end: ifNode.endIndex },
        }
      : null;
  const shown = condition.replace(/\s+/g, ' ');
  return {
    label: `If (${shown.length > 24 ? `${shown.slice(0, 23)}…` : shown}) #${index + 1}`,
    set: {
      doc,
      nodes,
      fingerprints,
      frame: parent.frame,
      bakedPrefix: parent.bakedPrefix,
      envs: [...parent.envs, { context: '', scope: null, guard: parent.guards[index] ?? null }],
      container,
      readOnly: parent.readOnly,
      editingModule: parent.editingModule,
      containerCall: 'if',
      guards,
      condition,
    },
  };
}

// Built-ins that take children: never looked up as custom modules even if
// a library happens to define one with the same name.
const BUILTIN_WITH_CHILDREN = new Set([
  'union', 'difference', 'intersection', 'hull', 'minkowski', 'linear_extrude', 'rotate_extrude', 'offset',
  'projection', 'color', 'render', 'group', 'children',
]);

/**
 * Re-derives the drilled-into working sets for a new parse of the document:
 * each focus level follows its node through the edit (nodeIdentity.ts), and
 * a level whose node is gone (or no longer has children) is left, along
 * with everything inside it.
 */
export function resolveFocus(doc: SourceDoc, focus: FocusEntry[], resolveModule: ModuleResolver): ResolvedFocus {
  const sets: WorkingSet[] = [topLevelSet(doc)];
  const next: FocusEntry[] = [];
  const crumbs: Crumb[] = [{ label: 'Assembly', depth: 0 }];
  let lost = false;
  for (const entry of focus) {
    const parent = sets[sets.length - 1];
    const index = remapIndex(entry.siblings, parent.fingerprints, entry.index);
    const target = index === null ? null : drillInto(parent, index, resolveModule);
    if (index === null || !target) {
      lost = true;
      break;
    }
    next.push({ index, siblings: parent.fingerprints });
    sets.push(target.set);
    crumbs.push({ label: target.label, depth: sets.length - 1 });
  }
  return { sets, focus: next, crumbs, lost };
}

export function canDrill(set: WorkingSet, index: number, resolveModule: ModuleResolver): boolean {
  return drillInto(set, index, resolveModule) !== null;
}

/** The breadcrumb label node `index` would get if drilled into, or null. */
export function drillLabel(set: WorkingSet, index: number, resolveModule: ModuleResolver): string | null {
  return drillInto(set, index, resolveModule)?.label ?? null;
}

/** What gets sent to openscad-wasm for one working-set node. */
export interface IsolatedRender {
  source: string;
  // The same, with the node's primitive inside a hairline linear_extrude,
  // for a node that turns out to be 2D (M7's fallback).
  flatSource: string;
  transform: NodeTransform;
  // false when the set's frame is baked (see file comment): the gizmo and
  // other transform edits are off for this node.
  transformEditable: boolean;
}

const IDENTITY_TRANSFORM: NodeTransform = { translate: [0, 0, 0], rotateDeg: [0, 0, 0], scale: [1, 1, 1], color: null };

export function isolatedRender(set: WorkingSet, node: SceneNode, documentContext: string): IsolatedRender {
  const root = set.doc.tree.rootNode;
  const decomposed = decomposeNode(root, node);
  const text = set.doc.text;
  let primitive: string;
  let transform: NodeTransform;
  const guard = set.guards[node.index] ?? null;
  if (set.bakedPrefix === '') {
    primitive = text.slice(decomposed?.primitiveStart ?? node.startIndex, node.endIndex);
    transform = decomposed?.transform ?? IDENTITY_TRANSFORM;
  } else {
    // The node's whole statement (minus a leading modifier, which the
    // viewport shows itself) inside the ancestors' transform text.
    const start = decomposed?.wrapStart ?? node.startIndex;
    primitive = `${set.bakedPrefix}{\n${text.slice(start, node.endIndex)}\n}`;
    transform = { ...IDENTITY_TRANSFORM, color: decomposed?.transform.color ?? null };
  }
  const inScopeAt = (depth: number) => set.envs.slice(0, depth + 1).some((e) => e.scope !== null);
  const wrap = (inner: string) => {
    let body = guarded(guard, inner, 'node', inScopeAt(set.envs.length - 1));
    for (let depth = set.envs.length - 1; depth >= 0; depth--) {
      const env = set.envs[depth];
      if (env.context) body = `${env.context}\n${body}`;
      if (env.scope) {
        const name = `__scadstudio_scope_${depth + 1}`;
        body = `module ${name}${env.scope.paramsText} {\n${body}\n}\n${name}${env.scope.argsText}${env.scope.childrenText}`;
      }
      // The guard is evaluated where the drilled-into statement sits: in
      // the parent level's scope, so outside this level's own context.
      body = guarded(env.guard, body, String(depth + 1), inScopeAt(depth - 1));
    }
    return `${documentContext}\n${body}`;
  };
  return {
    source: wrap(primitive),
    flatSource: wrap(`linear_extrude(height=0.01) {\n${primitive}\n}`),
    transform,
    transformEditable: set.bakedPrefix === '',
  };
}

// `if (c) { <branch assignments> <body> }`, except that OpenSCAD only
// allows module definitions at the top level, in a bare block or in a
// module body, and the body may hold the scope wrappers above. So the body
// goes in a module defined where the if statement sits (same lexical scope)
// and only its call is guarded. Inside a module scope the call passes the
// scope's children on, so children() in the body still sees them.
function guarded(guard: BranchGuard | null, body: string, suffix: string, inScope: boolean): string {
  if (!guard) return body;
  const name = `__scadstudio_branch_${suffix}`;
  const context = guard.context ? `${guard.context}\n` : '';
  return `module ${name}() {\n${context}${body}\n}\nif (${guardText(guard)}) ${name}()${inScope ? ' children();' : ';'}`;
}

export function nodeModifier(set: WorkingSet, node: SceneNode) {
  return readModifier(set.doc.tree.rootNode, node);
}

/** True when `frame` has no scale or mirror (a sketch plane can live in it). */
export function frameIsRigid(frame: number[]): boolean {
  const m = new Matrix4().fromArray(frame);
  const s = new Vector3();
  m.decompose(new Vector3(), new Quaternion(), s);
  return Math.abs(s.x - 1) < 1e-9 && Math.abs(s.y - 1) < 1e-9 && Math.abs(s.z - 1) < 1e-9 && m.determinant() > 0;
}

export function isIdentityFrame(frame: number[]): boolean {
  return frame.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);
}

/**
 * Adds `statement` as the last child of a drilled-into container: a toolbar
 * insert, a finished sketch or a Custom tool lands in the working set rather
 * than at the end of the file. A block body gets the statement before its
 * closing brace, at its children's indentation; a single-statement body
 * (`difference() cube(5);`) becomes a block first.
 */
export function insertIntoContainer(source: string, container: ContainerInfo, statement: string): string {
  const { start, end, isBlock } = container.body;
  if (isBlock) {
    const baseIndent = lineIndentAt(source, start);
    const childIndent = `${baseIndent}    `;
    const close = end - 1; // the block's `}`
    let at = close;
    while (at > start + 1 && (source[at - 1] === ' ' || source[at - 1] === '\t')) at--;
    if (source[at - 1] === '\n') {
      // Match the existing children's indentation when there are any (the
      // file's own style, 2 spaces or a tab), else one level in.
      const prevLineStart = source.lastIndexOf('\n', at - 2) + 1;
      const prevLine = source.slice(prevLineStart, at - 1);
      const indent = prevLineStart > start && prevLine.trim() !== '' ? (/^[ \t]*/.exec(prevLine)?.[0] ?? childIndent) : childIndent;
      return `${source.slice(0, at)}${indent}${statement}\n${source.slice(at)}`;
    }
    // `{ cube(1); }` on one line: open it up.
    let contentEnd = at;
    while (contentEnd > start + 1 && /\s/.test(source[contentEnd - 1])) contentEnd--;
    const inner = source.slice(start + 1, contentEnd).trim();
    const lines = inner ? `\n${childIndent}${inner}\n${childIndent}${statement}` : `\n${childIndent}${statement}`;
    return `${source.slice(0, start + 1)}${lines}\n${baseIndent}${source.slice(close)}`;
  }
  const baseIndent = lineIndentAt(source, container.statementStart);
  const childIndent = `${baseIndent}    `;
  const child = reindent(source.slice(start, end), lineIndentAt(source, start), childIndent).trimStart();
  // Replace the whitespace between the call and its old body with one space.
  let callEnd = start;
  while (callEnd > 0 && /\s/.test(source[callEnd - 1])) callEnd--;
  return `${source.slice(0, callEnd)} {\n${childIndent}${child}\n${childIndent}${statement}\n${baseIndent}}${source.slice(end)}`;
}

/** A world-space placement (translate + rotate, degrees) moved into `frame`'s local space. */
export function worldToFrame(
  frame: number[],
  origin: [number, number, number],
  rotationDeg: [number, number, number],
): { origin: [number, number, number]; rotationDeg: [number, number, number] } {
  const world = new Matrix4().compose(new Vector3(...origin), transformToQuaternion(rotationDeg), new Vector3(1, 1, 1));
  const local = new Matrix4().fromArray(frame).invert().multiply(world);
  return decomposeRigid(local);
}

/** The inverse: a placement local to `frame`, in world space. */
export function frameToWorld(
  frame: number[],
  origin: [number, number, number],
  rotationDeg: [number, number, number],
): { origin: [number, number, number]; rotationDeg: [number, number, number] } {
  const local = new Matrix4().compose(new Vector3(...origin), transformToQuaternion(rotationDeg), new Vector3(1, 1, 1));
  return decomposeRigid(new Matrix4().fromArray(frame).multiply(local));
}

function decomposeRigid(m: Matrix4): { origin: [number, number, number]; rotationDeg: [number, number, number] } {
  const t = new Vector3();
  const q = new Quaternion();
  m.decompose(t, q, new Vector3());
  const clean = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const r = quaternionToRotateDeg(q);
  return { origin: [clean(t.x), clean(t.y), clean(t.z)], rotationDeg: [clean(r[0]), clean(r[1]), clean(r[2])] };
}

/**
 * "Show parts": the focus path from node `index` of the top level down
 * through every level that holds just one statement the model actually
 * uses, stopping at the first level with several (the parts). Files that
 * build everything inside one module and call it once at the end (often
 * through `if ($preview) ... else ...`) otherwise show as one blob until
 * drilled into by hand, level by level. Returns the drilled-through
 * indices, outermost first; empty when `index` can't be drilled into.
 */
export function partPath(top: WorkingSet, index: number, resolveModule: ModuleResolver, maxDepth = 12): number[] {
  const path: number[] = [];
  let set = top;
  let at = index;
  while (path.length < maxDepth) {
    const target = drillInto(set, at, resolveModule);
    if (!target) break;
    path.push(at);
    set = target.set;
    const live = set.nodes.filter((n) => !guardInactive(set.guards[n.index] ?? null) && nodeModifier(set, n) !== '*');
    if (live.length !== 1 || !drillInto(set, live[0].index, resolveModule)) break;
    at = live[0].index;
  }
  return path;
}
