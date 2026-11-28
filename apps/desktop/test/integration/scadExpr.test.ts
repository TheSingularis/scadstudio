// M11: the expression evaluator (scadExpr.ts) is pinned against the bundled
// engine. Every case is evaluated in JS, then the engine checks the JS
// answer itself with echo(), all in one engine run.
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/main/engine';
import { documentScope, formatValue, tryEvaluate, type Value } from '../../src/renderer/src/scadExpr';
import { parse } from '../helpers/parse';

const CONTEXT = `
w = 30;
gap = 2.5;
v = [1, 2, 3];
n = 4;
flag = true;
name = "bolt";
function twice(x) = x * 2;
function pad(x, by = 1) = x + by;
`;

const CASES = [
  'w + gap',
  'w * 2 - gap / 2',
  '-2 ^ 2',
  '2 ^ 3 ^ 2',
  '-w ^ 2',
  '7 % 3',
  '-7 % 3',
  'v[1]',
  'v.z',
  'v * 2',
  'v + [1, 1, 1]',
  'v * v',
  '-v',
  'flag ? w : gap',
  '!flag || n > 3',
  'n >= 4 && n < 5',
  'n == 4',
  '[1, 2] == [1, 2]',
  'sin(30)',
  'cos(60) + tan(45)',
  'atan2(1, 1)',
  'asin(0.5)',
  'sqrt(16) + pow(2, 10)',
  'round(2.5) + round(-2.5) + floor(-1.5) + ceil(1.2)',
  'abs(-3) + sign(-2)',
  'min(3, 1, 2) + max([4, 9, 2])',
  'ln(10) + log(100) + exp(1)',
  'len(v) + len(name)',
  'norm([3, 4])',
  'twice(w)',
  'pad(1) + pad(1, 5) + pad(by = 2, x = 1)',
  'let (a = 2, b = a * 3) a + b',
  '[for (i = [0 : n - 1]) i * gap]',
  '[for (i = [0 : 2 : 6]) if (i != 2) i]',
  '[for (i = [0 : 1], j = [0 : 1]) i * 10 + j]',
  '[for (i = [2 : -1 : 0]) i]',
  '[for (i = [0 : 2 : n - 1]) i]',
  '[for (i = [1 : n]) i]',
  'PI',
  'concat(v, [4])',
  'w / 0',
  'undef',
  '"a" < "b"',
];

function literal(v: Value): string {
  if (v === undefined) return 'undef';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? '1/0' : '-1/0';
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(literal).join(', ')}]`;
  throw new Error('range');
}

describe('M11 expression evaluator (engine-checked)', () => {
  it('agrees with OpenSCAD on every case', async () => {
    const tree = await parse(`${CONTEXT}\n${CASES.map((c, i) => `case_${i} = ${c};`).join('\n')}\n`);
    const scope = documentScope(tree.rootNode);
    const checks: string[] = [];
    const shown: string[] = [];
    CASES.forEach((c, i) => {
      const stmt = tree.rootNode.children.find((s) => s?.child(0)?.childForFieldName('name')?.text === `case_${i}`);
      const value = stmt!.child(0)!.childForFieldName('value')!;
      const r = tryEvaluate(value, scope);
      expect(r.ok, `${c}: ${r.ok ? '' : r.why}`).toBe(true);
      const v = (r as { value: Value }).value;
      const lit = literal(v);
      shown.push(formatValue(v));
      const check =
        typeof v === 'number' && Number.isFinite(v)
          ? `abs((${c}) - (${lit})) < 1e-9 * max(1, abs(${lit}))`
          : Array.isArray(v) && v.every((x) => typeof x === 'number')
            ? `len(${c}) == ${v.length} && norm((${c}) - (${lit})) < 1e-9`
            : `(${c}) == (${lit})`;
      checks.push(`echo(str("R", ${i}, "=", ${check}));`);
    });
    const log: string[] = [];
    const engine = await createEngine({ print: (t) => log.push(t), printErr: (t) => log.push(t) });
    engine.FS.writeFile('/input.scad', `${CONTEXT}\n${checks.join('\n')}\ncube(1);\n`);
    engine.callMain(['/input.scad', '-o', '/out.echo']);
    log.push(...(engine.FS.readFile('/out.echo', { encoding: 'utf8' }) as string).split('\n'));
    const results = new Map<number, string>();
    for (const line of log) {
      const m = /ECHO: "R(\d+)=(\w+)"/.exec(line);
      if (m) results.set(Number(m[1]), m[2]);
    }
    const failures = CASES.map((c, i) => ({ c, js: shown[i], got: results.get(i) })).filter((r) => r.got !== 'true');
    expect(failures, log.filter((l) => /WARNING|ERROR/.test(l)).join('\n')).toEqual([]);
  });

  it('refuses what it cannot know', async () => {
    const tree = await parse('a = $fn * 2;\nb = undefined_name + 1;\nc = foo(1);\nmodule m(w = 3) { cube(w); }\n');
    const scope = documentScope(tree.rootNode);
    for (const name of ['a', 'b', 'c']) {
      const stmt = tree.rootNode.children.find((s) => s?.child(0)?.childForFieldName('name')?.text === name)!;
      expect(tryEvaluate(stmt.child(0)!.childForFieldName('value')!, scope).ok).toBe(false);
    }
  });
});
