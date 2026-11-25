import type { Node } from 'web-tree-sitter';
import { textShape, type ValueShape } from './moduleIntrospection';
import { documentScope, formatValue, tryEvaluate } from './scadExpr';

// M11: the document's variables, the values its top-level assignments name,
// for the variables panel, "Make variable" and the relate/pattern tools.
//
// OpenSCAD Customizer conventions are read and kept (PLAN.md M11 decision
// 2; https://files.openscad.org/documentation/manual/Customizer.html):
// - `// description` on the line above an assignment,
// - `x = 5; // [0:100]` (slider), `// [0:5:100]` (slider with step),
//   `// [50]` (slider with max), `// [1, 2, 3]` or `// [S:Small, L:Large]`
//   (dropdown), `"text"; // 8` (max length),
// - `/* [Tab name] */` groups what follows; `[Hidden]` is never shown in the
//   Customizer and `[Global]` shows on every tab,
// - only literal values before the first module with a `{ }` body appear in
//   the Customizer.
// New variables go in one block at the top of the file, after use/include,
// so they appear there too.

export type Annotation =
  | { kind: 'slider'; min: number; step: number | null; max: number }
  | { kind: 'choice'; options: { value: string; label: string }[] }
  | { kind: 'maxLength'; length: number };

export interface VariableInfo {
  name: string;
  valueText: string;
  valueStart: number;
  valueEnd: number;
  // The whole assignment, `name = value;`.
  statementStart: number;
  statementEnd: number;
  // Zero-based line of the assignment.
  line: number;
  shape: ValueShape;
  // What the value comes to, when the evaluator can work it out.
  display: string | null;
  // Literal number/bool/string/vector: what OpenSCAD's Customizer edits.
  literal: boolean;
  description: string | null;
  annotation: Annotation | null;
  group: string;
  hidden: boolean;
  // Whether OpenSCAD's own Customizer would list it.
  inCustomizer: boolean;
  // Places that read it (identifier nodes' ranges).
  uses: { start: number; end: number; line: number }[];
  // Assigned more than once at the top level (the last assignment wins).
  reassigned: boolean;
}

const KEYWORDS = new Set([
  'module', 'function', 'if', 'else', 'for', 'let', 'each', 'true', 'false', 'undef', 'use', 'include', 'assert', 'echo', 'intersection_for',
]);

export function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name);
}

function concrete(stmt: Node | null): Node | null {
  if (!stmt) return null;
  return stmt.type === 'statement' ? stmt.child(0) : stmt;
}

function isLiteral(node: Node): boolean {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return true;
    case 'unary_expression':
      return node.childForFieldName('operand')?.type === 'number';
    case 'vector_expression':
      return node.namedChildren.every((c) => c !== null && isLiteral(c));
    default:
      return false;
  }
}

export function parseAnnotation(comment: string): Annotation | null {
  const text = comment.replace(/^\/\/\s*/, '').trim();
  const bracket = /^\[(.*)\]$/.exec(text);
  if (!bracket) {
    const n = /^(\d+)$/.exec(text);
    return n ? { kind: 'maxLength', length: Number(n[1]) } : null;
  }
  const inner = bracket[1].trim();
  if (inner.startsWith(':')) return null; // [::non-negative integer] etc.
  const numberList = inner.split(':').map((p) => p.trim());
  if (!inner.includes(',') && numberList.every((p) => p !== '' && Number.isFinite(Number(p)))) {
    if (numberList.length === 1) return { kind: 'slider', min: 0, step: null, max: Number(numberList[0]) };
    if (numberList.length === 2) return { kind: 'slider', min: Number(numberList[0]), step: null, max: Number(numberList[1]) };
    if (numberList.length === 3) return { kind: 'slider', min: Number(numberList[0]), step: Number(numberList[1]), max: Number(numberList[2]) };
  }
  const options = inner
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
    .map((o) => {
      const i = o.indexOf(':');
      return i < 0 ? { value: o, label: o } : { value: o.slice(0, i).trim(), label: o.slice(i + 1).trim() };
    });
  return options.length > 0 ? { kind: 'choice', options } : null;
}

