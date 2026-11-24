import type { Node, Tree } from 'web-tree-sitter';
import type { ToolDefinition, ToolParam, WidgetKind } from './tools';

// M8 module introspection: reads `module` definitions out of the open
// document and the library files it `use`s (see src/main/moduleSources.ts for
// which files those are), and turns each into a ToolDefinition for the
// toolbar's Custom section. Pure functions over tree-sitter trees, so the
// whole thing is unit-tested against the real grammar.

export interface ModuleParamDef {
  name: string;
  // Verbatim source text of the default value, or null when the parameter
  // has none (it is then required).
  defaultText: string | null;
  defaultShape: ValueShape | null;
}

export interface ModuleDef {
  name: string;
  params: ModuleParamDef[];
  // Absolute path of the defining file, or null for the open document.
  file: string | null;
  // 1-based line of the `module` keyword.
  line: number;
  // A comment directly above the definition, if any, as plain text.
  description: string | null;
  // Parameter names the body uses as an angle (inside rotate()/
  // rotate_extrude() arguments, or sin/cos/tan/... calls).
  angleParams: Set<string>;
}

// What a value looks like as written, for widget inference.
export type ValueShape = 'bool' | 'number' | 'vec3' | 'string' | 'other';

function isNumberLiteral(node: Node): boolean {
  if (node.type === 'number') return true;
  if (node.type === 'unary_expression' && node.namedChildCount === 2) {
    const operand = node.childForFieldName('operand');
    const op = node.childForFieldName('operator');
    return !!operand && operand.type === 'number' && !!op && /minus|plus/.test(op.type);
  }
  return false;
}

export function valueShape(node: Node): ValueShape {
  if (node.type === 'boolean') return 'bool';
  if (isNumberLiteral(node)) return 'number';
  if (node.type === 'string') return 'string';
  if (node.type === 'vector_expression' && node.namedChildCount === 3 && node.namedChildren.every((c) => !!c && isNumberLiteral(c))) {
    return 'vec3';
  }
  return 'other';
}

// The same classification, from text alone (the parameter panel only has
// the argument's text once a user edits it). Mirrors valueShape.
export function textShape(text: string): ValueShape {
  const t = text.trim();
  if (t === 'true' || t === 'false') return 'bool';
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return 'number';
  if (/^"([^"\\]|\\.)*"$/.test(t)) return 'string';
  const num = String.raw`\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*`;
  if (new RegExp(`^\\[${num},${num},${num}\\]$`).test(t)) return 'vec3';
  return 'other';
}

const ANGLE_MODULES = new Set(['rotate', 'rotate_extrude']);
const ANGLE_FUNCTIONS = new Set(['sin', 'cos', 'tan']);
const ANGLE_NAME = /(^|_)(angle|ang|deg|degrees|rot|rotation|theta|phi|tilt|twist|sweep|yaw|pitch|roll)($|_)|angle$/i;

function collectAngleUses(body: Node, paramNames: Set<string>, out: Set<string>): void {
  const visit = (node: Node, inAngleContext: boolean) => {
    let angle = inAngleContext;
    if (node.type === 'module_instantiation' && ANGLE_MODULES.has(node.childForFieldName('name')?.text ?? '')) {
      // Only the call's own arguments are an angle context, not its child
      // statement.
      const args = node.childForFieldName('arguments');
      if (args) visit(args, true);
      for (const child of node.namedChildren) if (child && child !== args && child.type !== 'identifier') visit(child, inAngleContext);
      return;
    }
    if (node.type === 'call_expression' && ANGLE_FUNCTIONS.has(node.childForFieldName('function')?.text ?? '')) angle = true;
    if (angle && node.type === 'identifier' && paramNames.has(node.text)) out.add(node.text);
    for (const child of node.namedChildren) if (child) visit(child, angle);
  };
  visit(body, false);
}

