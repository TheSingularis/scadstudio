// M8: which library files supply Custom tools (real files on disk, the real
// scad:scanModules handler and its chokidar watcher), and that the scoping
// rules it encodes are the engine's: checked by rendering through the real
// scad:render handler.
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { bbox, parseStl } from '../helpers/stl';
import { directiveFor, scanModuleSources } from '../../src/main/moduleSources';

let main: MainProcessHarness;
let dir: string;

function write(rel: string, text: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  return full;
}

async function openDocument(rel: string, text: string): Promise<void> {
  const full = write(rel, text);
  main.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [full] });
  await main.invoke('scad:openFile');
}

type Scanned = { path: string; useDirective: string | null }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scadstudio-m8-'));
  main = await loadMainProcess();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('M8 module source scan', () => {
  it('direct uses and their includes are in scope; nested uses need a directive; document includes are skipped', async () => {
    const parts = write('p/lib/parts.scad', 'include <sizes.scad>\nuse <../extra/deep.scad>\nmodule part() {}\n');
    const sizes = write('p/lib/sizes.scad', 'module sized() {}\n');
    const deep = write('p/extra/deep.scad', 'module deep() {}\n');
    write('p/inc.scad', 'module included() {}\n');
    const scan = await scanModuleSources('use <lib/parts.scad>\ninclude <inc.scad>\n', join(dir, 'p'), []);
    expect(scan.files.map((f) => [f.path, f.useDirective])).toEqual([
      [parts, null],
      [sizes, null],
      [deep, 'extra/deep.scad'],
    ]);
  });

  it('a file reachable both directly and through a nested use counts as in scope', async () => {
    const a = write('q/a.scad', 'use <b.scad>\nmodule a() {}\n');
    const b = write('q/b.scad', 'module b() {}\n');
    const scan = await scanModuleSources('use <a.scad>\nuse <b.scad>\n', join(dir, 'q'), []);
    expect(scan.files.map((f) => [f.path, f.useDirective])).toEqual([
      [a, null],
      [b, null],
    ]);
  });

  it('cycles terminate, and missing files are still watched', async () => {
    write('r/x.scad', 'use <y.scad>\n');
    write('r/y.scad', 'use <x.scad>\n');
    const scan = await scanModuleSources('use <x.scad>\nuse <nope.scad>\n', join(dir, 'r'), []);
    expect(scan.files).toHaveLength(2);
    expect(scan.watchPaths).toContain(join(dir, 'r/nope.scad'));
  });

  it('directives prefer a library folder, then the document folder', () => {
    expect(directiveFor('/libs/BOSL2/std.scad', '/home/me/proj', ['/libs'])).toBe('BOSL2/std.scad');
    expect(directiveFor('/home/me/shared/a.scad', '/home/me/proj', ['/libs'])).toBe('../shared/a.scad');
    expect(directiveFor('/home/me/shared/a.scad', null, [])).toBe('/home/me/shared/a.scad');
  });
});

describe('M8 scoping matches the engine', () => {
  it('a nested use is not callable; adding the directive the scan reports makes it callable', async () => {
    write('s/lib/a.scad', 'use <b.scad>\nmodule outer() { inner(); }\n');
    write('s/lib/b.scad', 'module inner() { cube(3); }\n');
    await openDocument('s/main.scad', 'use <lib/a.scad>\n');
    const scanned = (await main.invoke('scad:scanModules', 'use <lib/a.scad>\n')) as Scanned;
    const nested = scanned.find((f) => f.path.endsWith('b.scad'))!;
    expect(nested.useDirective).toBe('lib/b.scad');
    await expect(main.invoke('scad:render', 'use <lib/a.scad>\ninner();\n')).rejects.toThrow(/unknown module 'inner'|empty/i);
    const stl = (await main.invoke('scad:render', `use <lib/a.scad>\nuse <${nested.useDirective}>\ninner();\n`)) as Uint8Array;
    expect(bbox(parseStl(stl)).max).toEqual([3, 3, 3]);
  });

  it('a module from a file the used file includes is callable through the use', async () => {
    write('t/lib/a.scad', 'include <c.scad>\n');
    write('t/lib/c.scad', 'module fromc() { cube(2); }\n');
    await openDocument('t/main.scad', 'use <lib/a.scad>\n');
    const stl = (await main.invoke('scad:render', 'use <lib/a.scad>\nfromc();\n')) as Uint8Array;
    expect(bbox(parseStl(stl)).max).toEqual([2, 2, 2]);
  });
});

describe('M11 included variables', () => {
  it('lists included files (nested includes too, not uses), and the engine agrees on what the document sees', async () => {
    const sizes = write('v/sizes.scad', 'side = 4;\ninclude <more.scad>\nuse <tools.scad>\n');
    const more = write('v/more.scad', 'tall = 6;\n');
    write('v/tools.scad', 'hidden_var = 9;\nmodule tool() {}\n');
    write('v/used.scad', 'used_var = 5;\n');
    await openDocument('v/main.scad', 'include <sizes.scad>\n');
    const files = (await main.invoke('scad:scanIncludes', 'include <sizes.scad>\nuse <used.scad>\ncube([side, side, tall]);\n')) as { path: string; via: string }[];
    expect(files.map((f) => [f.path, f.via])).toEqual([
      [sizes, 'sizes.scad'],
      [more, 'sizes.scad'],
    ]);
    // Included variables, nested ones too, are visible to the document...
    const stl = (await main.invoke('scad:render', 'include <sizes.scad>\ncube([side, side, tall]);\n')) as Uint8Array;
    expect(bbox(parseStl(stl)).max).toEqual([4, 4, 6]);
    // ...a used file's are not: used_var is undef there, and cube(undef)
    // falls back to the default 1 mm cube instead of 5.
    const used = (await main.invoke('scad:render', 'use <used.scad>\ncube(used_var);\n')) as Uint8Array;
    expect(bbox(parseStl(used)).max).toEqual([1, 1, 1]);
  });
});

describe('M8 library watching', () => {
  async function waitForSend(channel: string, since: number, timeout = 8000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (main.sent.slice(since).includes(channel)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('editing, creating or deleting a scanned library tells the renderer', async () => {
    const lib = write('w/lib.scad', 'module one() {}\n');
    await openDocument('w/main.scad', 'use <lib.scad>\nuse <later.scad>\n');
    await main.invoke('scad:scanModules', 'use <lib.scad>\nuse <later.scad>\n');
    await new Promise((r) => setTimeout(r, 300)); // watcher ready

    let mark = main.sent.length;
    writeFileSync(lib, 'module one() {}\nmodule two() {}\n');
    expect(await waitForSend('modules:changed', mark)).toBe(true);

    mark = main.sent.length;
    write('w/later.scad', 'module three() {}\n');
    expect(await waitForSend('modules:changed', mark)).toBe(true);

    mark = main.sent.length;
    unlinkSync(lib);
    expect(await waitForSend('modules:changed', mark)).toBe(true);
  });

  it('a file no longer used stops being watched', async () => {
    const old = write('v/old.scad', 'module o() {}\n');
    await openDocument('v/main.scad', 'use <old.scad>\n');
    await main.invoke('scad:scanModules', 'use <old.scad>\n');
    await main.invoke('scad:scanModules', 'cube(1);\n');
    await new Promise((r) => setTimeout(r, 300));
    const mark = main.sent.length;
    writeFileSync(old, 'module o2() {}\n');
    expect(await waitForSend('modules:changed', mark, 1500)).toBe(false);
  });
});
