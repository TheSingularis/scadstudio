// M13: render a part without BOSL2 when the part doesn't use it.
//
// `include <BOSL2/std.scad>` costs the engine about 0.3 s on every render
// (it parses ~5 MB of library source), and the app renders each part on
// its own, one at a time. So a 10-part file that includes BOSL2 would take
// 3 s or more to open even when only one part is a cuboid(). This module
// decides, for one isolated render's source, whether anything that render
// actually evaluates names something from BOSL2, and if not removes the
// BOSL2 directives from that render's source. The document itself is
// never changed.
//
// What counts as "uses BOSL2" (conservative: anything unsure keeps it):
// - Reachability starts from what OpenSCAD evaluates: every statement
//   outside a module/function definition (top-level geometry and
//   assignments, which OpenSCAD evaluates whether or not they are read).
//   From there it follows calls into the file's own modules and functions
//   and reads of the file's own variables, so a module defined in the
//   document that calls cuboid() keeps BOSL2 for the parts that call it.
// - A module, function or variable name that the source doesn't define
//   and BOSL2 does is a use. Modules, functions and variables are separate
//   namespaces in OpenSCAD and are kept separate here.
// - BOSL2 redefines several built-in modules (cube, cylinder, translate,
//   ...) as attachable versions. A call to one of those with only the
//   built-in's own arguments renders the same with or without BOSL2
//   (checked against the engine for each of them in
//   test/integration/bosl2.test.ts), so it is not a use; one with any
//   other argument (anchor=, spin=, a positional argument past the
//   built-in's own) is.
// - A name bound locally (a parameter, a for/let variable) is never a use.

import type { Node, Tree } from 'web-tree-sitter';

export interface Bosl2Names {
  modules: Set<string>;
  functions: Set<string>;
  variables: Set<string>;
}

/**
 * The top-level names BOSL2's files define, read textually (BOSL2's source
 * has grammar gaps the tree-sitter grammar can't parse, see M8's notes, and
 * its definitions all start at column 0).
 */
export function bosl2NamesFromSources(sources: Iterable<string>): Bosl2Names {
  const names: Bosl2Names = { modules: new Set(), functions: new Set(), variables: new Set() };
  for (const text of sources) {
    for (const m of text.matchAll(/^module\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.modules.add(m[1]!);
    for (const m of text.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.functions.add(m[1]!);
    for (const m of text.matchAll(/^(\$?[A-Za-z_][\w]*)\s*=(?!=)/gm)) names.variables.add(m[1]!);
  }
  return names;
}

// The built-in modules BOSL2 redefines, with the arguments the built-in
// itself takes: how many positionally, and by which names. Anything else
// is BOSL2's.
const BUILTIN_OVERRIDES: Record<string, { positional: number; named: string[] }> = {
  cube: { positional: 2, named: ['size', 'center'] },
  sphere: { positional: 1, named: ['r', 'd'] },
  cylinder: { positional: 4, named: ['h', 'r', 'r1', 'r2', 'd', 'd1', 'd2', 'center'] },
  polyhedron: { positional: 3, named: ['points', 'faces', 'convexity'] },
  square: { positional: 2, named: ['size', 'center'] },
  circle: { positional: 1, named: ['r', 'd'] },
  polygon: { positional: 3, named: ['points', 'paths', 'convexity'] },
  text: { positional: 3, named: ['text', 'size', 'font', 'halign', 'valign', 'spacing', 'direction', 'language', 'script'] },
  surface: { positional: 2, named: ['file', 'center', 'convexity', 'invert'] },
  linear_extrude: { positional: 1, named: ['height', 'center', 'convexity', 'twist', 'slices', 'scale'] },
  rotate_extrude: { positional: 1, named: ['angle', 'convexity'] },
  projection: { positional: 1, named: ['cut', 'convexity'] },
  translate: { positional: 1, named: ['v'] },
  rotate: { positional: 2, named: ['a', 'v'] },
  scale: { positional: 1, named: ['v'] },
  mirror: { positional: 1, named: ['v'] },
  multmatrix: { positional: 1, named: ['m'] },
};

function builtinArgumentsOnly(call: Node, name: string): boolean {
  const spec = BUILTIN_OVERRIDES[name];
  if (!spec) return false;
  const argsNode = call.childForFieldName('arguments')?.namedChild(0);
  let positional = 0;
  for (const a of argsNode?.type === 'arguments' ? argsNode.namedChildren : []) {
    if (!a) continue;
    const argName = a.childForFieldName('name')?.text;
    if (argName === undefined) positional++;
    else if (!argName.startsWith('$') && !spec.named.includes(argName)) return false;
  }
  return positional <= spec.positional;
}

const DEFINITIONS = new Set(['module_definition', 'function_definition']);

/** Whether a module/function/for/let around `id` binds `name` itself. */
function boundLocally(id: Node, name: string): boolean {
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
      case 'let_statement':
        if (n.descendantsOfType('let_assignment').some((a) => a?.parent?.equals(n) && a.childForFieldName('name')?.text === name)) return true;
        break;
    }
  }
  return false;
}

/** Whether an identifier node is a read of a variable (not a name being defined, called or passed). */
function isVariableRead(id: Node): boolean {
  const parent = id.parent;
  if (!parent) return false;
  const field = (f: string) => parent.childForFieldName(f)?.equals(id) ?? false;
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
      return !(parent.namedChild(0)?.equals(id) ?? false);
    default:
      return true;
  }
}