function precedingComment(node: Node): string | null {
  const prev = node.previousSibling;
  if (!prev || prev.type !== 'comment') return null;
  // Only a comment that ends on the line right above.
  if (node.startPosition.row - prev.endPosition.row > 1) return null;
  const text = prev.text
    .replace(/^\/\*+|\*+\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/+|\*)\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  return text || null;
}

// Top-level module definitions in one file, in source order. Definitions a
// parse error swallowed (top-level ERROR nodes) are still looked through,
// since library files often have a few spots the grammar rejects (see the
// corpus baseline).
export function extractModuleDefs(tree: Tree, file: string | null): ModuleDef[] {
  const defs: ModuleDef[] = [];
  const consider = (outer: Node) => {
    const node = outer.type === 'statement' ? outer.child(0) : outer;
    if (!node) return;
    if (node.type === 'ERROR') {
      for (const child of node.namedChildren) if (child) consider(child);
      return;
    }
    if (node.type !== 'module_definition') return;
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const params: ModuleParamDef[] = [];
    const decls = node.childForFieldName('parameters')?.namedChild(0);
    for (const decl of decls?.namedChildren ?? []) {
      if (!decl || decl.type !== 'parameter_declaration') continue;
      const paramName = decl.namedChild(0)?.text;
      if (!paramName) continue;
      const def = decl.namedChild(1);
      params.push({ name: paramName, defaultText: def ? def.text : null, defaultShape: def ? valueShape(def) : null });
    }
    const angleParams = new Set<string>();
    const body = node.childForFieldName('body');
    if (body) collectAngleUses(body, new Set(params.map((p) => p.name)), angleParams);
    defs.push({
      name,
      params,
      file,
      line: node.startPosition.row + 1,
      description: precedingComment(outer),
      angleParams,
    });
  };
  for (const child of tree.rootNode.children) if (child) consider(child);
  return defs;
}

