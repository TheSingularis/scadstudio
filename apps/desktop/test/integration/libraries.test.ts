// use <...> / include <...> resolution through the real scad:render handler
// (audit H4), and Save / Save As through scad:saveFile (audit H5). Files are
// laid out in a temp folder, a document is "opened" through the faked open
// dialog, and renders then resolve its imports the way desktop OpenSCAD does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../helpers/audit';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { bbox, parseStl } from '../helpers/stl';
import { collectDependencies, findDependencyPaths, toVirtualPath } from '../../src/main/scadRender';

let main: MainProcessHarness;
let dir: string;
const render = (source: string) => main.invoke('scad:render', source) as Promise<Uint8Array>;

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scadstudio-libs-'));
  main = await loadMainProcess();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('use/include resolution in the app (audit H4)', () => {
  it(audit('H4', 'use <lib.scad> next to the open document renders'), async () => {
    write('proj/lib.scad', 'module part(s) { cube(s); }\n');
    await openDocument('proj/main.scad', 'use <lib.scad>\npart(4);\n');
    const { max } = bbox(parseStl(await render('use <lib.scad>\npart(4);\n')));
    expect(max).toEqual([4, 4, 4]);
  });

  it(audit('H4', 'nested include with a ../ path, relative to the including file'), async () => {
    write('proj2/shared/sizes.scad', 'size = 7;\n');
    write('proj2/lib/parts.scad', 'include <../shared/sizes.scad>\nmodule p() { cube(size); }\n');
    await openDocument('proj2/main.scad', 'use <lib/parts.scad>\np();\n');
    const { max } = bbox(parseStl(await render('use <lib/parts.scad>\np();\n')));
    expect(max).toEqual([7, 7, 7]);
  });

  it('a missing library rejects with OpenSCAD\'s own message', async () => {
    await openDocument('proj3/main.scad', 'use <nope.scad>\ncube(1);\n');
    const err = await render('use <nope.scad>\nnope();\n').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Can't open library 'nope\.scad'/);
    expect((err as Error).message).not.toMatch(/__scadstudio_render__|\/host\//);
  });

  it('ignores use/include inside comments and strings', () => {
    expect(findDependencyPaths('// use <a.scad>\n/* include <b.scad> */\necho("use <c.scad>");\nuse <d.scad>\n')).toEqual(['d.scad']);
  });

  it('falls back to library folders, and survives an include cycle', async () => {
    const files: Record<string, string> = {
      '/doc/a.scad': 'include <b.scad>',
      '/doc/b.scad': 'include <a.scad>\nuse <MCAD/x.scad>',
      '/libs/MCAD/x.scad': 'use <y.scad>',
      '/libs/MCAD/y.scad': '',
    };
    const found = await collectDependencies('include <a.scad>', '/doc', ['/libs'], async (p) => files[p] ?? null);
    expect([...found.keys()].sort()).toEqual(Object.keys(files).sort());
  });

  it('maps Windows paths into the virtual filesystem', () => {
    if (process.platform === 'win32') expect(toVirtualPath('C:\\Users\\me\\lib.scad')).toBe('/host/C/Users/me/lib.scad');
    else expect(toVirtualPath('/home/me/lib.scad')).toBe('/host/home/me/lib.scad');
  });
});

describe('Save / Save As (audit H5)', () => {
  it(audit('H5', 'saving writes the text to the current file'), async () => {
    const target = write('save/existing.scad', 'old');
    const written = await main.invoke('scad:saveFile', { filePath: target, contents: 'cube(2);\n', saveAs: false });
    expect(written).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('cube(2);\n');
  });

  it(audit('H5', 'an untitled document asks for a path and adds .scad'), async () => {
    const chosen = join(dir, 'save', 'fresh');
    main.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosen });
    const written = await main.invoke('scad:saveFile', { filePath: null, contents: 'sphere(1);\n', saveAs: false });
    expect(written).toBe(`${chosen}.scad`);
    expect(readFileSync(`${chosen}.scad`, 'utf8')).toBe('sphere(1);\n');
  });

  it('a cancelled Save As writes nothing and returns null', async () => {
    main.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    const written = await main.invoke('scad:saveFile', { filePath: join(dir, 'save/existing.scad'), contents: 'x', saveAs: true });
    expect(written).toBeNull();
    expect(readFileSync(join(dir, 'save/existing.scad'), 'utf8')).toBe('cube(2);\n');
  });

  it('after Save As, renders resolve use <> against the new folder', async () => {
    write('moved/lib.scad', 'module q() { cube(3); }\n');
    main.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(dir, 'moved/doc.scad') });
    await main.invoke('scad:saveFile', { filePath: null, contents: 'use <lib.scad>\nq();\n', saveAs: true });
    const { max } = bbox(parseStl(await render('use <lib.scad>\nq();\n')));
    expect(max).toEqual([3, 3, 3]);
  });
});
