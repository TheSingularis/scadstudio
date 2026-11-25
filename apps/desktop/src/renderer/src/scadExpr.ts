import type { Node, Tree } from 'web-tree-sitter';
import { parseScadSync } from './scadParser';

// M11: a small evaluator for OpenSCAD expressions, run on the tree-sitter
// syntax tree. It exists so a transform written as an expression
// (`translate([base_w + gap, 0, 0])`) can still be shown with a three.js
// transform and edited with the gizmo on its literal axes, and so the
// variables panel can show what each variable comes to.
//
// It covers the arithmetic a parametric file uses for sizes and placement:
// numbers, booleans, strings, vectors, ranges, + - * / % ^, comparisons,
// && || !, ?:, indexing (`v[0]`, `v.x`), let(), list comprehensions, the
// math built-ins (trigonometry in degrees, as in OpenSCAD) and the file's
// own functions. Anything else (special variables such as $fn, a name the
// file doesn't define, a built-in it doesn't know) makes the whole
// expression "not evaluable" rather than guessing, and callers then fall
// back to treating the expression as opaque text. Pinned against the
// engine's own echo() output in test/integration/scadExpr.test.ts.

export type Value = number | boolean | string | undefined | Value[] | RangeValue;

export interface RangeValue {
  range: true;
  start: number;
  step: number;
  end: number;
}

class NotEvaluable extends Error {}

const fail = (why: string): never => {
  throw new NotEvaluable(why);
};

interface FunctionDef {
  params: { name: string; defaultNode: Node | null }[];
  body: Node;
  scope: Scope;
}

/** Name lookup for one level; `parent` is the enclosing level. */
export class Scope {
  private readonly values = new Map<string, Value>();
  private readonly lazy = new Map<string, Node>();
  private readonly evaluating = new Set<string>();
  // Names bound at this level whose value isn't known (a module parameter,
  // a `for` variable): any expression that reads one is not evaluable.
  private readonly unknown = new Set<string>();
  readonly functions = new Map<string, FunctionDef>();

  constructor(readonly parent: Scope | null = null) {}

  setValue(name: string, value: Value) {
    this.values.set(name, value);
  }

  setLazy(name: string, node: Node) {
    this.lazy.set(name, node);
  }

  setUnknown(name: string) {
    this.unknown.add(name);
  }

  lookup(name: string, depth: number): Value {
    if (this.unknown.has(name)) fail(`${name} is not known here`);
    if (this.values.has(name)) return this.values.get(name);
    const node = this.lazy.get(name);
    if (node) {
      if (this.evaluating.has(name)) fail(`${name} refers to itself`);
      this.evaluating.add(name);
      try {
        const value = evaluate(node, this, depth + 1);
        this.values.set(name, value);
        return value;
      } finally {
        this.evaluating.delete(name);
      }
    }
    if (this.parent) return this.parent.lookup(name, depth);
    if (name === 'PI') return Math.PI;
    return fail(`${name} is not defined`);
  }

  lookupFunction(name: string): FunctionDef | null {
    return this.functions.get(name) ?? this.parent?.lookupFunction(name) ?? null;
  }
}

function concreteStatement(stmt: Node | null): Node | null {
  if (!stmt) return null;
  return stmt.type === 'statement' ? stmt.child(0) : stmt;
}

function functionDef(def: Node, scope: Scope): [string, FunctionDef] | null {
  const name = def.childForFieldName('name')?.text;
  const body = def.childForFieldName('value');
  if (!name || !body) return null;
  return [name, { params: parameterList(def.childForFieldName('parameters')), body, scope }];
}

export function parameterList(list: Node | null): { name: string; defaultNode: Node | null }[] {
  const decls = list?.namedChildren.find((c) => c?.type === 'parameter_declarations');
  const out: { name: string; defaultNode: Node | null }[] = [];
  for (const decl of decls?.namedChildren ?? []) {
    if (!decl || decl.type !== 'parameter_declaration') continue;
    const nameNode = decl.namedChild(0);
    if (!nameNode) continue;
    out.push({ name: nameNode.text, defaultNode: decl.namedChildCount > 1 ? decl.namedChild(1) : null });
  }
  return out;
}

