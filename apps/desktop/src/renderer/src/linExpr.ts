import { parseScadSync } from './scadParser';

// M11: a sum of expression terms plus a constant, for writing the
// placement a relate tool computes (`base_x + base_w + gap - 2.5`) as
// readable OpenSCAD instead of a pile of nested parentheses. Each term keeps
// its source text, how tightly it binds (to know when it needs parentheses)
// and its current value (for previews and default offsets; NaN when the
// evaluator can't work it out, e.g. a module parameter).

export type Precedence = 'atom' | 'mul' | 'add' | 'other';

export interface Term {
  text: string;
  prec: Precedence;
  value: number;
}

export interface Lin {
  k: number;
  terms: { coef: number; term: Term }[];
}

export const constant = (k: number): Lin => ({ k, terms: [] });

export function fromTerm(term: Term): Lin {
  return { k: 0, terms: [{ coef: 1, term }] };
}

export function add(...parts: Lin[]): Lin {
  const out: Lin = { k: 0, terms: [] };
  for (const p of parts) {
    out.k += p.k;
    for (const t of p.terms) {
      const same = out.terms.find((x) => x.term.text === t.term.text);
      if (same) same.coef += t.coef;
      else out.terms.push({ coef: t.coef, term: t.term });
    }
  }
  out.terms = out.terms.filter((t) => Math.abs(t.coef) > 1e-12);
  return out;
}

export function scale(a: Lin, c: number): Lin {
  return { k: a.k * c, terms: a.terms.map((t) => ({ coef: t.coef * c, term: t.term })) };
}

export const sub = (a: Lin, b: Lin): Lin => add(a, scale(b, -1));

export function value(a: Lin): number {
  return a.terms.reduce((s, t) => s + t.coef * t.term.value, a.k);
}

export function isConstant(a: Lin): boolean {
  return a.terms.length === 0;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** How tightly `text` binds, from its parse. */
export function precedenceOf(text: string): Precedence {
  const tree = parseScadSync(`__p = ${text};`);
  try {
    const node = tree?.rootNode.child(0)?.child(0)?.childForFieldName('value');
    if (!node) return 'other';
    switch (node.type) {
      case 'identifier':
      case 'number':
      case 'call_expression':
      case 'index_expression':
      case 'member_expression':
      case 'parenthesized_expression':
      case 'vector_expression':
        return 'atom';
      case 'unary_expression':
        return 'mul';
      case 'binary_expression': {
        const op = node.childForFieldName('operator')?.type ?? '';
        if (op === 'multiplication_operator' || op === 'division_operator' || op === 'modulo_operator') return 'mul';
        if (op === 'addition_operator' || op === 'subtraction_operator') return 'add';
        if (op === 'exponentiation_operator') return 'atom';
        return 'other';
      }
      default:
        return 'other';
    }
  } finally {
    tree?.delete();
  }
}

export function term(text: string, value: number): Term {
  return { text: text.trim(), prec: precedenceOf(text), value };
}

function factor(t: Term, coef: number): string {
  const a = Math.abs(coef);
  if (Math.abs(a - 1) < 1e-12) return t.text;
  const inner = t.prec === 'atom' || t.prec === 'mul' ? t.text : `(${t.text})`;
  const inverse = 1 / a;
  if (Math.abs(inverse - Math.round(inverse)) < 1e-9 && Math.round(inverse) > 1) return `${inner} / ${Math.round(inverse)}`;
  return `${round(a)} * ${inner}`;
}

/** OpenSCAD text for `a`, e.g. `base_x + base_w / 2 + 2.5`. */
export function format(a: Lin): string {
  const parts: string[] = [];
  a.terms.forEach(({ coef, term: t }, i) => {
    let body = factor(t, coef);
    // A lone additive term needs parentheses only after a minus sign.
    if (coef < 0 && Math.abs(Math.abs(coef) - 1) < 1e-12 && t.prec !== 'atom' && t.prec !== 'mul') body = `(${body})`;
    if (t.prec === 'other' && Math.abs(Math.abs(coef) - 1) < 1e-12 && coef > 0) body = `(${body})`;
    if (i === 0) parts.push(coef < 0 ? `-${body}` : body);
    else parts.push(coef < 0 ? `- ${body}` : `+ ${body}`);
  });
  const k = round(a.k);
  if (parts.length === 0) return String(k);
  if (k > 0) parts.push(`+ ${k}`);
  else if (k < 0) parts.push(`- ${-k}`);
  return parts.join(' ');
}
