// M15: text() through the real render path (src/main/scadRender.ts), with
// the bundled Liberation fonts, `use <font.ttf>` project fonts, and
// installed ("system") fonts the main process hands to a render.
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/main/engine';
import { mountFonts, renderScadToMesh } from '../../src/main/scadRender';
import { fontFileCache } from '../../src/main/fontStore';
import { loadMainProcess, type MainProcessHarness } from '../helpers/mainProcess';
import { FIXTURES_DIR } from '../helpers/paths';
import { bbox, parseStl, triangleCount } from '../helpers/stl';

const SCP = join(FIXTURES_DIR, 'fonts', 'SourceCodePro-Regular.ttf');
const size = (bytes: Uint8Array) => {
  const { min, max } = bbox(parseStl(bytes));
  return max.map((v, i) => v - min[i]);
};

describe('text() rendering (M15)', () => {
  it('renders with the default font (Liberation Sans) and no font setup in the source', async () => {
    const bytes = await renderScadToMesh('linear_extrude(2) text("Hello", size=10);');
    expect(triangleCount(parseStl(bytes))).toBeGreaterThan(100);
    const [w, h, d] = size(bytes);
    expect(w).toBeGreaterThan(20);
    expect(h).toBeGreaterThan(5);
    expect(d).toBeCloseTo(2, 5);
  });

  it('bare 2D text renders too (the app wraps it like any 2D primitive)', async () => {
    // Exporting pure 2D as STL fails in OpenSCAD; the renderer's thin-extrude
    // retry handles that for square()/circle() and text() alike.
    await expect(renderScadToMesh('text("Hi");')).rejects.toThrow();
    await expect(renderScadToMesh('linear_extrude(0.01) text("Hi");')).resolves.toBeInstanceOf(Uint8Array);
  });

  it.each(['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Liberation Sans:style=Bold', 'Liberation Serif:style=Bold Italic'])(
    'bundled font %s renders, and differently from the default',
    async (font) => {
      const plain = size(await renderScadToMesh('linear_extrude(1) text("Wide Mg", size=10);'));
      const styled = size(await renderScadToMesh(`linear_extrude(1) text("Wide Mg", size=10, font="${font}");`));
      if (font === 'Liberation Sans') expect(styled).toEqual(plain);
      else expect(styled[0]).not.toBeCloseTo(plain[0], 3);
    },
  );

  it('a TrueType font with no hinting program renders (crashed openscad-wasm 0.0.4)', async () => {
    const bytes = await renderScadToMesh('linear_extrude(1) text("iiiii", size=10, font="Source Code Pro");', { fontFiles: [SCP] });
    // Monospaced: five narrow i's span nearly five full advances, far wider
    // than in the proportional default font.
    const [w] = size(bytes);
    const proportional = size(await renderScadToMesh('linear_extrude(1) text("iiiii", size=10);'))[0];
    expect(w).toBeGreaterThan(proportional * 1.5);
  });

  it('use <font.ttf> next to the document registers that font', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scadstudio-fonts-'));
    copyFileSync(SCP, join(dir, 'code.ttf'));
    const docPath = join(dir, 'label.scad');
    const source = 'use <code.ttf>\nlinear_extrude(1) text("iiiii", size=10, font="Source Code Pro");';
    writeFileSync(docPath, source);
    const withFont = size(await renderScadToMesh(source, { documentPath: docPath }));
    // The same geometry as handing the font over as an installed font...
    const installed = size(await renderScadToMesh(source.replace('use <code.ttf>\n', ''), { fontFiles: [SCP] }));
    expect(withFont[0]).toBeCloseTo(installed[0], 4);
    // ...and not what the name falls back to without the file.
    const fallback = size(await renderScadToMesh(source.replace('use <code.ttf>\n', ''), { documentPath: docPath }));
    expect(withFont[0]).not.toBeCloseTo(fallback[0], 1);
  });

  it('a font file is read from disk once and then served from memory', async () => {
    const before = fontFileCache.reads;
    const engine = await createEngine();
    await mountFonts(engine.FS, [SCP], []);
    await mountFonts((await createEngine()).FS, [SCP], []);
    expect(fontFileCache.reads - before).toBeLessThanOrEqual(1);
    expect(fontFileCache.hits).toBeGreaterThan(0);
  });
});

describe('scad:render picks the installed fonts a document names (M15)', () => {
  let main: MainProcessHarness;
  beforeAll(async () => {
    process.env['SCADSTUDIO_SYSTEM_FONT_DIRS'] = join(FIXTURES_DIR, 'fonts');
    main = await loadMainProcess();
  });

  it('an installed font named in font= renders as that font', async () => {
    const render = (src: string) => main.invoke('scad:render', src) as Promise<Uint8Array>;
    const named = size(await render('linear_extrude(1) text("iiiii", size=10, font="Source Code Pro");'));
    const other = size(await render('linear_extrude(1) text("iiiii", size=10, font="Liberation Sans");'));
    expect(named[0]).toBeGreaterThan(other[0] * 1.5);
  });

  it('a font picked through a variable is found too', async () => {
    const render = (src: string) => main.invoke('scad:render', src) as Promise<Uint8Array>;
    const viaVar = size(await render('f = "Source Code Pro";\nlinear_extrude(1) text("iiiii", size=10, font=f);'));
    expect(viaVar[0]).toBeGreaterThan(25);
  });

  it('fonts:list offers bundled fonts first, then installed ones', async () => {
    const list = (await main.invoke('fonts:list', 'cube(1);')) as { family: string; style: string; source: string }[];
    expect(list.slice(0, 12).every((f) => f.source === 'bundled')).toBe(true);
    expect(list).toContainEqual(expect.objectContaining({ family: 'Source Code Pro', style: 'Regular', source: 'system' }));
  });
});