const documentScopes = new WeakMap<Tree, Scope>();

/**
 * The document's top-level scope: its assignments (the last assignment of
 * a name wins, as in OpenSCAD) and functions. Cached per parse.
 */
export function documentScope(root: Node): Scope {
  const cached = documentScopes.get(root.tree);
  if (cached) return cached;
  const scope = new Scope();
  for (const child of root.children) {
    const stmt = concreteStatement(child);
    if (stmt?.type === 'assignment_statement') {
      const name = stmt.childForFieldName('name');
      const value = stmt.childForFieldName('value');
      if (!name || !value) continue;
      if (name.type === 'special_variable') scope.setUnknown(name.text);
      else scope.setLazy(name.text, value);
    } else if (stmt?.type === 'function_definition') {
      const entry = functionDef(stmt, scope);
      if (entry) scope.functions.set(entry[0], entry[1]);
    }
  }
  documentScopes.set(root.tree, scope);
  return scope;
}

/**
 * The scope an expression at `node` sees: the document scope, with every
 * name bound by an enclosing module, function, `for`, `let` or block
 * marked unknown (its value depends on the call or the iteration, which
 * this evaluator doesn't model).
 */
export function scopeAt(node: Node): Scope {
  let root: Node = node;
  while (root.parent) root = root.parent;
  const base = documentScope(root);
  const shadowed = new Set<string>();
  for (let n: Node | null = node.parent; n; n = n.parent) {
    switch (n.type) {
      case 'module_definition':
      case 'function_definition':
        for (const p of parameterList(n.childForFieldName('parameters'))) shadowed.add(p.name);
        break;
      case 'list_comprehension':
        for (const a of n.namedChildren) {
          if (a?.type === 'let_assignment') {
            const name = a.childForFieldName('name')?.text;
            if (name) shadowed.add(name);
          }
        }
        break;
      case 'for_statement':
      case 'list_comprehension_for': {
        const it = n.childForFieldName('iterator');
        if (it) shadowed.add(it.text);
        for (const a of n.namedChildren) {
          if (a?.type === 'for_assignment' || a?.type === 'list_comprehension_assignment') {
            const name = a.childForFieldName('iterator')?.text;
            if (name) shadowed.add(name);
          }
        }
        break;
      }
      case 'let_expression':
        for (const a of n.namedChildren) {
          if (a?.type === 'let_assignment') {
            const name = a.childForFieldName('name')?.text;
            if (name) shadowed.add(name);
          }
        }
        break;
      case 'block':
        for (const s of n.namedChildren) {
          const stmt = concreteStatement(s);
          if (stmt?.type === 'assignment_statement') {
            const name = stmt.childForFieldName('name')?.text;
            if (name) shadowed.add(name);
          }
        }
        break;
    }
  }
  if (shadowed.size === 0) return base;
  const scope = new Scope(base);
  for (const name of shadowed) scope.setUnknown(name);
  return scope;
}

/** The value of `node`, or undefined-with-ok=false when it can't be worked out. */
export function tryEvaluate(node: Node, scope: Scope = scopeAt(node)): { ok: true; value: Value } | { ok: false; why: string } {
  try {
    return { ok: true, value: evaluate(node, scope, 0) };
  } catch (err) {
    if (err instanceof NotEvaluable) return { ok: false, why: err.message };
    throw err;
  }
}

/** A finite number, or null when the node isn't one or can't be evaluated. */
export function evaluateNumber(node: Node, scope: Scope = scopeAt(node)): number | null {
  const r = tryEvaluate(node, scope);
  return r.ok && typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
}

const MAX_DEPTH = 200;

function isRange(v: Value): v is RangeValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'range' in v;
}

function truthy(v: Value): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function num(v: Value): number {
  return typeof v === 'number' ? v : fail('expected a number');
}

function rangeValues(r: RangeValue): number[] {
  const out: number[] = [];
  if (r.step === 0) return out;
  // OpenSCAD swaps a backwards [a:b] (with the default step) and warns.
  let { start, end } = r;
  const { step } = r;
  if (step > 0 && end < start) [start, end] = [end, start];
  const count = Math.floor((end - start) / step + 1e-12) + 1;
  if (count > 100000) fail('range too long');
  for (let i = 0; i < count; i++) out.push(start + i * step);
  return out;
}

