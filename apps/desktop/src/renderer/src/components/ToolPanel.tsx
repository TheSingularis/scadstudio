import { SELECTED_MESH_COLOR, OPERAND_MESH_COLOR } from './Viewport';
import type { Edge } from '../extents';
import { FloatingWindow, WindowRow } from './FloatingWindow';
import {
  BOOLEAN_LABELS,
  booleanParts,
  toolTitle,
  withBooleanOp,
  type BooleanToolState,
  type ExtrudeToolState,
  type PatternToolState,
  type RelateToolState,
  type ToolState,
} from '../toolWindows';
import type { BooleanOp, ExtrudeOp } from '../targetedPatch';

export type { RelateKind, ToolState } from '../toolWindows';

// M11 tool panel, M10b floating window: Distance, Align, Pattern, the
// booleans and the extrudes. Tool-first, like Onshape's feature dialogs:
// each part slot is labeled, shows which part fills it in the same color
// the viewport highlights it in, and is re-picked by clicking the slot and
// then a part. Nothing is written until Apply.

export interface ToolPanelProps {
  tool: ToolState;
  labelOf: (index: number | null) => string | null;
  onChange: (tool: ToolState) => void;
  onApply: () => void;
  onCancel: () => void;
  // What Apply would write, or why it can't.
  preview: { ok: true; lines: string[]; notes: string[] } | { ok: false; reason: string } | null;
  // Pattern: whether the part's width is known (the gap option needs it).
  gapAvailable?: boolean;
  // Extrude: Apply with an empty profile inserts a new default extrusion.
  applyLabel?: string;
}

const AXES = ['X', 'Y', 'Z'] as const;
const EDGES: { edge: Edge; label: string }[] = [
  { edge: 'min', label: 'min' },
  { edge: 'center', label: 'center' },
  { edge: 'max', label: 'max' },
];

