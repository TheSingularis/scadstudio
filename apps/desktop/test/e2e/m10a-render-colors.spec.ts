// M10a (Jordan, 2026-11-26, opening the gag trophy): the old model stayed up
// for the whole render with only a small "Rendering..." in the top bar, and
// everything came out in the default blue. Now: the model's own colors, a
// grey-out plus a progress overlay with elapsed time and Cancel while a
// render runs, and opening a file clears the previous one at once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, DESKTOP_DIR, type ScadApp } from './fixtures';
import { decodePng } from './png';

const TROPHY = join(DESKTOP_DIR, 'test/fixtures/gag_trophy1.scad');

/** Viewport pixels matching `match`. */
async function countPixels(scad: ScadApp, match: (r: number, g: number, b: number) => boolean): Promise<number> {
  const img = decodePng(await scad.viewportShot());
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (match(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  return n;
}

// Goldenrod-ish (yellow-orange, lit or shaded), deep red, and the app's
// default blue.
const isGold = (r: number, g: number, b: number) => r > 120 && g > 80 && b < 60 && r - g > 25 && g - b > 50;
const isRed = (r: number, g: number, b: number) => r > 110 && g < 70 && b < 70;
const isBlue = (r: number, g: number, b: number) => b > 120 && b - r > 60 && b - g > 20;

const progress = (scad: ScadApp) => scad.page.getByTestId('render-progress');

test.describe('M10a render feedback and real colors', () => {
  test('parts show the colors their source gives them, inside modules and booleans too', async ({ scad }) => {
    expect(
      await scad.load(`module trim() { color("goldenrod") cube(10); }
trim();
translate([-16, 0, 0]) color([0.7, 0.1, 0.1]) cube(8);
translate([0, 16, 0]) difference() { color("goldenrod") cube(10); color("red") translate([5, 5, 5]) cube(10); }`),
    ).toBe('Rendered');
    await scad.resetView();
    expect(await countPixels(scad, isGold)).toBeGreaterThan(2000);
    expect(await countPixels(scad, isRed)).toBeGreaterThan(500);
    // Nothing here is uncolored, so no default blue.
    expect(await countPixels(scad, isBlue)).toBeLessThan(50);
    expect(scad.pageErrors).toEqual([]);
  });

  test('an uncolored part still draws in the default blue, and selecting it draws it in the selection color', async ({ scad }) => {
    expect(await scad.load('cube(10);')).toBe('Rendered');
    await scad.resetView();
    expect(await countPixels(scad, isBlue)).toBeGreaterThan(2000);
    await scad.clickViewport();
    await expect.poll(() => scad.selectedCall()).toBe('cube');
    await expect.poll(() => countPixels(scad, isBlue)).toBeLessThan(200);
  });

  test('a long render shows progress over a greyed-out model, and Cancel keeps the last finished render', async ({ scad }) => {
    test.setTimeout(240_000);
    expect(await scad.load('color("goldenrod") cube(10);')).toBe('Rendered');
    await scad.resetView();
    const goldBefore = await countPixels(scad, isGold);
    expect(goldBefore).toBeGreaterThan(2000);

    const heavy = readFileSync(TROPHY, 'utf8');
    await scad.page.evaluate((s) => (window as unknown as { __testSetSource(v: string): void }).__testSetSource(s), heavy);
    await expect(progress(scad)).toBeVisible({ timeout: 10_000 });
    await expect(scad.page.getByTestId('render-stage')).toHaveText(/OpenSCAD is building the geometry/, { timeout: 20_000 });
    const elapsed = async () => {
      const [m, s] = ((await scad.page.getByTestId('render-elapsed').textContent()) ?? '0:00').split(':').map(Number);
      return m * 60 + s;
    };
    await expect.poll(elapsed, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    // The old model is still there, greyed out (no longer gold).
    expect(await countPixels(scad, isGold)).toBeLessThan(goldBefore / 4);

    await progress(scad).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => scad.status()).toBe('Render cancelled');
    await expect(progress(scad)).toBeHidden();
    // The last finished render is back in its own colors.
    await expect.poll(() => countPixels(scad, isGold)).toBeGreaterThan(goldBefore * 0.8);

    // And the engine works again straight after.
    expect(await scad.load('cube(5);')).toBe('Rendered');
    expect(scad.pageErrors).toEqual([]);
  });

  test('opening another file clears the previous model at once and stops its render', async ({ scad }) => {
    test.setTimeout(240_000);
    expect(await scad.load('cube(10);')).toBe('Rendered');
    await scad.resetView();
    expect(await countPixels(scad, isBlue)).toBeGreaterThan(2000);

    await scad.stubDialogs({ open: TROPHY });
    // The edited example asks whether to save first: don't.
    await scad.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
    await scad.button('Open .scad file...').click();
    await expect(scad.page.getByText('gag_trophy1.scad')).toBeVisible();
    // The cube is gone right away, not shown under the trophy's name.
    await expect.poll(() => countPixels(scad, isBlue), { timeout: 3000 }).toBeLessThan(50);
    await expect(progress(scad)).toBeVisible({ timeout: 10_000 });

    // Opening the next file doesn't wait for the trophy to finish.
    const t0 = Date.now();
    await scad.stubDialogs({ open: join(DESKTOP_DIR, 'test/fixtures/rack_mount_single_keystone.scad') });
    await scad.button('Open .scad file...').click();
    await expect.poll(() => scad.status(), { timeout: 60_000 }).toMatch(/^Rendered/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    await expect(scad.page.getByText('rack_mount_single_keystone.scad')).toBeVisible();
    expect(scad.pageErrors).toEqual([]);
  });
});