function iterate(v: Value): Value[] {
  if (Array.isArray(v)) return v;
  if (isRange(v)) return rangeValues(v);
  if (typeof v === 'string') return [...v];
  return [v];
}

function equal(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isRange(a) || isRange(b)) return false;
  return a === b;
}

function arith(op: string, a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '%':
        return a % b;
      case '^':
        return Math.pow(a, b);
    }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (op === '+' || op === '-') {
      const n = Math.min(a.length, b.length);
      return Array.from({ length: n }, (_, i) => arith(op, a[i], b[i]));
    }
    if (op === '*' && a.every((x) => typeof x === 'number') && b.every((x) => typeof x === 'number')) {
      if (a.length !== b.length) return undefined;
      return a.reduce((s: number, x, i) => s + (x as number) * (b[i] as number), 0);
    }
    return fail('vector operation not supported');
  }
  if (Array.isArray(a) && typeof b === 'number' && (op === '*' || op === '/')) return a.map((x) => arith(op, x, b));
  if (typeof a === 'number' && Array.isArray(b) && op === '*') return b.map((x) => arith(op, a, x));
  // OpenSCAD gives undef for mismatched operands (with a warning).
  if (a === undefined || b === undefined || typeof a !== typeof b) return undefined;
  return fail(`${op} not supported for these values`);
}

const OPERATORS: Record<string, string> = {
  addition_operator: '+',
  subtraction_operator: '-',
  multiplication_operator: '*',
  division_operator: '/',
  modulo_operator: '%',
  exponentiation_operator: '^',
  less_than_operator: '<',
  greater_than_operator: '>',
  less_than_or_equal_operator: '<=',
  greater_than_or_equal_operator: '>=',
  equality_operator: '==',
  inequality_operator: '!=',
  logical_and_operator: '&&',
  logical_or_operator: '||',
};

function operatorOf(node: Node): string {
  const op = node.childForFieldName('operator');
  if (op) return OPERATORS[op.type] ?? op.text;
  // Fallback: the unnamed operator token between the operands.
  for (const c of node.children) if (c && !c.isNamed) return c.text;
  return fail('unknown operator');
}

const DEG = Math.PI / 180;

// OpenSCAD's round() rounds halves away from zero; Math.round rounds them up.
const roundAway = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

function numbersOf(args: Value[]): number[] {
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return list.map(num);
}

const BUILTINS: Record<string, (args: Value[]) => Value> = {
  sin: ([x]) => Math.sin(num(x) * DEG),
  cos: ([x]) => Math.cos(num(x) * DEG),
  tan: ([x]) => Math.tan(num(x) * DEG),
  asin: ([x]) => Math.asin(num(x)) / DEG,
  acos: ([x]) => Math.acos(num(x)) / DEG,
  atan: ([x]) => Math.atan(num(x)) / DEG,
  atan2: ([y, x]) => Math.atan2(num(y), num(x)) / DEG,
  abs: ([x]) => Math.abs(num(x)),
  sign: ([x]) => Math.sign(num(x)),
  floor: ([x]) => Math.floor(num(x)),
  ceil: ([x]) => Math.ceil(num(x)),
  round: ([x]) => roundAway(num(x)),
  sqrt: ([x]) => Math.sqrt(num(x)),
  pow: ([x, y]) => Math.pow(num(x), num(y)),
  exp: ([x]) => Math.exp(num(x)),
  ln: ([x]) => Math.log(num(x)),
  log: (args) => (args.length >= 2 ? Math.log(num(args[1])) / Math.log(num(args[0])) : Math.log10(num(args[0]))),
  min: (args) => Math.min(...numbersOf(args)),
  max: (args) => Math.max(...numbersOf(args)),
  len: ([x]) => (Array.isArray(x) || typeof x === 'string' ? x.length : undefined),
  norm: ([v]) => (Array.isArray(v) ? Math.sqrt(v.reduce((s: number, x) => s + num(x) ** 2, 0)) : undefined),
  concat: (args) => args.flatMap((a) => (Array.isArray(a) ? a : [a])),
  is_num: ([x]) => typeof x === 'number' && !Number.isNaN(x),
  is_bool: ([x]) => typeof x === 'boolean',
  is_string: ([x]) => typeof x === 'string',
  is_list: ([x]) => Array.isArray(x),
  is_undef: ([x]) => x === undefined,
};