function groupName(comment: string): string | null {
  const m = /^\/\*\s*\[([^\]]*)\]/.exec(comment.trim());
  return m ? m[1].trim() : null;
}

// Node types whose `name`-ish identifier children are not reads of a
// variable (definitions, argument names, call names, properties).
function isReference(id: Node): boolean {
  const parent = id.parent;
  if (!parent) return false;
  const field = (name: string) => parent.childForFieldName(name)?.equals(id) ?? false;
  switch (parent.type) {
    case 'assignment_statement':
    case 'let_assignment':
    case 'argument':
      return !field('name');
    case 'module_instantiation':
    case 'module_definition':
    case 'function_definition':
      return !field('name');
    case 'call_expression':
      return !field('function');
    case 'member_expression':
      return !field('property');
    case 'for_statement':
    case 'for_assignment':
    case 'list_comprehension_for':
    case 'list_comprehension_assignment':
      return !field('iterator');
    case 'parameter_declaration':
      // `name` or `name = default`: the first child is the parameter.
      return !(parent.namedChild(0)?.equals(id) ?? false);
    default:
      return true;
  }
}

// Whether an enclosing scope binds `name`, so `id` doesn't read the
// top-level variable.
function shadowed(id: Node, name: string): boolean {
  for (let n: Node | null = id.parent; n; n = n.parent) {
    switch (n.type) {
      case 'module_definition':
      case 'function_definition': {
        const decls = n.childForFieldName('parameters')?.namedChildren.find((c) => c?.type === 'parameter_declarations');
        if (decls?.namedChildren.some((d) => d?.namedChild(0)?.text === name)) return true;
        break;
      }
      case 'for_statement':
      case 'list_comprehension_for':
        if (n.childForFieldName('iterator')?.text === name) return true;
        if (n.namedChildren.some((a) => (a?.type === 'for_assignment' || a?.type === 'list_comprehension_assignment') && a.childForFieldName('iterator')?.text === name)) return true;
        break;
      case 'let_expression':
      case 'list_comprehension':
        if (n.namedChildren.some((a) => a?.type === 'let_assignment' && a.childForFieldName('name')?.text === name)) return true;
        break;
      case 'block':
        if (n.namedChildren.some((s) => concrete(s)?.type === 'assignment_statement' && concrete(s)!.childForFieldName('name')?.text === name)) return true;
        break;
    }
  }
  return false;
}

/** Every place in the document that reads the top-level variable `name`. */
export function variableReferences(root: Node, name: string): Node[] {
  return root.descendantsOfType('identifier').filter((id): id is Node => id !== null && id.text === name && isReference(id) && !shadowed(id, name));
}