function SlotButton({
  label,
  color,
  part,
  active,
  onPick,
  hint = 'click a part…',
}: {
  label: string;
  color: string;
  part: string | null;
  active: boolean;
  onPick: () => void;
  hint?: string;
}) {
  return (
    <button
      data-testid={`slot-${label.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={onPick}
      aria-pressed={active}
      title={active ? 'Click a part in the viewport' : `Click, then click a part to set "${label}"`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        border: active ? `2px solid ${color}` : '1px solid #556',
        background: active ? '#2b3b49' : '#25303a',
        color: '#eee',
        padding: active ? '3px 7px' : '4px 8px',
        borderRadius: 4,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }} />
      <span style={{ opacity: 0.75, flex: 'none' }}>{label}:</span>
      <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active ? hint : (part ?? 'none')}</span>
    </button>
  );
}

function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 0 }} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          style={{ fontWeight: o.value === value ? 'bold' : 'normal', background: o.value === value ? '#3a5068' : undefined }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

const experimentalBadge = (
  <span
    role="note"
    data-testid="tool-experimental"
    title="Distance and Align will be redone with a real constraint solver (picking faces, with dimension lines). What they write stays plain OpenSCAD and keeps working."
    style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#e8a05a', border: '1px solid #e8a05a', borderRadius: 3, padding: '0 4px', flex: 'none' }}
  >
    experimental
  </span>
);

function RelateFields({ tool, labelOf, onChange }: { tool: RelateToolState; labelOf: ToolPanelProps['labelOf']; onChange: (t: ToolState) => void }) {
  return (
    <>
      <SlotButton label="Move" color={SELECTED_MESH_COLOR} part={labelOf(tool.move)} active={tool.picking === 'move'} onPick={() => onChange({ ...tool, picking: 'move' })} />
      <SlotButton
        label="Relative to"
        color={OPERAND_MESH_COLOR}
        part={labelOf(tool.reference)}
        active={tool.picking === 'reference'}
        onPick={() => onChange({ ...tool, picking: 'reference' })}
      />
      <WindowRow label="Axis">
        <Choice label="Axis" value={tool.axis} options={AXES.map((a, i) => ({ value: i as 0 | 1 | 2, label: a }))} onChange={(axis) => onChange({ ...tool, axis })} />
      </WindowRow>
      <WindowRow label="Move's">
        <Choice label="Move edge" value={tool.moveEdge} options={EDGES.map((e) => ({ value: e.edge, label: e.label }))} onChange={(moveEdge) => onChange({ ...tool, moveEdge })} />
      </WindowRow>
      <WindowRow label="at reference's">
        <Choice
          label="Reference edge"
          value={tool.referenceEdge}
          options={EDGES.map((e) => ({ value: e.edge, label: e.label }))}
          onChange={(referenceEdge) => onChange({ ...tool, referenceEdge })}
        />
      </WindowRow>
      <WindowRow label={tool.kind === 'distance' ? 'Distance' : 'Offset'}>
        <input aria-label="Offset" type="text" size={8} value={tool.offset} onChange={(e) => onChange({ ...tool, offset: e.target.value })} />
      </WindowRow>
      <WindowRow label="as variable" title="Write the offset as a named variable (leave empty to write the number inline)">
        <input aria-label="Offset variable name" type="text" size={10} placeholder="(inline)" value={tool.offsetName} onChange={(e) => onChange({ ...tool, offsetName: e.target.value })} />
      </WindowRow>
      <label
        title="Name the reference's position and the sizes the expression reads as variables, so the moved part follows when they change"
        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
      >
        <input type="checkbox" checked={tool.follow} onChange={(e) => onChange({ ...tool, follow: e.target.checked })} />
        Follow changes
      </label>
    </>
  );
}

function PatternFields({ tool, labelOf, onChange, gapAvailable }: { tool: PatternToolState; labelOf: ToolPanelProps['labelOf']; onChange: (t: ToolState) => void; gapAvailable?: boolean }) {
  return (
    <>
      <SlotButton label="Part" color={SELECTED_MESH_COLOR} part={labelOf(tool.part)} active={tool.picking === 'part'} onPick={() => onChange({ ...tool, picking: 'part' })} />
      <WindowRow label="Kind">
        <Choice
          label="Pattern kind"
          value={tool.mode}
          options={[
            { value: 'linear', label: 'Linear' },
            { value: 'circular', label: 'Circular' },
          ]}
          onChange={(mode) => onChange({ ...tool, mode })}
        />
      </WindowRow>
      <WindowRow label={tool.mode === 'linear' ? 'Along' : 'Around'}>
        <Choice label="Axis" value={tool.axis} options={AXES.map((a, i) => ({ value: i as 0 | 1 | 2, label: a }))} onChange={(axis) => onChange({ ...tool, axis })} />
      </WindowRow>
      <WindowRow label="Count">
        <input aria-label="Count" type="text" size={5} value={tool.count} onChange={(e) => onChange({ ...tool, count: e.target.value })} />
      </WindowRow>
      {tool.mode === 'linear' ? (
        <WindowRow label="Spacing">
          <Choice
            label="Spacing mode"
            value={tool.spacingMode}
            options={[{ value: 'pitch', label: 'Pitch' }, ...(gapAvailable ? [{ value: 'gap' as const, label: 'Gap' }] : [])]}
            onChange={(spacingMode) => onChange({ ...tool, spacingMode })}
          />
          <input
            aria-label="Spacing"
            type="text"
            size={6}
            title={tool.spacingMode === 'pitch' ? 'Center-to-center distance between copies' : 'Clear space between copies'}
            value={tool.spacing}
            onChange={(e) => onChange({ ...tool, spacing: e.target.value })}
          />
        </WindowRow>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={tool.fullCircle} onChange={(e) => onChange({ ...tool, fullCircle: e.target.checked })} />
            Full circle
          </label>
          {!tool.fullCircle && (
            <WindowRow label="Step°">
              <input aria-label="Step angle" type="text" size={6} value={tool.step} onChange={(e) => onChange({ ...tool, step: e.target.value })} />
            </WindowRow>
          )}
        </>
      )}
    </>
  );
}

const BOOLEAN_OPS: BooleanOp[] = ['union', 'difference', 'intersection'];

function BooleanFields({ tool, labelOf, onChange }: { tool: BooleanToolState; labelOf: ToolPanelProps['labelOf']; onChange: (t: ToolState) => void }) {
  const list = (indices: number[]) => (indices.length === 0 ? null : indices.map((i) => labelOf(i) ?? `#${i + 1}`).join(', '));
  return (
    <>
      <WindowRow label="Operation">
        <Choice label="Boolean operation" value={tool.op} options={BOOLEAN_OPS.map((op) => ({ value: op, label: BOOLEAN_LABELS[op] }))} onChange={(op) => onChange(withBooleanOp(tool, op))} />
      </WindowRow>
      {tool.op === 'difference' ? (
        <>
          <SlotButton label="Base" color={SELECTED_MESH_COLOR} part={labelOf(tool.base)} active={tool.picking === 'base'} onPick={() => onChange({ ...tool, picking: 'base' })} />
          <SlotButton
            label="Subtract"
            color={OPERAND_MESH_COLOR}
            part={list(tool.tools)}
            active={tool.picking === 'tools'}
            hint={tool.tools.length === 0 ? 'click parts to subtract…' : `${list(tool.tools)} (click parts to add or remove)`}
            onPick={() => onChange({ ...tool, picking: tool.picking === 'tools' ? null : 'tools' })}
          />
        </>
      ) : (
        <SlotButton
          label="Parts"
          color={SELECTED_MESH_COLOR}
          part={list(booleanParts(tool))}
          active={tool.picking === 'tools'}
          hint={booleanParts(tool).length === 0 ? 'click parts…' : `${list(booleanParts(tool))} (click to add or remove)`}
          onPick={() => onChange({ ...tool, picking: tool.picking === 'tools' ? null : 'tools' })}
        />
      )}
    </>
  );
}

const EXTRUDE_OPS: { value: ExtrudeOp; label: string }[] = [
  { value: 'linear_extrude', label: 'Linear' },
  { value: 'rotate_extrude', label: 'Rotate' },
];

function ExtrudeFields({ tool, labelOf, onChange }: { tool: ExtrudeToolState; labelOf: ToolPanelProps['labelOf']; onChange: (t: ToolState) => void }) {
  return (
    <>
      <WindowRow label="Kind">
        <Choice label="Extrude kind" value={tool.op} options={EXTRUDE_OPS} onChange={(op) => onChange({ ...tool, op })} />
      </WindowRow>
      <SlotButton
        label="Profile"
        color={SELECTED_MESH_COLOR}
        part={labelOf(tool.profile)}
        active={tool.picking === 'profile'}
        hint="click a 2D part (sketch, square, circle, text)…"
        onPick={() => onChange({ ...tool, picking: 'profile' })}
      />
      {tool.op === 'linear_extrude' ? (
        <>
          <WindowRow label="Height">
            <input aria-label="Extrude height" type="text" size={8} value={tool.height} onChange={(e) => onChange({ ...tool, height: e.target.value })} />
          </WindowRow>
          <WindowRow label="Twist°" title="Degrees the profile turns over the height (empty or 0 for none)">
            <input aria-label="Extrude twist" type="text" size={8} placeholder="0" value={tool.twist} onChange={(e) => onChange({ ...tool, twist: e.target.value })} />
          </WindowRow>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="Extrude half the height down and half up">
            <input type="checkbox" checked={tool.center} onChange={(e) => onChange({ ...tool, center: e.target.checked })} />
            Centered on the plane
          </label>
        </>
      ) : (
        <WindowRow label="Angle°" title="How far the profile turns around Z (360 for a full turn)">
          <input aria-label="Extrude angle" type="text" size={8} value={tool.angle} onChange={(e) => onChange({ ...tool, angle: e.target.value })} />
        </WindowRow>
      )}
    </>
  );
}

export function ToolPanel(props: ToolPanelProps) {
  const { tool, onChange, labelOf } = props;
  const title = toolTitle(tool);
  return (
    <FloatingWindow
      title={title}
      label={`${title} tool`}
      storageKey="tool"
      testId="tool-window"
      badge={tool.kind === 'distance' || tool.kind === 'align' ? experimentalBadge : undefined}
      onClose={props.onCancel}
      footer={
        <>
          <button onClick={props.onApply} disabled={!props.preview?.ok} style={{ fontWeight: 'bold' }}>
            {props.applyLabel ?? 'Apply'}
          </button>
          <button onClick={props.onCancel}>Cancel</button>
        </>
      }
    >
      {tool.kind === 'pattern' ? (
        <PatternFields tool={tool} labelOf={labelOf} onChange={onChange} gapAvailable={props.gapAvailable} />
      ) : tool.kind === 'boolean' ? (
        <BooleanFields tool={tool} labelOf={labelOf} onChange={onChange} />
      ) : tool.kind === 'extrude' ? (
        <ExtrudeFields tool={tool} labelOf={labelOf} onChange={onChange} />
      ) : (
        <RelateFields tool={tool} labelOf={labelOf} onChange={onChange} />
      )}
      {props.preview && (
        <div data-testid="tool-preview" style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.9, borderTop: '1px solid #34495c', paddingTop: 6, overflowWrap: 'anywhere' }}>
          {props.preview.ok ? (
            <>
              {props.preview.lines.map((l, i) => (
                <div key={`${i}:${l}`}>{l}</div>
              ))}
              {props.preview.notes.map((n) => (
                <div key={n} role="note" style={{ color: '#e8a05a', fontFamily: 'sans-serif', marginTop: 2 }}>
                  {n}
                </div>
              ))}
            </>
          ) : (
            <span style={{ fontFamily: 'sans-serif', opacity: 0.8 }}>{props.preview.reason}</span>
          )}
        </div>
      )}
    </FloatingWindow>
  );
}
