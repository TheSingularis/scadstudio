import { useState } from 'react';
import type { VariableInfo } from '../variables';

// M11: the variables sidebar (PLAN.md M11 decisions 1, 2 and 7). Lists the
// file's top-level variables grouped by their Customizer tab, each with a
// widget for its value (a Customizer slider or dropdown when the file
// declares one), where it's used, rename and delete. Expressions show what
// they come to and edit as text.

export interface VariablesPanelProps {
  variables: VariableInfo[];
  readOnly: boolean;
  onSetValue: (variable: VariableInfo, valueText: string) => void;
  onAdd: (name: string, valueText: string) => string | null;
  onRename: (variable: VariableInfo, newName: string) => string | null;
  onDelete: (variable: VariableInfo, inline: boolean) => void;
  onReveal: (start: number, end: number) => void;
  onClose: () => void;
}

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' };

function commitOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter') e.currentTarget.blur();
  if (e.key === 'Escape') {
    e.currentTarget.value = e.currentTarget.defaultValue;
    e.currentTarget.blur();
  }
}

function ValueControl({ v, disabled, onCommit }: { v: VariableInfo; disabled: boolean; onCommit: (text: string) => void }) {
  const label = `Variable ${v.name}`;
  const a = v.annotation;
  if (v.literal && v.shape === 'bool') {
    return <input type="checkbox" aria-label={label} disabled={disabled} defaultChecked={v.valueText === 'true'} onChange={(e) => onCommit(e.target.checked ? 'true' : 'false')} />;
  }
  if (v.literal && a?.kind === 'choice') {
    const isString = v.shape === 'string';
    const current = isString ? v.valueText.slice(1, -1) : v.valueText;
    return (
      <select aria-label={label} disabled={disabled} defaultValue={current} onChange={(e) => onCommit(isString ? JSON.stringify(e.target.value) : e.target.value)}>
        {!a.options.some((o) => o.value === current) && <option value={current}>{current}</option>}
        {a.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const text = (
    <input
      type="text"
      aria-label={label}
      disabled={disabled}
      defaultValue={v.valueText}
      size={Math.min(18, Math.max(5, v.valueText.length + 1))}
      maxLength={a?.kind === 'maxLength' && v.shape === 'string' ? a.length + 2 : undefined}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next !== '' && next !== v.valueText) onCommit(next);
      }}
      onKeyDown={commitOnEnter}
      style={{ fontFamily: 'monospace', fontSize: 12 }}
    />
  );
  if (v.literal && v.shape === 'number' && a?.kind === 'slider') {
    return (
      <>
        <input
          type="range"
          aria-label={`${label} slider`}
          disabled={disabled}
          min={a.min}
          max={a.max}
          step={a.step ?? 'any'}
          defaultValue={Number(v.valueText)}
          style={{ width: 90 }}
          // Commit on release only: every change re-renders every part.
          onPointerUp={(e) => onCommit(e.currentTarget.value)}
          onKeyUp={(e) => onCommit(e.currentTarget.value)}
        />
        {text}
      </>
    );
  }
  return text;
}