export function readVariables(root: Node): VariableInfo[] {
  const scope = documentScope(root);
  const out: VariableInfo[] = [];
  const children = root.children.filter((c): c is Node => c !== null);
  let group = 'Parameters';
  let pastCustomizerLimit = false;
  const seen = new Map<string, VariableInfo>();
  children.forEach((child, i) => {
    if (child.type === 'comment') {
      const g = groupName(child.text);
      if (g !== null) group = g;
      return;
    }
    const stmt = concrete(child);
    if (stmt?.type === 'module_definition' && stmt.childForFieldName('body')?.type === 'block') pastCustomizerLimit = true;
    if (stmt?.type !== 'assignment_statement') return;
    const nameNode = stmt.childForFieldName('name');
    const valueNode = stmt.childForFieldName('value');
    if (!nameNode || !valueNode || nameNode.type !== 'identifier') return;
    const prev = children[i - 1];
    const next = children[i + 1];
    const description =
      prev?.type === 'comment' && prev.text.startsWith('//') && prev.endPosition.row === child.startPosition.row - 1 && groupName(prev.text) === null
        ? prev.text.replace(/^\/\/\s?/, '').trim()
        : null;
    const trailing = next?.type === 'comment' && next.startPosition.row === child.endPosition.row && next.text.startsWith('//') ? next.text : null;
    const evaluated = tryEvaluate(valueNode, scope);
    const literal = isLiteral(valueNode);
    const info: VariableInfo = {
      name: nameNode.text,
      valueText: valueNode.text,
      valueStart: valueNode.startIndex,
      valueEnd: valueNode.endIndex,
      statementStart: child.startIndex,
      statementEnd: child.endIndex,
      line: child.startPosition.row,
      shape: textShape(valueNode.text),
      display: evaluated.ok ? formatValue(evaluated.value) : null,
      literal,
      description,
      annotation: trailing ? parseAnnotation(trailing) : null,
      group,
      hidden: group.toLowerCase() === 'hidden',
      inCustomizer: literal && !pastCustomizerLimit && group.toLowerCase() !== 'hidden',
      uses: [],
      reassigned: false,
    };
    const earlier = seen.get(info.name);
    if (earlier) {
      earlier.reassigned = true;
      info.reassigned = true;
    }
    seen.set(info.name, info);
    out.push(info);
  });
  for (const v of out) {
    v.uses = variableReferences(root, v.name).map((id) => ({ start: id.startIndex, end: id.endIndex, line: id.startPosition.row }));
  }
  return out;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits (any order) to `source`. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error('overlapping edits');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

/** A name not used by anything in the document: `base`, `base_2`, ... */
export function uniqueName(root: Node, base: string, taken: Iterable<string> = []): string {
  const used = new Set<string>(taken);
  for (const id of root.descendantsOfType('identifier')) if (id) used.add(id.text);
  let clean = base.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(clean)) clean = `v_${clean}`;
  if (KEYWORDS.has(clean)) clean = `${clean}_value`;
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) if (!used.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

/**
 * Where a new variable goes: after the last assignment of the file's
 * leading run of comments, use/include and assignments (the variables
 * block), or after the leading comments and use/include when there are
 * none yet. Returns the offset and whether a blank line should follow.
 */
function variableInsertPoint(source: string, root: Node): { at: number; prefix: string; suffix: string } {
  const children = root.children.filter((c): c is Node => c !== null);
  let lastAssignment: Node | null = null;
  let lastHeader: Node | null = null;
  for (const child of children) {
    if (child.type === 'comment') continue;
    const stmt = concrete(child);
    if (stmt?.type === 'use_statement' || stmt?.type === 'include_statement') {
      if (lastAssignment) break;
      lastHeader = child;
      continue;
    }
    if (stmt?.type === 'assignment_statement') {
      lastAssignment = child;
      continue;
    }
    break;
  }
  if (lastAssignment) {
    // After a trailing same-line comment (a Customizer annotation).
    let end = lastAssignment.endIndex;
    const next = lastAssignment.nextSibling;
    if (next?.type === 'comment' && next.startPosition.row === lastAssignment.endPosition.row) end = next.endIndex;
    return { at: end, prefix: '\n', suffix: '' };
  }
  if (lastHeader) {
    let end = lastHeader.endIndex;
    const next = lastHeader.nextSibling;
    if (next?.type === 'comment' && next.startPosition.row === lastHeader.endPosition.row) end = next.endIndex;
    return { at: end, prefix: '\n\n', suffix: '' };
  }
  // No header: after the file's leading comment lines (a title block).
  let at = 0;
  for (const child of children) {
    if (child.type !== 'comment') break;
    if (child.startIndex !== at && source.slice(at, child.startIndex).trim() !== '') break;
    at = child.endIndex;
  }
  if (at === 0) return { at: 0, prefix: '', suffix: '\n\n' };
  return { at, prefix: '\n\n', suffix: '' };
}

/** The edit that adds `name = valueText;` to the variables block. */
export function insertVariableEdit(source: string, root: Node, name: string, valueText: string): TextEdit {
  const { at, prefix, suffix } = variableInsertPoint(source, root);
  // Keep the blank line after the block when the next statement follows
  // directly (prefix '\n' means "joins an existing block").
  const rest = source.slice(at);
  const needsGap = prefix !== '\n' && suffix === '' && !/^\s*\n\s*\n/.test(rest) && rest.trim() !== '';
  return { start: at, end: at, text: `${prefix}${name} = ${valueText};${suffix}${needsGap ? '\n' : ''}` };
}

export function insertVariable(source: string, root: Node, name: string, valueText: string): string {
  return applyEdits(source, [insertVariableEdit(source, root, name, valueText)]);
}

function needsParens(text: string): boolean {
  const t = text.trim();
  if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(t) || /^[A-Za-z_]\w*$/.test(t)) return false;
  if (/^".*"$/.test(t) || /^\[.*\]$/s.test(t) || /^\(.*\)$/s.test(t)) return false;
  return true;
}

