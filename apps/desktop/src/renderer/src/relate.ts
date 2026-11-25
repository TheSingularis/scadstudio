import type { Node, Tree } from 'web-tree-sitter';
import type { SceneNode } from './sceneGraph';
import { transformEdit, type NodeTransform, type TransformExprs } from './targetedPatch';
import { edgeOf, partExtents, type Edge } from './extents';
import { add, constant, format, fromTerm, sub, term, value, type Lin } from './linExpr';
import { applyEdits, insertVariableEdit, isValidName, uniqueName, type TextEdit } from './variables';
import { evaluateNumber } from './scadExpr';

// M11 Distance and Align: place the "Move" part's edge at the "Relative
// to" part's edge plus an offset, along one axis, by writing the Move
// part's translate component as an expression of the reference part's
// position and size. No solver: the expression is the constraint, and
// OpenSCAD re-evaluates it whenever a variable it reads changes.
//
// For the Move part to follow when the reference moves or is resized, the
// reference's position and size have to be variables (a literal number in
// the expression would be a copy). With `follow`, every literal the
// expression would otherwise copy (the reference's translate on that axis
// and the sizes behind both parts' edges) becomes a named variable first.

export interface RelateRequest {
  move: SceneNode;
  reference: SceneNode;
  axis: 0 | 1 | 2;
  moveEdge: Edge;
  referenceEdge: Edge;
  // The offset: a number or any expression.
  offsetText: string;
  // Name the offset as a variable (e.g. `gap`), or null to write it inline.
  offsetName: string | null;
  follow: boolean;
  measureMove: () => { min: number[]; max: number[] } | null;
  measureReference: () => { min: number[]; max: number[] } | null;
}

export interface RelatePlan {
  source: string;
  // The Move part's new translate component.
  expression: string;
  // Variables the edit adds, in order.
  newVariables: { name: string; valueText: string }[];
  // A part whose own size is measured: the result won't follow its size.
  measured: { move: boolean; reference: boolean };
}

export type RelateResult = { ok: true; plan: RelatePlan } | { ok: false; reason: string };

const AXIS = ['x', 'y', 'z'];
const NUMBER = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** The current distance from the reference edge to the move edge (a default offset). */
export function currentOffset(
  tree: Tree,
  req: Pick<RelateRequest, 'move' | 'reference' | 'axis' | 'moveEdge' | 'referenceEdge' | 'measureMove' | 'measureReference'>,
): number | null {
  const a = partExtents(tree, req.move, req.measureMove);
  const b = partExtents(tree, req.reference, req.measureReference);
  if (!a || !b) return null;
  const d = value(edgeOf(a.axes[req.axis], req.moveEdge)) - value(edgeOf(b.axes[req.axis], req.referenceEdge));
  return Number.isFinite(d) ? Math.round(d * 1000) / 1000 : null;
}

function linOf(node: Node): Lin {
  if (NUMBER.test(node.text)) return constant(Number(node.text));
  return fromTerm(term(node.text, evaluateNumber(node) ?? NaN));
}

function copyExprs(t: NodeTransform): TransformExprs {
  return t.exprs
    ? { translate: [...t.exprs.translate], rotateDeg: [...t.exprs.rotateDeg], scale: [...t.exprs.scale] }
    : { translate: [null, null, null], rotateDeg: [null, null, null], scale: [null, null, null] };
}