// Index of the `)` closing the `(` at `open`, skipping strings and comments,
// or -1.
function matchingParen(text: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const endComment = text.indexOf('*/', i + 2);
      if (endComment < 0) return -1;
      i = endComment + 1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

// Real libraries hit grammar gaps (the corpus baseline: most BOSL2 files have
// at least one), and tree-sitter's error recovery can swallow hundreds of
// lines into one ERROR node, hiding every module inside it: BOSL2's
// transforms.scad shows 1 of its 28 modules that way. So when a file has
// errors, every `module name(` that starts a line but wasn't found is
// re-parsed on its own: from its keyword up to the next line starting a
// top-level module/function (or the end of the file). A gap elsewhere then
// can't hide it, and a gap inside it only costs that one module.
export function extractModuleDefsRecovering(
  tree: Tree,
  source: string,
  file: string | null,
  reparse: (text: string) => Tree | null,
): ModuleDef[] {
  const defs = extractModuleDefs(tree, file);
  if (!tree.rootNode.hasError) return defs;
  const found = new Set(defs.map((d) => d.name));
  const starts = [...source.matchAll(/^(module|function)\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  starts.forEach((m, k) => {
    if (m[1] !== 'module' || found.has(m[2])) return;
    const start = m.index!;
    const end = k + 1 < starts.length ? starts[k + 1].index! : source.length;
    const slice = source.slice(start, end);
    const rowOffset = source.slice(0, start).split('\n').length - 1;
    // A gap inside the module's own body (BOSL2's cyl() chains echo()s
    // into an expression) can still swallow it: then read the signature
    // alone, `module name(params) {}`, which is all a toolbar tool needs.
    const attempts = [slice];
    const close = matchingParen(slice, slice.indexOf('('));
    if (close > 0) attempts.push(`${slice.slice(0, close + 1)} {}`);
    for (const text of attempts) {
      if (found.has(m[2])) break;
      const sub = reparse(text);
      if (!sub) continue;
      for (const def of extractModuleDefs(sub, file)) {
        if (def.name !== m[2] || found.has(def.name)) continue;
        // The comment above isn't in the slice; read it from the full text.
        const before = source.slice(0, start).replace(/\s+$/, '');
        const lastLine = before.slice(before.lastIndexOf('\n') + 1).trim();
        const comment = lastLine.startsWith('//') ? lastLine.replace(/^\/\/+\s?/, '') || null : null;
        defs.push({ ...def, line: def.line + rowOffset, description: def.description ?? comment });
        found.add(def.name);
      }
      sub.delete();
    }
  });
  return defs.sort((a, b) => a.line - b.line);
}

// How existing calls pass each parameter: module name -> parameter name ->
// the values seen, as written. The "corroborating evidence" PLAN.md asks
// for when a parameter has no default to infer a widget from.
export type CallSiteShapes = Map<string, Map<string, { shape: ValueShape; text: string }[]>>;

// Every module call in a file, with its arguments' shapes, independent of
// any definitions (so it can be computed once per library file and cached).
export interface RawCall {
  name: string;
  args: { name: string | null; shape: ValueShape; text: string }[];
}

export function collectRawCalls(tree: Tree): RawCall[] {
  const calls: RawCall[] = [];
  const visit = (node: Node) => {
    if (node.type === 'module_instantiation') {
      const name = node.childForFieldName('name')?.text;
      const argsNode = node.childForFieldName('arguments')?.namedChild(0);
      if (name && argsNode) {
        const args: RawCall['args'] = [];
        for (const arg of argsNode.namedChildren) {
          const value = arg?.childForFieldName('value') ?? arg?.child(0);
          if (!arg || !value) continue;
          args.push({ name: arg.childForFieldName('name')?.text ?? null, shape: valueShape(value), text: value.text });
        }
        calls.push({ name, args });
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tree.rootNode);
  return calls;
}

export function callSitesFrom(calls: RawCall[], defs: ModuleDef[]): CallSiteShapes {
  const byName = new Map<string, ModuleDef>();
  for (const d of defs) if (!byName.has(d.name)) byName.set(d.name, d);
  const out: CallSiteShapes = new Map();
  for (const call of calls) {
    const def = byName.get(call.name);
    if (!def) continue;
    let position = 0;
    for (const arg of call.args) {
      const paramName = arg.name ?? def.params[position++]?.name;
      if (!paramName) continue;
      let perModule = out.get(def.name);
      if (!perModule) out.set(def.name, (perModule = new Map()));
      let seen = perModule.get(paramName);
      if (!seen) perModule.set(paramName, (seen = []));
      seen.push({ shape: arg.shape, text: arg.text });
    }
  }
  return out;
}

export function collectCallSites(trees: Tree[], defs: ModuleDef[]): CallSiteShapes {
  return callSitesFrom(trees.flatMap(collectRawCalls), defs);
}

function widgetForShape(shape: ValueShape, angle: boolean): WidgetKind {
  switch (shape) {
    case 'bool':
      return 'checkbox';
    case 'number':
      return angle ? 'angle' : 'number';
    case 'vec3':
      return 'xyz';
    case 'string':
      return 'text';
    default:
      return 'generic';
  }
}

// PLAN.md's inference rule: from the default when there is one; with no
// default the parameter is required, and the most common literal shape at
// existing call sites (if any) picks the widget and an example value.
export function inferParam(def: ModuleDef, param: ModuleParamDef, callSites: CallSiteShapes): ToolParam {
  const angle = def.angleParams.has(param.name) || ANGLE_NAME.test(param.name);
  if (param.defaultText !== null) {
    return {
      name: param.name,
      defaultText: param.defaultText,
      widget: widgetForShape(param.defaultShape ?? 'other', angle),
      required: false,
      exampleText: null,
    };
  }
  const seen = (callSites.get(def.name)?.get(param.name) ?? []).filter((s) => s.shape !== 'other');
  const counts = new Map<ValueShape, number>();
  for (const s of seen) counts.set(s.shape, (counts.get(s.shape) ?? 0) + 1);
  let best: ValueShape | null = null;
  for (const [shape, n] of counts) if (best === null || n > counts.get(best)!) best = shape;
  return {
    name: param.name,
    defaultText: null,
    widget: best ? widgetForShape(best, angle) : 'generic',
    required: true,
    exampleText: best ? seen.find((s) => s.shape === best)!.text : null,
  };
}

// Line width past which an inserted call puts one argument per line.
const ONE_LINE_LIMIT = 80;

// The statement a Custom tool inserts: every parameter as a named argument,
// prefilled with its default (or, for a required one, an example from an
// existing call, else `undef` for the user to fill in from the panel).
// Parameters whose default is `undef` are left out: passing undef is the
// same as not passing it, and libraries like BOSL2 have a dozen of them per
// module. The panel still lists them.
export function formatModuleCall(name: string, params: ToolParam[]): string {
  const args = params
    .filter((p) => p.defaultText?.trim() !== 'undef')
    .map((p) => `${p.name} = ${p.defaultText ?? p.exampleText ?? 'undef'}`);
  const oneLine = `${name}(${args.join(', ')});`;
  if (oneLine.length <= ONE_LINE_LIMIT || args.length <= 1) return oneLine;
  return `${name}(\n${args.map((a) => `    ${a}`).join(',\n')}\n);`;
}

export interface ModuleSource {
  // Absolute path, or null for the open document.
  path: string | null;
  tree: Tree;
  // The file's text, for extractModuleDefsRecovering; without it (or
  // without a reparse function) only the tree is read.
  contents?: string;
  // See ModuleSourceFile.useDirective; always null for the document.
  useDirective: string | null;
}

// Modules a toolbar should not offer: OpenSCAD's own leading-underscore
// convention for library-private helpers (BOSL2 and MCAD both use it).
function isPrivate(name: string): boolean {
  return name.startsWith('_');
}

// What a source contributes, computed once per file: the app caches this
// for library files (re-reading BOSL2 on every render cost ~0.6 s).
export interface AnalyzedSource {
  path: string | null;
  useDirective: string | null;
  defs: ModuleDef[];
  calls: RawCall[];
}

export function analyzeSource(source: ModuleSource, reparse?: (text: string) => Tree | null): AnalyzedSource {
  const defs =
    source.contents !== undefined && reparse
      ? extractModuleDefsRecovering(source.tree, source.contents, source.path, reparse)
      : extractModuleDefs(source.tree, source.path);
  return { path: source.path, useDirective: source.useDirective, defs, calls: collectRawCalls(source.tree) };
}

// All Custom toolbar tools for a document. Sources come in scope order
// (document first, then files already in scope, then ones needing a `use`),
// and the first definition of a name wins, matching how OpenSCAD resolves a
// name that several files define (a local module shadows a used one).
export function buildCustomTools(sources: ModuleSource[], reparse?: (text: string) => Tree | null): ToolDefinition[] {
  return toolsFromAnalyzed(sources.map((s) => analyzeSource(s, reparse)));
}

export function toolsFromAnalyzed(sources: AnalyzedSource[]): ToolDefinition[] {
  const all = sources.flatMap((s) => s.defs.map((def) => ({ def, source: s })));
  const callSites = callSitesFrom(
    sources.flatMap((s) => s.calls),
    all.map((a) => a.def),
  );
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const { def, source } of all) {
    if (seen.has(def.name) || isPrivate(def.name)) continue;
    seen.add(def.name);
    const params = def.params.map((p) => inferParam(def, p, callSites));
    tools.push({
      id: `custom:${def.name}`,
      section: 'custom',
      label: def.name,
      callName: def.name,
      params,
      statement: formatModuleCall(def.name, params),
      useDirective: source.useDirective,
      origin: { file: def.file, line: def.line },
      description: def.description,
    });
  }
  return tools;
}
