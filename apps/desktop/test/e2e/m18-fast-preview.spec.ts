// M18 (Jordan, 2026-11-27): "a quick not 100% accurate re-render when
// refreshing for small changes, then a full real one on demand". Slow parts
// render as a preview with coarser curves; Render (F6) draws them in full.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, DESKTOP_DIR } from './fixtures';

const TROPHY = join(DESKTOP_DIR, 'test/fixtures/gag_trophy1.scad');

interface Stats {
  engineCalls: number;
  previewMeshes: number;
}
const stats = (scad: { page: import('@playwright/test').Page }) =>
  scad.page.evaluate(() => (window as unknown as { __scadstudioRenderStats: Stats }).__scadstudioRenderStats);

test.describe('M18 fast preview and full render', () => {
  test('a small model renders in full and says so', async ({ scad }) => {
    // $fn = 64 is finer than the cap, but the part is fast: it ends in full.
    expect(await scad.load('sphere(r=10, $fn=64);\ntranslate([25, 0, 0]) cube(10);')).toBe('Rendered');
    await expect.poll(() => scad.renderDetail()).toBe('full');
    await expect(scad.button('Render')).toBeHidden();
    expect((await stats(scad)).previewMeshes).toBe(0);
    expect(scad.pageErrors).toEqual([]);
  });

  test('Always shows a preview with a Render button; Render and F6 draw it in full', async ({ scad }) => {
    await scad.setQuickPreview('always');
    expect(await scad.load('sphere(r=10, $fn=64);\ntranslate([25, 0, 0]) cube(10);')).toBe('Rendered (preview)');
    await expect.poll(() => scad.renderDetail()).toBe('preview');
    // Only the sphere has curves to lower.
    await expect(scad.page.getByTestId('render-detail')).toContainText('Preview · 1 of 2');
    expect((await stats(scad)).previewMeshes).toBe(1);

    expect(await scad.rendersAfter(() => scad.button('Render').click())).toBe('Rendered');
    await expect.poll(() => scad.renderDetail()).toBe('full');

    // An edit goes back to the preview; F6 renders in full again.
    expect(await scad.load('sphere(r=12, $fn=64);\ntranslate([25, 0, 0]) cube(10);')).toBe('Rendered (preview)');
    // F6 works with the code editor focused too.
    await scad.clickEditorLine(1);
    expect(await scad.rendersAfter(() => scad.page.keyboard.press('F6'))).toBe('Rendered');
    await expect.poll(() => scad.renderDetail()).toBe('full');
    expect(scad.pageErrors).toEqual([]);
  });

  test('the gag trophy opens as a quick preview, Render draws it in full, and an edit is quick again', async ({ scad }) => {
    test.setTimeout(420_000);
    const heavy = readFileSync(TROPHY, 'utf8');
    const t0 = Date.now();
    expect(await scad.load(heavy, { fit: false })).toBe('Rendered (preview)');
    const previewSeconds = (Date.now() - t0) / 1000;
    await expect.poll(() => scad.renderDetail()).toBe('preview');
    await scad.resetView();
    const preview = await scad.viewportShot();
    expect(preview.byteLength).toBeGreaterThan(0);

    const t1 = Date.now();
    expect(await scad.rendersAfter(() => scad.button('Render').click(), 400_000)).toBe('Rendered');
    const fullSeconds = (Date.now() - t1) / 1000;
    await expect.poll(() => scad.renderDetail()).toBe('full');
    // Measured 2026-11-27 in the cloud: about 4 s against 32 s.
    expect(previewSeconds * 2).toBeLessThan(fullSeconds);

    // Measured slow (over 2 s) at full detail: an edit renders as a preview.
    const before = await stats(scad);
    expect(await scad.load(heavy.replace('line1_y = 4.2;', 'line1_y = 4.4;'), { fit: false })).toBe('Rendered (preview)');
    const after = await stats(scad);
    // One engine call: no extra full render behind it.
    expect(after.engineCalls - before.engineCalls).toBe(1);
    expect(scad.pageErrors).toEqual([]);
  });

  test('Off renders everything in full', async ({ scad }) => {
    await scad.setQuickPreview('off');
    expect(await scad.load('sphere(r=10, $fn=200);')).toBe('Rendered');
    await expect.poll(() => scad.renderDetail()).toBe('full');
  });
});
