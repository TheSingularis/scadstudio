import type { CallArgs } from './targetedPatch';
import { textShape } from './moduleIntrospection';
import type { ToolParam, WidgetKind } from './tools';

// M8: what the parameter panel shows for the selected call. Positional
// arguments get the real parameter name from the module's definition (or a
// built-in's signature) instead of #1/#2/#3, and for a custom module the
// parameters the call leaves out are listed too, showing their defaults.

export interface PanelField {
  // Index into CallArgs.args, or null for a parameter the call doesn't pass.
  argIndex: number | null;
  // Parameter name, or `#n` when a positional argument can't be named.
  label: string;
  param: ToolParam | null;
  // The argument's source text, or null when not passed.
  valueText: string | null;
  widget: WidgetKind;
}

function shapeWidget(text: string): WidgetKind {
  switch (textShape(text)) {
    case 'bool':
      return 'checkbox';
    case 'number':
      return 'number';
    case 'vec3':
      return 'xyz';
    case 'string':
      return 'text';
    default:
      return 'generic';
  }
}

// The widget a field actually gets. A definition's widget is used only
// while the current text fits it (an expression like `w * 2` in a number
// parameter falls back to a plain field rather than being lost); with no
// definition widget, the text's own literal shape decides.
export function effectiveWidget(param: ToolParam | null, valueText: string | null): WidgetKind {
  const declared = param?.widget ?? 'generic';
  if (valueText === null) return declared;
  if (declared === 'generic') return shapeWidget(valueText);
  const shape = textShape(valueText);
  const fits =
    (declared === 'checkbox' && shape === 'bool') ||
    ((declared === 'number' || declared === 'angle') && shape === 'number') ||
    (declared === 'xyz' && shape === 'vec3') ||
    ((declared === 'text' || declared === 'font' || declared === 'choice') && shape === 'string');
  return fits ? declared : 'generic';
}

export function panelFields(call: CallArgs, params: ToolParam[], listUnset: boolean): PanelField[] {
  const fields: PanelField[] = [];
  const used = new Set<string>();
  let position = 0;
  const positional = params.filter((p) => !p.namedOnly);
  call.args.forEach((arg, i) => {
    const param = arg.name !== null ? (params.find((p) => p.name === arg.name) ?? null) : (positional[position] ?? null);
    const label = arg.name ?? param?.name ?? `#${i + 1}`;
    if (arg.name === null) position++;
    if (param) used.add(param.name);
    fields.push({ argIndex: i, label, param, valueText: arg.valueText, widget: effectiveWidget(param, arg.valueText) });
  });
  if (listUnset) {
    for (const p of params) {
      if (used.has(p.name)) continue;
      fields.push({ argIndex: null, label: p.name, param: p, valueText: null, widget: effectiveWidget(p, null) });
    }
  }
  return fields;
}

// OpenSCAD string literal <-> its text. OpenSCAD's escapes: \" \\ \n \t \r.
export function unquoteScadString(literal: string): string {
  const body = literal.trim().slice(1, -1);
  return body.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

export function quoteScadString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')}"`;
}

export function parseVec3(text: string): [string, string, string] | null {
  const m = /^\s*\[\s*([^,\]]+?)\s*,\s*([^,\]]+?)\s*,\s*([^,\]]+?)\s*\]\s*$/.exec(text);
  return m ? [m[1], m[2], m[3]] : null;
}
