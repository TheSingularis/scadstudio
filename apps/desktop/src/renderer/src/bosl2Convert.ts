// M13: turning a plain cube()/cylinder() into BOSL2's cuboid()/cyl(), so
// its edges can be rounded, without moving it.
//
// The Fillet/Chamfer tools only work on BOSL2's own shapes (bosl2Shapes.ts),
// so for the most common parts, a plain cube or cylinder, the tool offers
// to convert it first. The converted call renders the same solid (pinned
// by test/integration/bosl2.test.ts, by bounding box, volume and triangle
// count), and the conversion adds `include <BOSL2/std.scad>` when the file
// doesn't have it.
//
// The only difference to bridge is where each shape sits by default:
// - cube() sits on the origin corner unless center=true; cuboid() is
//   centered, so an uncentered cube gets `anchor = BOT+FRONT+LEFT`.
//   cuboid() has no center parameter, so a cube whose center is an
//   expression isn't converted (the anchor couldn't follow it).
// - cylinder() stands on z=0 unless center=true; cyl() is centered, but it
//   takes center= with the same meaning, so center is passed through and
//   a cylinder without one gets `anchor = BOT`.
// Positional arguments become named ones (cylinder's positional order,
// h, r1, r2, center, differs from cyl's), and special variables ($fn ...)
// are kept as written.

import type { Node, Tree } from 'web-tree-sitter';
import { bindArguments, callArguments, type CallArgument } from './bosl2Shapes';

export type ConvertibleBuiltin = 'cube' | 'cylinder';

export interface Conversion {
  from: ConvertibleBuiltin;
  to: 'cuboid' | 'cyl';
  /** Byte range of the call head (name through its closing parenthesis) and its replacement. */
  start: number;
  end: number;
  text: string;
}

export type ConversionResult = { ok: true; conversion: Conversion } | { ok: false; why: string };

const CUBE_SIGNATURE = ['size', 'center'];
const CYLINDER_SIGNATURE = ['h', 'r1', 'r2', 'center'];
const CYLINDER_NAMES = new Set(['h', 'r', 'r1', 'r2', 'd', 'd1', 'd2', 'center']);

export function convertibleBuiltin(call: Node): ConvertibleBuiltin | null {
  if (call.type !== 'module_instantiation') return null;
  const name = call.childForFieldName('name')?.text;
  return name === 'cube' || name === 'cylinder' ? name : null;
}

const isSpecial = (a: CallArgument) => a.name !== null && a.name.startsWith('$');

function literalBool(arg: CallArgument | undefined): boolean | null | 'expression' {
  if (!arg) return null;
  const t = arg.value.text.trim();
  if (t === 'true') return true;
  if (t === 'false' || t === 'undef') return false;
  return 'expression';
}

export function bosl2Conversion(call: Node): ConversionResult {
  const from = convertibleBuiltin(call);
  if (!from) return { ok: false, why: 'only cube() and cylinder() can be converted' };
  const args = callArguments(call);
  const name = call.childForFieldName('name')!;
  const list = call.childForFieldName('arguments');
  if (!list) return { ok: false, why: 'the call is incomplete' };
  const special = args.filter(isSpecial).map((a) => a.node.text);
  const plain = args.filter((a) => !isSpecial(a));

  if (from === 'cube') {
    const bound = bindArguments(plain, CUBE_SIGNATURE);
    const unknown = plain.find((a) => a.name !== null && !CUBE_SIGNATURE.includes(a.name));
    if (unknown) return { ok: false, why: `cube() has no parameter ${unknown.name}` };
    if (plain.filter((a) => a.name === null).length > 2) return { ok: false, why: 'cube() has too many arguments' };
    const center = literalBool(bound.get('center'));
    if (center === 'expression') return { ok: false, why: 'its center is an expression, and cuboid() places parts by anchor instead' };
    const size = bound.get('size');
    const parts: string[] = [];
    if (size) parts.push(size.name === null ? size.value.text : `size = ${size.value.text}`);
    if (center !== true) parts.push('anchor = BOT+FRONT+LEFT');
    parts.push(...special);
    return { ok: true, conversion: { from, to: 'cuboid', start: name.startIndex, end: list.endIndex, text: `cuboid(${parts.join(', ')})` } };
  }

  const bound = bindArguments(plain, CYLINDER_SIGNATURE);
  const unknown = plain.find((a) => a.name !== null && !CYLINDER_NAMES.has(a.name));
  if (unknown) return { ok: false, why: `cylinder() has no parameter ${unknown.name}` };
  if (plain.filter((a) => a.name === null).length > 4) return { ok: false, why: 'cylinder() has too many arguments' };
  const parts: string[] = [];
  // In cylinder's own order, named.
  for (const n of ['h', 'r', 'r1', 'r2', 'd', 'd1', 'd2']) {
    const a = bound.get(n);
    if (a) parts.push(`${n} = ${a.value.text}`);
  }
  const center = bound.get('center');
  if (center) parts.push(`center = ${center.value.text}`);
  else parts.push('anchor = BOT');
  parts.push(...special);
  return { ok: true, conversion: { from, to: 'cyl', start: name.startIndex, end: list.endIndex, text: `cyl(${parts.join(', ')})` } };
}

const BOSL2_STD = 'BOSL2/std.scad';

/** Whether the document already includes BOSL2's std.scad (ignoring spacing and `\` vs `/`). */
export function hasBosl2Include(source: string): boolean {
  return directives(source).some((d) => d.kind === 'include' && d.target === BOSL2_STD);
}

function directives(source: string): { kind: 'use' | 'include'; target: string; start: number; end: number }[] {
  const out: { kind: 'use' | 'include'; target: string; start: number; end: number }[] = [];
  const re = /\b(use|include)\s*<([^>\n]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ kind: m[1] as 'use' | 'include', target: m[2]!.trim().replace(/\\/g, '/'), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Makes sure the document includes BOSL2. A `use <BOSL2/std.scad>` (which
 * can't work, BOSL2 needs its top-level variables) becomes an include;
 * otherwise the include goes after the document's leading use/include
 * lines, or at the top, as addUseDirective does for `use`.
 */
export function addBosl2Include(source: string): string {
  if (hasBosl2Include(source)) return source;
  const used = directives(source).find((d) => d.kind === 'use' && d.target === BOSL2_STD);
  if (used) return `${source.slice(0, used.start)}include <${BOSL2_STD}>${source.slice(used.end)}`;
  const line = `include <${BOSL2_STD}>`;
  const lines = source.split('\n');
  let lastDirective = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
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

/**
 * Converts `call` and adds the include. The include goes above the call,
 * so the call's offsets are applied first.
 */
export function convertToBosl2(source: string, call: Node): { ok: true; source: string; conversion: Conversion } | { ok: false; why: string } {
  const r = bosl2Conversion(call);
  if (!r.ok) return r;
  const c = r.conversion;
  const converted = source.slice(0, c.start) + c.text + source.slice(c.end);
  return { ok: true, source: addBosl2Include(converted), conversion: c };
}

/** Every cube()/cylinder() call in a tree that could be converted, for tests and the corpus check. */
export function conversionCandidates(tree: Tree): Node[] {
  return tree.rootNode.descendantsOfType('module_instantiation').filter((n): n is Node => n !== null && convertibleBuiltin(n) !== null);
}