/**
 * Replaces [start, end) (an argument value, a vector component) with a new
 * variable holding that text: Make variable.
 */
export function makeVariable(source: string, root: Node, range: { start: number; end: number }, name: string): string {
  const valueText = source.slice(range.start, range.end).trim();
  return applyEdits(source, [insertVariableEdit(source, root, name, valueText), { start: range.start, end: range.end, text: name }]);
}

export function setVariableValue(source: string, variable: VariableInfo, valueText: string): string {
  return applyEdits(source, [{ start: variable.valueStart, end: variable.valueEnd, text: valueText }]);
}

export function renameVariable(source: string, root: Node, oldName: string, newName: string): string {
  if (!isValidName(newName) || oldName === newName) return source;
  const edits: TextEdit[] = [];
  for (const child of root.children) {
    const stmt = concrete(child);
    if (stmt?.type !== 'assignment_statement') continue;
    const n = stmt.childForFieldName('name');
    if (n?.text === oldName) edits.push({ start: n.startIndex, end: n.endIndex, text: newName });
  }
  if (edits.length === 0) return source;
  for (const id of variableReferences(root, oldName)) edits.push({ start: id.startIndex, end: id.endIndex, text: newName });
  return applyEdits(source, edits);
}

/** Whether `name` is free to become a top-level variable here. */
export function nameAvailable(root: Node, name: string): boolean {
  if (!isValidName(name)) return false;
  return !root.descendantsOfType('identifier').some((id) => id?.text === name);
}

/**
 * Deletes the variable's assignment (its whole line, with a description
 * comment above and an annotation after it). With `inline`, every use gets
 * the value's text first, in parentheses when it needs them; without, a
 * used variable is left alone (the caller asks first).
 */
export function deleteVariable(source: string, root: Node, variable: VariableInfo, inline: boolean): string {
  const refs = variableReferences(root, variable.name);
  if (refs.length > 0 && !inline) return source;
  const value = needsParens(variable.valueText) ? `(${variable.valueText})` : variable.valueText;
  const edits: TextEdit[] = refs
    .filter((id) => id.startIndex < variable.statementStart || id.endIndex > variable.statementEnd)
    .map((id) => ({ start: id.startIndex, end: id.endIndex, text: value }));
  const stmt = root.children.find((c) => c?.startIndex === variable.statementStart) ?? null;
  let start = variable.statementStart;
  let end = variable.statementEnd;
  const next = stmt?.nextSibling;
  if (stmt && next?.type === 'comment' && next.startPosition.row === stmt.endPosition.row) end = next.endIndex;
  const prev = stmt?.previousSibling;
  if (stmt && variable.description !== null && prev?.type === 'comment') start = prev.startIndex;
  // Take the whole line(s) when nothing else is on them.
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nl = source.indexOf('\n', end);
  const lineEnd = nl < 0 ? source.length : nl + 1;
  if (source.slice(lineStart, start).trim() === '' && source.slice(end, lineEnd).trim() === '') {
    start = lineStart;
    end = lineEnd;
  }
  edits.push({ start, end, text: '' });
  return applyEdits(source, edits);
}
