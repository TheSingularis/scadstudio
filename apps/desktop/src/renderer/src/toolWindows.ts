import type { BooleanOp, ExtrudeOp } from './targetedPatch';
import type { Edge } from './extents';

// M10b: the state of the one open tool window (tool-first, like Onshape's
// feature dialogs). Each tool has labeled part slots; clicking a slot and
// then a part in the viewport fills it, and nothing is written until Apply.
// The selection-first path still works: whatever is selected when a tool
// starts fills its slots.

export type RelateKind = 'distance' | 'align';

export interface RelateToolState {
  kind: RelateKind;
  move: number | null;
  reference: number | null;
  picking: 'move' | 'reference' | null;
  axis: 0 | 1 | 2;
  moveEdge: Edge;
  referenceEdge: Edge;
  offset: string;
  // Name the offset as a variable ('' writes it inline).
  offsetName: string;
  follow: boolean;
}

export interface PatternToolState {
  kind: 'pattern';
  part: number | null;
  picking: 'part' | null;
  mode: 'linear' | 'circular';
  axis: 0 | 1 | 2;
  count: string;
  // Linear: center-to-center pitch, or the gap between copies.
  spacingMode: 'pitch' | 'gap';
  spacing: string;
  // Circular: full circle, or a fixed step angle.
  fullCircle: boolean;
  step: string;
}

// Union / Difference / Intersection. Difference has a Base slot (one part)
// and a Subtract slot (any number); Union and Intersection have one Parts
// slot. Either way the parts are written in the order [base, ...tools].
export interface BooleanToolState {
  kind: 'boolean';
  op: BooleanOp;
  base: number | null;
  tools: number[];
  picking: 'base' | 'tools' | null;
}

// Linear / Rotate Extrude of one 2D profile. With no profile, Apply inserts
// a new default extrusion (the M7 behavior with nothing selected).
export interface ExtrudeToolState {
  kind: 'extrude';
  op: ExtrudeOp;
  profile: number | null;
  picking: 'profile' | null;
  height: string;
  center: boolean;
  twist: string;
  angle: string;
}

export type ToolState = RelateToolState | PatternToolState | BooleanToolState | ExtrudeToolState;
export type ToolKind = ToolState['kind'];

export const BOOLEAN_LABELS: Record<BooleanOp, string> = { union: 'Union', difference: 'Difference', intersection: 'Intersection' };
export const EXTRUDE_LABELS: Record<ExtrudeOp, string> = { linear_extrude: 'Linear Extrude', rotate_extrude: 'Rotate Extrude' };

export function toolTitle(tool: ToolState): string {
  switch (tool.kind) {
    case 'distance':
      return 'Distance';
    case 'align':
      return 'Align';
    case 'pattern':
      return 'Pattern';
    case 'boolean':
      return BOOLEAN_LABELS[tool.op];
    case 'extrude':
      return EXTRUDE_LABELS[tool.op];
  }
}

// The parts a tool's slots hold, in the order the viewport highlights them
// (the first in the "selected" amber, the rest in the operand red).
export function toolSlotIndices(tool: ToolState): number[] {
  const slots =
    tool.kind === 'pattern'
      ? [tool.part]
      : tool.kind === 'boolean'
        ? [tool.base, ...tool.tools]
        : tool.kind === 'extrude'
          ? [tool.profile]
          : [tool.move, tool.reference];
  return slots.filter((i): i is number => i !== null);
}

// A new tool window, its slots filled from the current selection.
export function initialTool(kind: ToolKind, selection: number[], opts: { booleanOp?: BooleanOp; extrudeOp?: ExtrudeOp } = {}): ToolState {
  if (kind === 'pattern') {
    const part = selection.length > 0 ? selection[selection.length - 1] : null;
    return { kind, part, picking: part === null ? 'part' : null, mode: 'linear', axis: 0, count: '3', spacingMode: 'pitch', spacing: '', fullCircle: true, step: '30' };
  }
  if (kind === 'boolean') {
    const [base = null, ...tools] = selection;
    const op = opts.booleanOp ?? 'union';
    const picking = op !== 'difference' ? (tools.length === 0 ? 'tools' : null) : base === null ? 'base' : tools.length === 0 ? 'tools' : null;
    return { kind, op, base, tools, picking };
  }
  if (kind === 'extrude') {
    const profile = selection.length === 1 ? selection[0] : null;
    return { kind, op: opts.extrudeOp ?? 'linear_extrude', profile, picking: profile === null ? 'profile' : null, height: '10', center: false, twist: '', angle: '360' };
  }
  const move = selection[0] ?? null;
  const reference = selection[1] ?? null;
  return {
    kind,
    move,
    reference,
    picking: move === null ? 'move' : reference === null ? 'reference' : null,
    axis: 0,
    moveEdge: kind === 'distance' ? 'min' : 'center',
    referenceEdge: kind === 'distance' ? 'max' : 'center',
    offset: kind === 'distance' ? '' : '0',
    offsetName: kind === 'distance' ? 'gap' : '',
    follow: true,
  };
}

