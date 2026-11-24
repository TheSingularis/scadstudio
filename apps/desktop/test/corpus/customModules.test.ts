// M8 against real libraries: scanning `use <BOSL2/std.scad>` (and MCAD's
// files) the way the app does, then building the Custom tools from them, must
// not throw, and must find (nearly) every top-level module a plain text
// search finds, despite the grammar gaps the corpus baseline records.
// Skipped when the corpus hasn't been fetched (run `npm run corpus:fetch`).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_DIR } from '../helpers/paths';
import { parse } from '../helpers/parse';
import { scanModuleSources } from '../../src/main/moduleSources';
import { buildCustomTools, extractModuleDefsRecovering } from '../../src/renderer/src/moduleIntrospection';
import { parseScadSync } from '../../src/renderer/src/scadParser';

const CORPUS_DIR = join(DESKTOP_DIR, 'test/corpus/.cache');

// Top-level `module name(` at the start of a line: what a person skimming
// the file would count.
function textualModules(source: string): string[] {
  return [...source.matchAll(/^module\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
}

async function toolsFor(useLine: string) {
  const scan = await scanModuleSources(useLine, null, [CORPUS_DIR]);
  const sources = await Promise.all(scan.files.map(async (f) => ({ path: f.path, tree: await parse(f.contents), useDirective: f.useDirective, contents: f.contents })));
  return { scan, sources, tools: buildCustomTools(sources, parseScadSync) };
}

describe.skipIf(!existsSync(join(CORPUS_DIR, 'BOSL2')))('M8 custom modules on real libraries', () => {
  it('use <BOSL2/std.scad> offers BOSL2 modules, all in scope through std.scad includes', async () => {
    const { scan, sources, tools } = await toolsFor('use <BOSL2/std.scad>\n');
    expect(scan.files.length).toBeGreaterThan(10);
    const names = new Set(tools.map((t) => t.label));
    for (const expected of ['cuboid', 'cyl', 'xcopies', 'zrot']) expect(names).toContain(expected);
    expect(tools.every((t) => !t.label.startsWith('_'))).toBe(true);
    // Recall against a text search, per file, so a grammar gap that hides
    // modules shows up here.
    let textual = 0;
    let found = 0;
    for (const s of sources) {
      const text = textualModules(s.contents);
      const parsed = new Set(extractModuleDefsRecovering(s.tree, s.contents, s.path, parseScadSync).map((d) => d.name));
      textual += text.length;
      found += text.filter((n) => parsed.has(n)).length;
    }
    console.log(`BOSL2 via std.scad: ${scan.files.length} files, ${tools.length} tools, ${found}/${textual} textual modules parsed`);
    expect(found / textual).toBeGreaterThan(0.95);
  });

  it('every MCAD file can be used without throwing', async () => {
    const dir = join(CORPUS_DIR, 'MCAD');
    const files = readdirSync(dir).filter((f) => f.endsWith('.scad'));
    let tools = 0;
    for (const f of files) tools += (await toolsFor(`use <MCAD/${f}>\n`)).tools.length;
    console.log(`MCAD: ${files.length} files, ${tools} tools`);
    expect(tools).toBeGreaterThan(20);
  });
});
