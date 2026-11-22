// M0/M2: the app's own parseScad() against the spike fixtures, plus the two
// grammar gaps PLAN.md documents (tracked so a grammar bump that fixes them
// shows up as an unexpected pass).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScad } from '../../src/renderer/src/scadParser';
import { SPIKE_FIXTURES_DIR } from '../helpers/paths';

const fixtures = readdirSync(SPIKE_FIXTURES_DIR).filter((f) => f.endsWith('.scad'));
// Documented in PLAN.md "M0 spike results": bare `each` in a list literal and
// chained `for` clauses in one comprehension.
const KNOWN_GRAMMAR_GAP_FIXTURES = new Set(['comprehensions.scad']);

describe('parseScad (M0 grammar, M2 re-parse)', () => {
  it.each(fixtures.filter((f) => !KNOWN_GRAMMAR_GAP_FIXTURES.has(f)))('parses spikes/fixtures/%s with no errors', async (file) => {
    const { errorCount, tree } = await parseScad(readFileSync(join(SPIKE_FIXTURES_DIR, file), 'utf8'));
    expect(errorCount).toBe(0);
    expect(tree.rootNode.childCount).toBeGreaterThan(0);
  });

  it('counts ERROR and MISSING nodes', async () => {
    expect((await parseScad('cube(;')).errorCount).toBeGreaterThan(0);
    expect((await parseScad('cube(1)')).errorCount).toBeGreaterThan(0); // missing ;
  });

  it('error recovery is local: statements after a bad line still parse', async () => {
    const { tree } = await parseScad('cube(;\nsphere(2);\ncylinder(h=1, r=1);\n');
    expect(tree.rootNode.text).toContain('cylinder');
    const types: string[] = [];
    for (let i = 0; i < tree.rootNode.childCount; i++) types.push(tree.rootNode.child(i)!.type);
    expect(types.filter((t) => t === 'statement').length).toBeGreaterThanOrEqual(2);
  });

  it('reuses one parser across many calls', async () => {
    for (let i = 0; i < 50; i++) expect((await parseScad(`cube(${i});`)).errorCount).toBe(0);
  });

  it.fails('known grammar gap: bare `each` in a list literal', async () => {
    expect((await parseScad('a = [each [1,2,3], each [4,5], 6];')).errorCount).toBe(0);
  });

  it.fails('known grammar gap: chained `for` clauses', async () => {
    expect((await parseScad('a = [for (x=[0:2]) for (y=[0:2]) [x,y]];')).errorCount).toBe(0);
  });
});
