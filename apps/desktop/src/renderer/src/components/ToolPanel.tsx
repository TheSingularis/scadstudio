import { SELECTED_MESH_COLOR, OPERAND_MESH_COLOR } from './Viewport';
import type { Edge } from '../extents';

// M11: the docked tool panel for Distance, Align and Pattern (PLAN.md M11
// decision 4). Tool-first, like Onshape's feature dialogs: each part slot
// is labeled, shows which part fills it in the same color the viewport
// highlights it in, and is re-picked by clicking the slot and then a part.
// Nothing is written until Apply.

export type RelateKind = 'distance' | 'align';
export type Slot = 'move' | 'reference' | 'part';

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

export type ToolState = RelateToolState | PatternToolState;

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
}

const AXES = ['X', 'Y', 'Z'] as const;
const EDGES: { edge: Edge; label: string }[] = [
  { edge: 'min', label: 'min' },
  { edge: 'center', label: 'center' },
  { edge: 'max', label: 'max' },
];

const strip: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '6px 12px',
  background: '#1f2a33',
  color: '#ddd',
  fontSize: 12,
  borderBottom: '1px solid #345',
};

function SlotButton({ label, color, part, active, onPick }: { label: string; color: string; part: string | null; active: boolean; onPick: () => void }) {
  return (
    <button
      data-testid={`slot-${label.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={onPick}
      aria-pressed={active}
      title={active ? 'Click a part in the viewport' : `Click, then click a part to set "${label}"`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        border: active ? `2px solid ${color}` : '1px solid #556',
        background: active ? '#2b3b49' : '#25303a',
        color: '#eee',
        padding: '2px 8px',
        borderRadius: 4,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ opacity: 0.75 }}>{label}:</span>
      <span style={{ fontFamily: 'monospace' }}>{active ? 'click a part…' : (part ?? 'none')}</span>
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

export function ToolPanel(props: ToolPanelProps) {
  const { tool, onChange } = props;
  const title = tool.kind === 'distance' ? 'Distance' : tool.kind === 'align' ? 'Align' : 'Pattern';
  return (
    <div role="region" aria-label={`${title} tool`} style={strip}>
      <strong>{title}</strong>
      {tool.kind !== 'pattern' ? (
        <>
          <span
            role="note"
            data-testid="tool-experimental"
            title="Distance and Align will be redone with a real constraint solver (picking faces, with dimension lines). What they write stays plain OpenSCAD and keeps working."
            style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#e8a05a', border: '1px solid #e8a05a', borderRadius: 3, padding: '0 4px' }}
          >
            experimental
          </span>
          <SlotButton label="Move" color={SELECTED_MESH_COLOR} part={props.labelOf(tool.move)} active={tool.picking === 'move'} onPick={() => onChange({ ...tool, picking: 'move' })} />
          <SlotButton
            label="Relative to"
            color={OPERAND_MESH_COLOR}
            part={props.labelOf(tool.reference)}
            active={tool.picking === 'reference'}
            onPick={() => onChange({ ...tool, picking: 'reference' })}
          />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Axis <Choice label="Axis" value={tool.axis} options={AXES.map((a, i) => ({ value: i as 0 | 1 | 2, label: a }))} onChange={(axis) => onChange({ ...tool, axis })} />
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Move's <Choice label="Move edge" value={tool.moveEdge} options={EDGES.map((e) => ({ value: e.edge, label: e.label }))} onChange={(moveEdge) => onChange({ ...tool, moveEdge })} />
            at reference's{' '}
            <Choice label="Reference edge" value={tool.referenceEdge} options={EDGES.map((e) => ({ value: e.edge, label: e.label }))} onChange={(referenceEdge) => onChange({ ...tool, referenceEdge })} />
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {tool.kind === 'distance' ? 'Distance' : 'Offset'}
            <input aria-label="Offset" type="text" size={6} value={tool.offset} onChange={(e) => onChange({ ...tool, offset: e.target.value })} />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Write the offset as a named variable (leave empty to write the number inline)">
            as variable
            <input aria-label="Offset variable name" type="text" size={7} placeholder="(inline)" value={tool.offsetName} onChange={(e) => onChange({ ...tool, offsetName: e.target.value })} />
          </label>
          <label title="Name the reference's position and the sizes the expression reads as variables, so the moved part follows when they change" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={tool.follow} onChange={(e) => onChange({ ...tool, follow: e.target.checked })} />
            Follow changes
          </label>
        </>
      ) : (
        <>
          <SlotButton label="Part" color={SELECTED_MESH_COLOR} part={props.labelOf(tool.part)} active={tool.picking === 'part'} onPick={() => onChange({ ...tool, picking: 'part' })} />
          <Choice
            label="Pattern kind"
            value={tool.mode}
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'circular', label: 'Circular' },
            ]}
            onChange={(mode) => onChange({ ...tool, mode })}
          />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {tool.mode === 'linear' ? 'Along' : 'Around'}{' '}
            <Choice label="Axis" value={tool.axis} options={AXES.map((a, i) => ({ value: i as 0 | 1 | 2, label: a }))} onChange={(axis) => onChange({ ...tool, axis })} />
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Count
            <input aria-label="Count" type="text" size={4} value={tool.count} onChange={(e) => onChange({ ...tool, count: e.target.value })} />
          </label>
          {tool.mode === 'linear' ? (
            <>
              <Choice
                label="Spacing mode"
                value={tool.spacingMode}
                options={[
                  { value: 'pitch', label: 'Pitch' },
                  ...(props.gapAvailable ? [{ value: 'gap' as const, label: 'Gap' }] : []),
                ]}
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
            </>
          ) : (
            <>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <input type="checkbox" checked={tool.fullCircle} onChange={(e) => onChange({ ...tool, fullCircle: e.target.checked })} />
                Full circle
              </label>
              {!tool.fullCircle && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Step°
                  <input aria-label="Step angle" type="text" size={5} value={tool.step} onChange={(e) => onChange({ ...tool, step: e.target.value })} />
                </label>
              )}
            </>
          )}
        </>
      )}
      <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
        <button onClick={props.onApply} disabled={!props.preview?.ok} style={{ fontWeight: 'bold' }}>
          Apply
        </button>
        <button onClick={props.onCancel}>Cancel</button>
      </span>
      {props.preview && (
        <div data-testid="tool-preview" style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, opacity: 0.9 }}>
          {props.preview.ok ? (
            <>
              {props.preview.lines.map((l) => (
                <div key={l}>{l}</div>
              ))}
              {props.preview.notes.map((n) => (
                <div key={n} role="note" style={{ color: '#e8a05a', fontFamily: 'sans-serif' }}>
                  {n}
                </div>
              ))}
            </>
          ) : (
            <span style={{ fontFamily: 'sans-serif', opacity: 0.8 }}>{props.preview.reason}</span>
          )}
        </div>
      )}
    </div>
  );
}
