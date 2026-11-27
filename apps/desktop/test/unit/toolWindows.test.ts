// M10b: the floating tool windows' slot logic (tool-first and
// selection-first), the extrude window's arguments, and window clamping.
import { describe, expect, it } from 'vitest';
import {
  booleanParts,
  defaultExtrudeStatement,
  extrudeArgs,
  initialTool,
  pickIntoTool,
  toolSlotIndices,
  toolTitle,
  withBooleanOp,
  type BooleanToolState,
  type ExtrudeToolState,
} from '../../src/renderer/src/toolWindows';
import { clampPosition } from '../../src/renderer/src/components/FloatingWindow';
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/renderer/src/tools';

describe('boolean window', () => {
  it('fills Base and Subtract from the selection, in click order', () => {
    const t = initialTool('boolean', [3, 1, 2], { booleanOp: 'difference' }) as BooleanToolState;
    expect(t).toMatchObject({ op: 'difference', base: 3, tools: [1, 2], picking: null });
    expect(toolSlotIndices(t)).toEqual([3, 1, 2]);
    expect(toolTitle(t)).toBe('Difference');
  });

  it('starts picking when nothing is selected (tool-first)', () => {
    expect(initialTool('boolean', [], { booleanOp: 'difference' })).toMatchObject({ base: null, tools: [], picking: 'base' });
    expect(initialTool('boolean', [], { booleanOp: 'union' })).toMatchObject({ base: null, tools: [], picking: 'tools' });
    expect(initialTool('boolean', [4], { booleanOp: 'difference' })).toMatchObject({ base: 4, tools: [], picking: 'tools' });
  });

  it('Difference: picking the base moves on to the subtracted parts, which toggle', () => {
    let t = initialTool('boolean', [], { booleanOp: 'difference' });
    t = pickIntoTool(t, 0);
    expect(t).toMatchObject({ base: 0, tools: [], picking: 'tools' });
    t = pickIntoTool(t, 1);
    t = pickIntoTool(t, 2);
    expect(t).toMatchObject({ base: 0, tools: [1, 2], picking: 'tools' });
    t = pickIntoTool(t, 1);
    expect(t).toMatchObject({ base: 0, tools: [2] });
  });

  it('Difference: re-picking the base takes it out of the subtracted parts', () => {
    const t = pickIntoTool({ ...(initialTool('boolean', [0, 1, 2], { booleanOp: 'difference' }) as BooleanToolState), picking: 'base' }, 2);
    expect(t).toMatchObject({ base: 2, tools: [1], picking: null });
  });

  it('Union: one Parts slot whose clicks toggle', () => {
    let t = initialTool('boolean', [], { booleanOp: 'union' }) as BooleanToolState;
    t = pickIntoTool(t, 5) as BooleanToolState;
    t = pickIntoTool(t, 6) as BooleanToolState;
    t = pickIntoTool(t, 7) as BooleanToolState;
    expect(booleanParts(t)).toEqual([5, 6, 7]);
    t = pickIntoTool(t, 5) as BooleanToolState;
    expect(booleanParts(t)).toEqual([6, 7]);
    expect(t.picking).toBe('tools');
  });

  it('switching the operation keeps the parts in order', () => {
    const t = withBooleanOp(initialTool('boolean', [2, 0, 1], { booleanOp: 'union' }) as BooleanToolState, 'difference');
    expect(t).toMatchObject({ op: 'difference', base: 2, tools: [0, 1] });
  });

  it('a click with no slot being picked changes nothing', () => {
    const t = initialTool('boolean', [0, 1], { booleanOp: 'intersection' });
    expect(t.picking).toBeNull();
    expect(pickIntoTool(t, 3)).toBe(t);
  });
});

describe('extrude window', () => {
  const linear = (patch: Partial<ExtrudeToolState> = {}) => ({ ...(initialTool('extrude', [], { extrudeOp: 'linear_extrude' }) as ExtrudeToolState), ...patch });

  it('fills the profile from a single selected part, else waits for a pick', () => {
    expect(initialTool('extrude', [2])).toMatchObject({ profile: 2, picking: null, op: 'linear_extrude' });
    expect(initialTool('extrude', [])).toMatchObject({ profile: null, picking: 'profile' });
    expect(pickIntoTool(initialTool('extrude', []), 4)).toMatchObject({ profile: 4, picking: null });
  });

  it('writes the same defaults as the one-click extrude did', () => {
    expect(extrudeArgs(linear())).toEqual({ ok: true, args: 'height=10' });
    expect(extrudeArgs({ ...linear(), op: 'rotate_extrude' })).toEqual({ ok: true, args: '$fn=48' });
    for (const op of ['linear_extrude', 'rotate_extrude'] as const) {
      const args = extrudeArgs({ ...linear(), op });
      const tool = BUILTIN_TOOL_DEFINITIONS.find((t) => t.callName === op);
      expect(args.ok && defaultExtrudeStatement(op, args.args)).toBe(tool?.statement);
    }
  });

  it('adds center, twist and a partial angle only when set', () => {
    expect(extrudeArgs(linear({ height: 'h', center: true, twist: '90' }))).toEqual({ ok: true, args: 'height=h, center=true, twist=90' });
    expect(extrudeArgs(linear({ twist: '0' }))).toEqual({ ok: true, args: 'height=10' });
    expect(extrudeArgs({ ...linear(), op: 'rotate_extrude', angle: '180' })).toEqual({ ok: true, args: 'angle=180, $fn=48' });
    expect(extrudeArgs(linear({ height: ' ' })).ok).toBe(false);
    expect(extrudeArgs({ ...linear(), op: 'rotate_extrude', angle: '' }).ok).toBe(false);
  });
});

describe('relate and pattern windows keep the M11 behavior', () => {
  it('Distance: Move then Relative to, a new pair resets the distance', () => {
    let t = initialTool('distance', []);
    expect(t).toMatchObject({ move: null, reference: null, picking: 'move', offset: '' });
    t = pickIntoTool(t, 1);
    expect(t).toMatchObject({ move: 1, picking: 'reference' });
    t = pickIntoTool(t, 0);
    expect(t).toMatchObject({ move: 1, reference: 0, picking: null });
  });

  it('Pattern takes the last selected part', () => {
    expect(initialTool('pattern', [0, 3])).toMatchObject({ part: 3, picking: null });
  });
});

describe('clampPosition', () => {
  const size = { width: 290, height: 400 };
  it('keeps the window inside the viewport', () => {
    expect(clampPosition({ x: -50, y: -10 }, size, { width: 800, height: 600 })).toEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 900, y: 900 }, size, { width: 800, height: 600 })).toEqual({ x: 502, y: 560 });
  });
  it('pins to the corner when the viewport is narrower than the window', () => {
    expect(clampPosition({ x: 100, y: 100 }, size, { width: 200, height: 30 })).toEqual({ x: 8, y: 8 });
  });
});