function callArguments(call: Node, scope: Scope, depth: number): { positional: Value[]; named: Map<string, Value> } {
  const list = call.childForFieldName('arguments');
  const args = list?.namedChildren.find((c) => c?.type === 'arguments');
  const positional: Value[] = [];
  const named = new Map<string, Value>();
  for (const arg of args?.namedChildren ?? []) {
    if (!arg || arg.type !== 'argument') continue;
    const name = arg.childForFieldName('name');
    const value = arg.childForFieldName('value') ?? arg.namedChild(0);
    if (!value) continue;
    if (name) named.set(name.text, evaluate(value, scope, depth + 1));
    else positional.push(evaluate(value, scope, depth + 1));
  }
  return { positional, named };
}

function comprehension(node: Node, scope: Scope, depth: number): Value[] {
  // [let (...) for (i = r[, j = r2]) if (cond) expr]
  const inner = new Scope(scope);
  for (const a of node.namedChildren) {
    if (a?.type !== 'let_assignment') continue;
    const name = a.childForFieldName('name')?.text;
    const value = a.childForFieldName('value');
    if (!name || !value) fail('let');
    inner.setValue(name!, evaluate(value!, inner, depth + 1));
  }
  const clause = node.namedChildren.find((c) => c?.type === 'list_comprehension_for');
  const expr = node.childForFieldName('expr');
  const cond = node.childForFieldName('condition');
  if (!clause || !expr) return fail('comprehension not supported');
  const loops: { name: string; range: Node }[] = [];
  const single = clause.childForFieldName('iterator');
  if (single) loops.push({ name: single.text, range: clause.childForFieldName('range') ?? fail('comprehension') });
  for (const a of clause.namedChildren) {
    if (a?.type !== 'list_comprehension_assignment') continue;
    loops.push({ name: a.childForFieldName('iterator')?.text ?? fail('comprehension'), range: a.childForFieldName('range') ?? fail('comprehension') });
  }
  const out: Value[] = [];
  // Several assignments in one for() nest, first outermost.
  const run = (i: number, s: Scope) => {
    if (i === loops.length) {
      if (!cond || truthy(evaluate(cond, s, depth + 1))) out.push(evaluate(expr, s, depth + 1));
      return;
    }
    for (const v of iterate(evaluate(loops[i].range, s, depth + 1))) {
      const next = new Scope(s);
      next.setValue(loops[i].name, v);
      run(i + 1, next);
      if (out.length > 100000) fail('comprehension too long');
    }
  };
  run(0, inner);
  return out;
}

// The grammar mis-reads some bracketed ranges: `[0 : n - 1]` comes out as
// `(0 : n) - 1`, and `[0 : 2 : n - 1]` nests the same way. A vector whose
// own expression tree holds a range anywhere but at its top is such a
// range; it's re-read from its text, one colon-separated part at a time.
function hasLooseRange(vec: Node): boolean {
  const walk = (n: Node, top: boolean): boolean => {
    if (n.type === 'range_expression' && !top) return true;
    if (n.type === 'vector_expression' || n.type === 'call_expression' || n.type === 'parenthesized_expression' || n.type === 'list_comprehension') return false;
    return n.namedChildren.some((c) => c !== null && walk(c, false));
  };
  return vec.namedChildCount === 1 && vec.namedChild(0) !== null && walk(vec.namedChild(0)!, vec.namedChild(0)!.type === 'range_expression');
}