/** Whether the render whose tree this is evaluates anything from BOSL2. */
export function usesBosl2(tree: Tree, names: Bosl2Names): boolean {
  const root = tree.rootNode;
  const localModules = new Map<string, Node[]>();
  const localFunctions = new Map<string, Node[]>();
  const localVariables = new Map<string, Node[]>();
  const push = (map: Map<string, Node[]>, name: string | undefined, node: Node | null) => {
    if (!name || !node) return;
    const list = map.get(name) ?? [];
    list.push(node);
    map.set(name, list);
  };
  for (const d of root.descendantsOfType(['module_definition', 'function_definition', 'assignment_statement'])) {
    if (!d) continue;
    const name = d.childForFieldName('name')?.text;
    if (d.type === 'module_definition') push(localModules, name, d);
    else if (d.type === 'function_definition') push(localFunctions, name, d);
    else push(localVariables, name, d.childForFieldName('value'));
  }

  const visited = new Set<number>();
  const queue: Node[] = [];
  // Roots: everything OpenSCAD evaluates, i.e. all statements outside a
  // definition (a definition is only evaluated when it's called).
  for (const child of root.namedChildren) {
    if (!child) continue;
    const stmt = child.type === 'statement' ? child.child(0) : child;
    if (!stmt || DEFINITIONS.has(stmt.type) || stmt.type === 'use_statement' || stmt.type === 'include_statement') continue;
    queue.push(stmt);
  }
  const enqueueDefs = (defs: Node[] | undefined) => {
    for (const d of defs ?? []) {
      if (visited.has(d.id)) continue;
      visited.add(d.id);
      queue.push(d);
    }
  };

  while (queue.length > 0) {
    const node = queue.pop()!;
    // A definition reached through a call: its parameters' defaults and
    // its body. Definitions nested inside it are reached the same way.
    for (const call of node.descendantsOfType('module_instantiation')) {
      if (!call || insideNestedDefinition(call, node)) continue;
      const name = call.childForFieldName('name')?.text;
      if (!name) continue;
      if (localModules.has(name)) enqueueDefs(localModules.get(name));
      else if (BUILTIN_OVERRIDES[name]) {
        if (!builtinArgumentsOnly(call, name)) return true;
      } else if (names.modules.has(name)) return true;
    }
    for (const call of node.descendantsOfType('call_expression')) {
      if (!call || insideNestedDefinition(call, node)) continue;
      const fn = call.childForFieldName('function');
      if (fn?.type !== 'identifier') continue;
      const name = fn.text;
      if (localFunctions.has(name)) enqueueDefs(localFunctions.get(name));
      else if (names.functions.has(name)) return true;
    }
    for (const id of node.descendantsOfType(['identifier', 'special_variable'])) {
      if (!id || insideNestedDefinition(id, node) || !isVariableRead(id)) continue;
      const name = id.text;
      if (boundLocally(id, name)) continue;
      if (localVariables.has(name)) enqueueDefs(localVariables.get(name));
      else if (names.variables.has(name)) return true;
    }
  }
  return false;
}

// Within a reached node, a definition nested inside it is only evaluated
// when called, so its contents are skipped until a call reaches it.
function insideNestedDefinition(n: Node, top: Node): boolean {
  for (let p: Node | null = n.parent; p && !p.equals(top); p = p.parent) if (DEFINITIONS.has(p.type)) return true;
  return false;
}

const BOSL2_DIRECTIVE = /^\s*BOSL2[\\/]/;

/**
 * `source` with its BOSL2 use/include directives blanked out (same length
 * of lines, so engine line numbers don't move) when the render doesn't use
 * BOSL2, else `source` unchanged.
 */
export function withoutUnusedBosl2(source: string, tree: Tree, names: Bosl2Names): string {
  const directives = tree.rootNode
    .descendantsOfType(['include_statement', 'use_statement'])
    .filter((d): d is Node => d !== null && BOSL2_DIRECTIVE.test(directivePath(d) ?? ''));
  if (directives.length === 0 || usesBosl2(tree, names)) return source;
  let out = source;
  for (const d of [...directives].sort((a, b) => b.startIndex - a.startIndex)) {
    out = out.slice(0, d.startIndex) + out.slice(d.startIndex, d.endIndex).replace(/[^\n]/g, ' ') + out.slice(d.endIndex);
  }
  return out;
}

function directivePath(d: Node): string | null {
  const m = /<([^>]*)>/.exec(d.text);
  return m ? m[1]! : null;
}
