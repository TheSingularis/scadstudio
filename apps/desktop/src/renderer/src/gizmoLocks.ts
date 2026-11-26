import type { NodeTransform } from './targetedPatch';

// M11: which gizmo handles a node gets when some of its transform is
// written as an expression. An expression axis is set by the expression
// (PLAN.md M11 decision 8: the gizmo doesn't drag it), so its handles are
// hidden; the literal axes still drag. Rotation is all or nothing: a
// rotate ring turns about one axis but changes all three Euler angles.
//
// Exception (Jordan, 2026-11-26): a translate axis whose expression moves
// with a position variable drags, by moving that variable, so the parts
// linked through it move together (linkedDrag.ts decides which; `free`).

export type GizmoAxesMode = 'translate' | 'rotate' | 'scale';

export interface GizmoAxes {
  visible: boolean;
  show: [boolean, boolean, boolean];
  // The axes that are locked, for the note under the toolbar.
  locked: { axis: 0 | 1 | 2; text: string }[];
  // Translate axes that drag by moving a position variable.
  driven: { axis: 0 | 1 | 2; text: string }[];
}

function axisAligned(frame: number[] | undefined): boolean {
  if (!frame) return true;
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const upper = [frame[0], frame[1], frame[2], frame[4], frame[5], frame[6], frame[8], frame[9], frame[10]];
  return upper.every((v, i) => Math.abs(v - identity[i]) < 1e-9);
}

export function gizmoAxes(
  transform: NodeTransform,
  frame: number[] | undefined,
  mode: GizmoAxesMode,
  free: readonly boolean[] = [false, false, false],
): GizmoAxes {
  const e = transform.exprs;
  const texts = mode === 'translate' ? e?.translate : mode === 'rotate' ? e?.rotateDeg : e?.scale;
  const driven: { axis: 0 | 1 | 2; text: string }[] = [];
  const locked: { axis: 0 | 1 | 2; text: string }[] = [];
  (texts ?? []).forEach((text, axis) => {
    if (text === null) return;
    if (mode === 'translate' && free[axis]) driven.push({ axis: axis as 0 | 1 | 2, text });
    else locked.push({ axis: axis as 0 | 1 | 2, text });
  });
  if (locked.length === 0) return { visible: true, show: [true, true, true], locked, driven };
  const show: [boolean, boolean, boolean] = [true, true, true];
  for (const l of locked) show[l.axis] = false;
  // Rotation can't be split per axis; translate's handles are world-space,
  // which only line up with the node's own axes in an unrotated frame.
  const splittable = mode === 'scale' || (mode === 'translate' && axisAligned(frame));
  const visible = splittable && show.some(Boolean);
  return { visible, show, locked, driven };
}