function bracketRange(text: string, scope: Scope, depth: number): RangeValue {
  const inner = text.trim().slice(1, -1);
  if (inner.includes('?')) fail('range with ?: not supported');
  const parts: string[] = [];
  let level = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[') level++;
    else if (c === ')' || c === ']') level--;
    else if (c === ':' && level === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  if (parts.length < 2 || parts.length > 3) fail('not a range');
  const values = parts.map((part) => {
    const tree = parseScadSync(`__range_part = ${part};`) ?? fail('parser not ready');
    try {
      const value = tree.rootNode.child(0)?.child(0)?.childForFieldName('value') ?? fail('range part');
      return num(evaluate(value, scope, depth + 1));
    } finally {
      tree.delete();
    }
  });
  return parts.length === 2
    ? { range: true, start: values[0], step: 1, end: values[1] }
    : { range: true, start: values[0], step: values[1], end: values[2] };
}

export function evaluate(node: Node, scope: Scope, depth: number): Value {
  if (depth > MAX_DEPTH) fail('too deep');
  switch (node.type) {
    case 'number':
      return Number(node.text);
    case 'boolean':
      return node.text === 'true';
    case 'undef':
      return undefined;
    case 'string':
      return unquote(node.text);
    case 'identifier':
      return scope.lookup(node.text, depth);
    case 'special_variable':
      return fail(`${node.text} is a special variable`);
    case 'parenthesized_expression':
    case 'primary_expression':
    case 'expression': {
      const inner = node.namedChild(0);
      return inner ? evaluate(inner, scope, depth + 1) : fail('empty expression');
    }
    case 'vector_expression': {
      if (hasLooseRange(node)) return bracketRange(node.text, scope, depth);
      const out: Value[] = [];
      for (const c of node.namedChildren) {
        if (!c) continue;
        if (c.type === 'range_expression' && node.namedChildCount === 1) return evaluate(c, scope, depth + 1);
        out.push(evaluate(c, scope, depth + 1));
      }
      return out;
    }
    case 'range_expression': {
      if (node.text.trimStart().startsWith('[') && node.descendantsOfType('range_expression').length > 1) {
        return bracketRange(node.text, scope, depth);
      }
      // Inside brackets the grammar reads `[a : s : b]` as a range whose
      // start is the range `a : s`; that is OpenSCAD's three-part range.
      const nested = node.childForFieldName('start');
      if (nested?.type === 'range_expression' && !node.childForFieldName('step') && !nested.childForFieldName('step')) {
        const start = num(evaluate(nested.childForFieldName('start') ?? fail('range'), scope, depth + 1));
        const step = num(evaluate(nested.childForFieldName('end') ?? fail('range'), scope, depth + 1));
        const end = num(evaluate(node.childForFieldName('end') ?? fail('range'), scope, depth + 1));
        return { range: true, start, step, end };
      }
      const start = num(evaluate(node.childForFieldName('start') ?? fail('range'), scope, depth + 1));
      const stepNode = node.childForFieldName('step');
      const step = stepNode ? num(evaluate(stepNode, scope, depth + 1)) : 1;
      const end = num(evaluate(node.childForFieldName('end') ?? fail('range'), scope, depth + 1));
      return { range: true, start, step, end };
    }
    case 'unary_expression': {
      const op = node.childForFieldName('operator')?.type;
      const operand = evaluate(node.childForFieldName('operand') ?? fail('unary'), scope, depth + 1);
      if (op === 'logical_not_operator') return !truthy(operand);
      if (op === 'unary_plus_operator') return operand;
      if (op === 'unary_minus_operator') {
        if (typeof operand === 'number') return -operand;
        if (Array.isArray(operand)) return operand.map((x) => arith('*', x, -1));
        return undefined;
      }
      return fail('unknown unary operator');
    }
    case 'binary_expression': {
      const op = operatorOf(node);
      const leftNode = node.childForFieldName('left') ?? fail('binary');
      const rightNode = node.childForFieldName('right') ?? fail('binary');
      if (op === '&&') return truthy(evaluate(leftNode, scope, depth + 1)) && truthy(evaluate(rightNode, scope, depth + 1));
      if (op === '||') return truthy(evaluate(leftNode, scope, depth + 1)) || truthy(evaluate(rightNode, scope, depth + 1));
      // OpenSCAD binds ^ tighter than unary minus (-2^2 is -4); the grammar
      // parses `-a ^ b` as `(-a) ^ b`, so undo that here.
      if (op === '^' && leftNode.type === 'unary_expression' && leftNode.childForFieldName('operator')?.type === 'unary_minus_operator') {
        const base = evaluate(leftNode.childForFieldName('operand') ?? fail('unary'), scope, depth + 1);
        const r = arith('^', base, evaluate(rightNode, scope, depth + 1));
        return typeof r === 'number' ? -r : undefined;
      }
      const a = evaluate(leftNode, scope, depth + 1);
      const b = evaluate(rightNode, scope, depth + 1);
      switch (op) {
        case '==':
          return equal(a, b);
        case '!=':
          return !equal(a, b);
        case '<':
        case '>':
        case '<=':
        case '>=': {
          if (typeof a === 'number' && typeof b === 'number') {
            return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
          }
          if (typeof a === 'string' && typeof b === 'string') {
            return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
          }
          return undefined;
        }
        default:
          return arith(op, a, b);
      }
    }
    case 'conditional_expression': {
      const cond = evaluate(node.childForFieldName('condition') ?? fail('?:'), scope, depth + 1);
      const branch = truthy(cond) ? node.childForFieldName('consequence') : node.childForFieldName('alternative');
      return evaluate(branch ?? fail('?:'), scope, depth + 1);
    }
    case 'index_expression': {
      const arr = evaluate(node.childForFieldName('array') ?? fail('index'), scope, depth + 1);
      const index = num(evaluate(node.childForFieldName('index') ?? fail('index'), scope, depth + 1));
      if (!Number.isInteger(index)) fail('non-integer index');
      if (Array.isArray(arr) || typeof arr === 'string') return arr[index];
      return undefined;
    }
    case 'member_expression': {
      const obj = evaluate(node.childForFieldName('object') ?? fail('member'), scope, depth + 1);
      const prop = node.childForFieldName('property')?.text;
      const i = prop === 'x' ? 0 : prop === 'y' ? 1 : prop === 'z' ? 2 : -1;
      if (i < 0) fail(`.${prop} not supported`);
      return Array.isArray(obj) ? obj[i] : undefined;
    }
    case 'let_expression': {
      const inner = new Scope(scope);
      for (const a of node.namedChildren) {
        if (a?.type !== 'let_assignment') continue;
        const name = a.childForFieldName('name')?.text;
        const value = a.childForFieldName('value');
        if (!name || !value) fail('let');
        // let() assigns in order: each one sees the ones before it.
        inner.setValue(name!, evaluate(value!, inner, depth + 1));
      }
      return evaluate(node.childForFieldName('body') ?? fail('let'), inner, depth + 1);
    }
    case 'list_comprehension':
      return comprehension(node, scope, depth);
    case 'call_expression': {
      const fnNode = node.childForFieldName('function');
      if (fnNode?.type !== 'identifier') return fail('call of a computed function');
      const name = fnNode.text;
      const user = scope.lookupFunction(name);
      if (user) {
        const { positional, named } = callArguments(node, scope, depth);
        const inner = new Scope(user.scope);
        user.params.forEach((p, i) => {
          if (i < positional.length) inner.setValue(p.name, positional[i]);
          else if (named.has(p.name)) inner.setValue(p.name, named.get(p.name));
          else if (p.defaultNode) inner.setValue(p.name, evaluate(p.defaultNode, user.scope, depth + 1));
          else inner.setValue(p.name, undefined);
        });
        return evaluate(user.body, inner, depth + 1);
      }
      const builtin = BUILTINS[name];
      if (!builtin) return fail(`${name}() is not supported`);
      const { positional, named } = callArguments(node, scope, depth);
      if (named.size > 0) fail('named arguments to a built-in function');
      return builtin(positional);
    }
    default:
      return fail(`${node.type} not supported`);
  }
}

function unquote(literal: string): string {
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));
}

/** A value as OpenSCAD's echo() would print it (used for display). */
export function formatValue(v: Value): string {
  if (v === undefined) return 'undef';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    return String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  return `[${v.start} : ${v.step} : ${v.end}]`;
}