export function planRelate(source: string, tree: Tree, req: RelateRequest): RelateResult {
  if (req.move.startIndex === req.reference.startIndex) return { ok: false, reason: 'Pick two different parts.' };
  if (req.move.startIndex < req.reference.endIndex && req.reference.startIndex < req.move.endIndex) {
    return { ok: false, reason: 'One part is inside the other.' };
  }
  const root = tree.rootNode;
  const k = req.axis;
  const taken = new Set<string>();
  const nameFor = (suggested: string) => {
    const name = uniqueName(root, suggested, taken);
    taken.add(name);
    return name;
  };
  // Literals the expression may copy, by their start offset: named
  // tentatively, kept only if the name survives into the expression.
  const tentative = new Map<number, { name: string; node: Node }>();
  const promote = req.follow
    ? (node: Node, suggested: string) => {
        const existing = tentative.get(node.startIndex);
        if (existing) return existing.name;
        const name = nameFor(suggested);
        tentative.set(node.startIndex, { name, node });
        return name;
      }
    : null;

  const a = partExtents(tree, req.move, req.measureMove, promote);
  const b = partExtents(tree, req.reference, req.measureReference, promote);
  if (!a) return { ok: false, reason: 'The part to move has no position the app can edit.' };
  if (!b) return { ok: false, reason: 'The reference part has no position the app can read.' };

  // The reference's translate along the axis, named when it is a literal.
  const tNode = b.axes[k].translate.node;
  const tValue = b.axes[k].translate.value;
  const tLin = tNode ? linOf(tNode) : constant(tValue);
  let refTranslate = tLin;
  let refTranslateName: string | null = null;
  if (req.follow && (!tNode || NUMBER.test(tNode.text))) {
    refTranslateName = nameFor(`${b.callName ?? 'part'}_${AXIS[k]}`);
    refTranslate = fromTerm(term(refTranslateName, tValue));
  }
  const refEdge = add(refTranslate, sub(edgeOf(b.axes[k], req.referenceEdge), tLin));

  // The Move part's edge relative to its own translate.
  const aTNode = a.axes[k].translate.node;
  const moveLocal = sub(edgeOf(a.axes[k], req.moveEdge), aTNode ? linOf(aTNode) : constant(a.axes[k].translate.value));

  const newVariables: { name: string; valueText: string }[] = [];
  const offsetText = req.offsetText.trim() === '' ? '0' : req.offsetText.trim();
  const offsetIsNumber = NUMBER.test(offsetText);
  let offset: Lin;
  let offsetVariable: { name: string; valueText: string } | null = null;
  if (req.offsetName) {
    if (!isValidName(req.offsetName)) return { ok: false, reason: `"${req.offsetName}" isn't a valid variable name.` };
    const name = nameFor(req.offsetName);
    offsetVariable = { name, valueText: offsetText };
    offset = fromTerm(term(name, offsetIsNumber ? Number(offsetText) : NaN));
  } else {
    offset = offsetIsNumber ? constant(Number(offsetText)) : fromTerm(term(offsetText, NaN));
  }

  const result = sub(add(refEdge, offset), moveLocal);
  const expression = format(result);
  const used = new Set(result.terms.map((t) => t.term.text));

  const edits: TextEdit[] = [];
  if (refTranslateName && used.has(refTranslateName)) {
    newVariables.push({ name: refTranslateName, valueText: tNode ? tNode.text.trim() : '0' });
    if (tNode) {
      edits.push({ start: tNode.startIndex, end: tNode.endIndex, text: refTranslateName });
    } else {
      // No translate() yet: give the reference one that reads the variable.
      const t = b.decomposed.transform;
      const exprs = copyExprs(t);
      exprs.translate[k] = refTranslateName;
      const edit = transformEdit(source, tree, req.reference, { ...t, exprs });
      if (!edit) return { ok: false, reason: 'The reference part has no position the app can edit.' };
      edits.push(edit);
    }
  }
  for (const { name, node } of [...tentative.values()].sort((x, y) => x.node.startIndex - y.node.startIndex)) {
    if (!used.has(name)) continue;
    newVariables.push({ name, valueText: node.text.trim() });
    edits.push({ start: node.startIndex, end: node.endIndex, text: name });
  }
  if (offsetVariable) newVariables.push(offsetVariable);

  // The Move part's translate component becomes the expression. Its own
  // promoted sizes sit inside its primitive, after the prefix this edit
  // replaces, so the edits never overlap.
  const t = a.decomposed.transform;
  const exprs = copyExprs(t);
  exprs.translate[k] = expression;
  const translate = [...t.translate] as [number, number, number];
  const v = value(result);
  if (Number.isFinite(v)) translate[k] = v;
  const moveEdit = transformEdit(source, tree, req.move, { ...t, translate, exprs });
  if (!moveEdit) return { ok: false, reason: 'The part to move has no position the app can edit.' };
  edits.push(moveEdit);

  if (newVariables.length > 0) {
    const insert = insertVariableEdit(source, root, '__m11_placeholder__', '0');
    insert.text = insert.text.replace('__m11_placeholder__ = 0;', newVariables.map((nv) => `${nv.name} = ${nv.valueText};`).join('\n'));
    edits.push(insert);
  }
  let next: string;
  try {
    next = applyEdits(source, edits);
  } catch {
    return { ok: false, reason: 'Those two parts overlap in the source.' };
  }
  return { ok: true, plan: { source: next, expression, newVariables, measured: { move: a.axes[k].measured, reference: b.axes[k].measured } } };
}
