import { PRIMITIVE_DEFAULTS, appendStatement, type PrimitiveKind } from './primitives';

// M8: one shape for every insertable toolbar tool, built-in or custom. The
// two kinds differ only in where their definition came from (a fixed table
// here, or moduleIntrospection.ts reading a `module`), never in how they are
// inserted or rendered (PLAN.md, "Custom module auto-toolbar" point 5).

// The parameter-panel widget for a parameter. 'generic' is a plain
// expression field. M15: 'font' is the font picker (bundled, project and
// installed fonts) and 'choice' a dropdown of the string values in
// ToolParam.choices (text()'s halign/valign).
export type WidgetKind = 'checkbox' | 'number' | 'angle' | 'xyz' | 'text' | 'font' | 'choice' | 'generic';

export interface ToolParam {
  name: string;
  // Default value as written in the definition, or null when required.
  defaultText: string | null;
  widget: WidgetKind;
  required: boolean;
  // For a required parameter: a value seen at an existing call site.
  exampleText: string | null;
  // For a 'choice' widget: the allowed string values, unquoted.
  choices?: string[];
  // Can only be passed by name (a positional argument never maps to it).
  namedOnly?: boolean;
}

export type ToolSection = 'insert' | 'extrude' | 'custom';

export interface ToolDefinition {
  id: string;
  section: ToolSection;
  label: string;
  // The module the inserted statement calls (its outermost call).
  callName: string;
  // Parameters in positional order, so the panel can name positional
  // arguments. Empty when unknown.
  params: ToolParam[];
  // Statement inserted at the end of the document.
  statement: string;
  // A `use <...>` target the document needs for callName to resolve, or
  // null when it already resolves.
  useDirective: string | null;
  // Where a custom module is defined; null for built-ins.
  origin: { file: string | null; line: number } | null;
  description: string | null;
}

function param(name: string, widget: WidgetKind = 'generic', defaultText: string | null = null, choices?: string[]): ToolParam {
  return { name, defaultText, widget, required: false, exampleText: null, ...(choices ? { choices } : {}) };
}

// Positional parameter order of the built-ins the app inserts or a panel
// commonly shows, so `cube([1,2,3], true)` reads as size/center instead of
// #1/#2. Each order was checked against the bundled openscad-wasm engine
// (2026-11-24), not taken from documentation alone: e.g. this engine's
// linear_extrude reads only `height` positionally (a second positional
// `true` does not center it), and rotate_extrude's first positional is
// `angle`. test/integration/builtinSignatures.test.ts pins these.
export const BUILTIN_SIGNATURES: Record<string, ToolParam[]> = {
  cube: [param('size'), param('center', 'checkbox')],
  sphere: [param('r', 'number')],
  cylinder: [param('h', 'number'), param('r1', 'number'), param('r2', 'number'), param('center', 'checkbox')],
  square: [param('size'), param('center', 'checkbox')],
  circle: [param('r', 'number')],
  polygon: [param('points'), param('paths')],
  offset: [param('r', 'number')],
  linear_extrude: [param('height', 'number')],
  rotate_extrude: [param('angle', 'angle')],
  // M15. Defaults as OpenSCAD documents them (Liberation Sans is its
  // default font); the panel lists the ones a call leaves out
  // (LIST_UNSET_BUILTINS) so font and alignment are one click away. Only
  // text/size/font are positional: OpenSCAD's TextNode.cc parses the rest
  // as named-only, and the engine ignores a 4th positional argument.
  text: [
    param('text', 'text'),
    param('size', 'number', '10'),
    param('font', 'font', '"Liberation Sans"'),
    { ...param('halign', 'choice', '"left"', ['left', 'center', 'right']), namedOnly: true },
    { ...param('valign', 'choice', '"baseline"', ['top', 'center', 'baseline', 'bottom']), namedOnly: true },
    { ...param('spacing', 'number', '1'), namedOnly: true },
  ],
};

// Built-ins whose panel also lists the parameters a call doesn't pass (as
// a custom module's does), with their defaults.
export const LIST_UNSET_BUILTINS = new Set(['text']);

const BUILTIN_TOOLS: { kind: PrimitiveKind; label: string; section: ToolSection }[] = [
  { kind: 'cube', label: 'Cube', section: 'insert' },
  { kind: 'sphere', label: 'Sphere', section: 'insert' },
  { kind: 'cylinder', label: 'Cylinder', section: 'insert' },
  { kind: 'square', label: 'Square', section: 'insert' },
  { kind: 'circle', label: 'Circle', section: 'insert' },
  { kind: 'text', label: 'Text', section: 'insert' },
  { kind: 'linear_extrude', label: 'Linear Extrude', section: 'extrude' },
  { kind: 'rotate_extrude', label: 'Rotate Extrude', section: 'extrude' },
];

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = BUILTIN_TOOLS.map(({ kind, label, section }) => ({
  id: `builtin:${kind}`,
  section,
  label,
  callName: kind,
  params: BUILTIN_SIGNATURES[kind] ?? [],
  statement: PRIMITIVE_DEFAULTS[kind],
  useDirective: null,
  origin: null,
  description: null,
}));

export function builtinTool(kind: PrimitiveKind): ToolDefinition {
  return BUILTIN_TOOL_DEFINITIONS.find((t) => t.id === `builtin:${kind}`)!;
}

// Whether `source` already has `use <target>` (ignoring whitespace inside
// the brackets and `\` vs `/`).
export function hasUseDirective(source: string, target: string): boolean {
  const norm = (p: string) => p.trim().replace(/\\/g, '/');
  const re = /\buse\s*<([^>\n]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) if (norm(m[1]) === norm(target)) return true;
  return false;
}

// Puts `use <target>` after the document's existing leading use/include
// lines (and any comment block above them), or at the very top.
export function addUseDirective(source: string, target: string): string {
  if (hasUseDirective(source, target)) return source;
  const line = `use <${target}>`;
  const lines = source.split('\n');
  let lastDirective = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(use|include)\s*</.test(t)) lastDirective = i;
    else if (t === '' || t.startsWith('//')) continue;
    else break;
  }
  if (lastDirective >= 0) {
    lines.splice(lastDirective + 1, 0, line);
    return lines.join('\n');
  }
  return `${line}\n\n${source}`;
}

// The one insertion path every tool goes through (M5's append, plus the
// `use` a custom module from a not-yet-used file needs).
export function insertTool(source: string, tool: ToolDefinition): string {
  const withUse = tool.useDirective ? addUseDirective(source, tool.useDirective) : source;
  return appendStatement(withUse, tool.statement);
}