function VariableRow({ v, props }: { v: VariableInfo; props: VariablesPanelProps }) {
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const usedIn = [...new Set(v.uses.map((u) => u.line + 1))];
  return (
    <div data-testid={`variable-${v.name}`} style={{ padding: '4px 0', borderBottom: '1px solid #2d2d2d' }}>
      <div style={row}>
        {renaming ? (
          <input
            type="text"
            aria-label={`New name for ${v.name}`}
            autoFocus
            defaultValue={v.name}
            size={Math.max(6, v.name.length + 2)}
            onBlur={(e) => {
              setRenaming(false);
              const next = e.target.value.trim();
              if (next !== v.name && next !== '') setError(props.onRename(v, next));
            }}
            onKeyDown={commitOnEnter}
          />
        ) : (
          <button
            className="variable-name"
            title={`Rename ${v.name} (and every use of it)`}
            disabled={props.readOnly}
            onClick={() => setRenaming(true)}
            style={{ fontFamily: 'monospace', fontWeight: 'bold', background: 'none', border: 'none', color: '#9cdcfe', padding: 0, cursor: 'text' }}
          >
            {v.name}
          </button>
        )}
        <span style={{ opacity: 0.6 }}>=</span>
        <ValueControl key={v.valueText} v={v} disabled={props.readOnly} onCommit={(t) => props.onSetValue(v, t)} />
        {!v.literal && v.display !== null && (
          <span style={{ opacity: 0.7 }} title="What the expression comes to">
            = {v.display}
          </span>
        )}
      </div>
      {v.description && <div style={{ opacity: 0.6, fontSize: 11 }}>{v.description}</div>}
      <div style={{ ...row, fontSize: 11, opacity: 0.8 }}>
        <button
          onClick={() => props.onReveal(v.statementStart, v.statementEnd)}
          title="Show the assignment in the editor"
          style={{ fontSize: 11 }}
        >
          Line {v.line + 1}
        </button>
        {usedIn.length > 0 ? (
          <span>
            used on line{usedIn.length > 1 ? 's' : ''}{' '}
            {usedIn.map((line, i) => {
              const use = v.uses.find((u) => u.line + 1 === line)!;
              return (
                <button key={line} style={{ fontSize: 11, marginLeft: i ? 2 : 0 }} onClick={() => props.onReveal(use.start, use.end)} title="Show this use in the editor">
                  {line}
                </button>
              );
            })}
          </span>
        ) : (
          <span style={{ opacity: 0.6 }}>not used</span>
        )}
        {v.reassigned && <span style={{ color: '#e8a05a' }} title="OpenSCAD uses the last assignment of a name">assigned twice</span>}
        {!props.readOnly && (
          <button style={{ fontSize: 11, marginLeft: 'auto' }} title={`Delete ${v.name}`} onClick={() => (v.uses.length > 0 ? setConfirmDelete(true) : props.onDelete(v, false))}>
            Delete
          </button>
        )}
      </div>
      {confirmDelete && (
        <div role="alert" style={{ ...row, fontSize: 11, background: '#3a2a1a', padding: 4, borderRadius: 3, marginTop: 2 }}>
          {v.name} is used in {v.uses.length} place{v.uses.length > 1 ? 's' : ''} (line{usedIn.length > 1 ? 's' : ''} {usedIn.join(', ')}).
          <button
            onClick={() => {
              setConfirmDelete(false);
              props.onDelete(v, true);
            }}
            title={`Replace each use with ${v.valueText}, then delete it`}
          >
            Inline its value and delete
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: '#e8a05a', fontSize: 11 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function AddVariable({ props }: { props: VariablesPanelProps }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button disabled={props.readOnly} onClick={() => setOpen(true)} title="Add a variable to the top of the file">
        + Add
      </button>
    );
  }
  return (
    <form
      style={{ ...row, marginTop: 4 }}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const err = props.onAdd(String(data.get('name') ?? '').trim(), String(data.get('value') ?? '').trim() || '0');
        setError(err);
        if (!err) setOpen(false);
      }}
    >
      <input name="name" aria-label="New variable name" placeholder="name" size={8} autoFocus />
      =
      <input name="value" aria-label="New variable value" placeholder="0" size={6} />
      <button type="submit">Add</button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && (
        <div role="alert" style={{ color: '#e8a05a', fontSize: 11, width: '100%' }}>
          {error}
        </div>
      )}
    </form>
  );
}

export function VariablesPanel(props: VariablesPanelProps) {
  const groups = new Map<string, VariableInfo[]>();
  for (const v of props.variables) {
    const list = groups.get(v.group) ?? [];
    list.push(v);
    groups.set(v.group, list);
  }
  return (
    <aside
      aria-label="Variables"
      style={{ width: 280, flex: '0 0 auto', overflowY: 'auto', background: '#1b1b1b', color: '#ccc', fontSize: 12, padding: '6px 8px', borderRight: '1px solid #333' }}
    >
      <div style={{ ...row, justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>Variables</strong>
        <span style={row}>
          <AddVariable props={props} />
          <button onClick={props.onClose} title="Hide the variables panel" aria-label="Hide variables">
            ×
          </button>
        </span>
      </div>
      {props.variables.length === 0 && (
        <div style={{ opacity: 0.6 }}>No variables yet. Add one, or use "Make variable" next to a number in the parameter panel.</div>
      )}
      {[...groups.entries()].map(([group, vars]) => (
        <section key={group} aria-label={`${group} variables`}>
          {(groups.size > 1 || group !== 'Parameters') && (
            <div style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: 1, opacity: 0.6, marginTop: 6 }} title={group.toLowerCase() === 'hidden' ? 'Hidden from OpenSCAD’s Customizer' : 'A Customizer tab'}>
              {group}
            </div>
          )}
          {vars.map((v) => (
            <VariableRow key={`${v.name}:${v.statementStart}`} v={v} props={props} />
          ))}
        </section>
      ))}
    </aside>
  );
}