// A click on part `index` while the tool's `picking` slot is active. Returns
// the tool unchanged when no slot is being picked.
export function pickIntoTool(tool: ToolState, index: number): ToolState {
  if (!tool.picking) return tool;
  switch (tool.kind) {
    case 'pattern':
      return { ...tool, part: index, picking: null, spacing: tool.part === index ? tool.spacing : '' };
    case 'extrude':
      return { ...tool, profile: index, picking: null };
    case 'boolean': {
      if (tool.picking === 'base') {
        // Picking the base takes it out of the tools; the old base is
        // dropped (not moved to the tools: re-pick it there if wanted).
        const tools = tool.tools.filter((i) => i !== index);
        return { ...tool, base: index, tools, picking: tools.length === 0 ? 'tools' : null };
      }
      // Tools (Union / Intersection: the one Parts slot): a click toggles
      // the part in or out and keeps picking, so several can be added in a
      // row.
      if (tool.op !== 'difference') {
        const parts = booleanParts(tool);
        const [base = null, ...tools] = parts.includes(index) ? parts.filter((i) => i !== index) : [...parts, index];
        return { ...tool, base, tools };
      }
      if (tool.tools.includes(index)) return { ...tool, tools: tool.tools.filter((i) => i !== index) };
      // Difference: a click on the base moves it to the subtracted parts.
      if (tool.base === index) return { ...tool, base: null, tools: [...tool.tools, index], picking: 'base' };
      return { ...tool, tools: [...tool.tools, index] };
    }
    default: {
      const next = { ...tool, [tool.picking]: index };
      const picking = tool.picking === 'move' && next.reference === null ? 'reference' : null;
      // A new pair gets a fresh default distance.
      return { ...next, picking, offset: tool.kind === 'distance' ? '' : tool.offset };
    }
  }
}

// Union / Intersection show one "Parts" slot; the order inside it only
// matters to Difference.
export function booleanParts(tool: BooleanToolState): number[] {
  return [tool.base, ...tool.tools].filter((i): i is number => i !== null);
}

// Switching the operation keeps the parts in the same order.
export function withBooleanOp(tool: BooleanToolState, op: BooleanOp): BooleanToolState {
  const parts = booleanParts(tool);
  const [base = null, ...tools] = parts;
  // Difference waits for its Base first; the others have no Base slot.
  const picking = op === 'difference' ? (base === null ? 'base' : tool.picking === null && tools.length === 0 ? 'tools' : tool.picking) : tool.picking === 'base' ? 'tools' : tool.picking;
  return { ...tool, op, base, tools, picking };
}

const NUMBER = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

// The extrude call's arguments from the window's fields. Defaults are left
// out (twist 0, a full 360° turn), so the defaults write exactly what M7's
// one-click extrude wrote: `height=10` and `$fn=48`.
export function extrudeArgs(tool: ExtrudeToolState): { ok: true; args: string } | { ok: false; reason: string } {
  if (tool.op === 'linear_extrude') {
    const height = tool.height.trim();
    if (height === '') return { ok: false, reason: 'Enter a height.' };
    const parts = [`height=${height}`];
    if (tool.center) parts.push('center=true');
    const twist = tool.twist.trim();
    if (twist !== '' && !(NUMBER.test(twist) && Number(twist) === 0)) parts.push(`twist=${twist}`);
    return { ok: true, args: parts.join(', ') };
  }
  const angle = tool.angle.trim();
  if (angle === '') return { ok: false, reason: 'Enter an angle (360 for a full turn).' };
  const full = NUMBER.test(angle) && Number(angle) === 360;
  return { ok: true, args: full ? '$fn=48' : `angle=${angle}, $fn=48` };
}

// What Apply inserts when the Extrude window has no profile.
export function defaultExtrudeStatement(op: ExtrudeOp, args: string): string {
  return op === 'linear_extrude' ? `linear_extrude(${args}) circle(r=5, $fn=32);` : `rotate_extrude(${args}) translate([15, 0, 0]) circle(r=4, $fn=32);`;
}
