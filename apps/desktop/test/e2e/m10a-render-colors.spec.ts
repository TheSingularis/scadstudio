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

/**
 * Viewport pixels matching `match`. `skipBottom` leaves out that many rows
 * at the bottom, where the progress overlay (with its blue bar) sits.
 */
async function countPixels(scad: ScadApp, match: (r: number, g: number, b: number) => boolean, skipBottom = 0): Promise<number> {
  const img = decodePng(await scad.viewportShot());
  const end = (img.height - skipBottom) * img.width * 4;
  let n = 0;
  for (let i = 0; i < end; i += 4) if (match(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  return n;
}
const OVERLAY_ROWS = 160;

// Goldenrod-ish (yellow-orange, lit or shaded), deep red, and the app's
// default blue.
const isGold = (r: number, g: number, b: number) => r > 120 && g > 80 && b < 60 && r - g > 25 && g - b > 50;
const isRed = (r: number, g: number, b: number) => r > 110 && g < 70 && b < 70;
const isBlue = (r: number, g: number, b: number) => b > 120 && b - r > 60 && b - g > 20;

// Amber (selection color) pixels: how many, and their centroid as a
// fraction of the viewport (0.5, 0.5 is the center).
async function amberSpot(scad: ScadApp): Promise<{ n: number; fx: number; fy: number; frac: number; w: number; h: number; leftY: number; rightY: number }> {
  const img = decodePng(await scad.viewportShot());
  let n = 0;
  let sx = 0;
  let sy = 0;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (r > 150 && g > 90 && g < 200 && b < 110 && r - b > 90) {
        n++;
        sx += x;
        sy += y;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return {
    n,
    fx: n ? sx / n / img.width : NaN,
    fy: n ? sy / n / img.height : NaN,
    frac: n / (img.width * img.height),
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    ...halves(),
  };
  // Mean row of the spot's left and right halves.
  function halves(): { leftY: number; rightY: number } {
    const mid = (x0 + x1) / 2;
    let [ln, ly, rn, ry] = [0, 0, 0, 0];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * img.width + x) * 4;
        const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (!(r > 150 && g > 90 && g < 200 && b < 110 && r - b > 90)) continue;
        if (x < mid) {
          ln++;
          ly += y;
        } else {
          rn++;
          ry += y;
        }
      }
    }
    return { leftY: ln ? ly / ln : NaN, rightY: rn ? ry / rn : NaN };
  }
}

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
    // Nothing here is uncolored, so no default blue (CI's software GL shows
    // a few dozen blue-ish pixels elsewhere in the scene; a blue part is
    // thousands).
    expect(await countPixels(scad, isBlue)).toBeLessThan(300);
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

  test('dragging the gizmo keeps a named color as written', async ({ scad }) => {
    // Jordan, 2026-11-27: a drag turned color("goldenrod") into numbers.
    expect(await scad.load('color("goldenrod") cube(10);\ntranslate([20, 0, 0]) color("#336699", 0.5) cube(8);\n')).toBe('Rendered');
    await scad.resetView();
    for (const line of [1, 2]) {
      await scad.clickEditorLine(line);
      await expect.poll(() => scad.selectedCall()).toBe('cube');
      const handle = await scad.axisHandle('x');
      expect(handle.count).toBeGreaterThan(20);
      const len = Math.hypot(handle.dx, handle.dy);
      const before = await scad.source();
      await scad.rendersAfter(() => scad.dragViewport(handle, { dx: handle.dx + (handle.dx / len) * 60, dy: handle.dy + (handle.dy / len) * 60 }));
      const after = await scad.source();
      expect(after).not.toBe(before);
      expect(after).toContain('color("goldenrod")');
      expect(after).toContain('color("#336699", 0.5)');
    }
    expect(scad.pageErrors).toEqual([]);
  });

  test('leaving sketch mode returns to the earlier view, and frames a new shape instead of resetting', async ({ scad }) => {
    // Jordan, 2026-11-27: placing sketch Text reset the whole camera
    // instead of showing the new text.
    expect(await scad.load('cube([200, 20, 10]);\n')).toBe('Rendered');
    await scad.resetView();
    // Orbit away from the default view (a drag on empty space).
    await scad.dragViewport({ dx: -200, dy: 220 }, { dx: -130, dy: 220 });
    await scad.page.waitForTimeout(2000); // orbit damping settles
    const away = { x: 5, y: 5 }; // keep the pointer off the model (hover lightens it)
    const v = await scad.viewport();
    await scad.page.mouse.move(v.x + away.x, v.y + away.y);
    const before = decodePng(await scad.viewportShot());

    // Exit Sketch with nothing drawn: back to the same view.
    await scad.button('XY').click();
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
    await scad.page.waitForTimeout(1500);
    await scad.button('Exit Sketch').click();
    await scad.page.waitForTimeout(1500);
    await scad.page.mouse.move(v.x + away.x, v.y + away.y);
    const back = decodePng(await scad.viewportShot());
    let differ = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      if (Math.abs(before.data[i] - back.data[i]) + Math.abs(before.data[i + 1] - back.data[i + 1]) + Math.abs(before.data[i + 2] - back.data[i + 2]) > 60) differ++;
    }
    expect(differ, 'pixels that changed after Exit Sketch').toBeLessThan(before.data.length / 4 / 100);

    // Text placed off to one side: once rendered, the view centers on it.
    await scad.button('XY').click();
    await scad.page.waitForTimeout(1500);
    await scad.page.getByRole('group', { name: 'Sketch tools' }).getByRole('button', { name: 'Text' }).click();
    expect(await scad.rendersAfter(() => scad.clickViewport(-180, 120))).toBe('Rendered');
    expect(await scad.selectedCall()).toBe('text');
    await scad.page.waitForTimeout(1500);
    await scad.page.mouse.move(v.x + away.x, v.y + away.y);
    const spot = await amberSpot(scad);
    // The (selected, amber) text fills a good part of the view, centered.
    expect(spot.frac).toBeGreaterThan(0.015);
    expect(Math.abs(spot.fx - 0.5)).toBeLessThan(0.12);
    expect(Math.abs(spot.fy - 0.5)).toBeLessThan(0.12);
    expect(scad.pageErrors).toEqual([]);
  });

  test('Focus (button or F) frames the selected part, keeping the view angle', async ({ scad }) => {
    // Jordan, 2026-11-27: "click a component then press a button like F to
    // focus the camera view on that part", like Unity's editor.
    expect(await scad.load('cube([200, 20, 10]);\ntranslate([150, 120, 0]) sphere(5);\n')).toBe('Rendered');
    await scad.resetView();
    const v = await scad.viewport();
    const away = async () => scad.page.mouse.move(v.x + 5, v.y + 5);
    await scad.clickEditorLine(2);
    await expect.poll(() => scad.selectedCall()).toBe('sphere');
    await away();
    const small = await amberSpot(scad);
    expect(small.frac).toBeLessThan(0.01);

    await scad.button('Focus').click();
    await scad.page.waitForTimeout(1500);
    await away();
    const framed = await amberSpot(scad);
    expect(framed.frac).toBeGreaterThan(0.05);
    expect(Math.abs(framed.fx - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(framed.fy - 0.5)).toBeLessThan(0.08);

    // F does the same, on the cube now (clicked in the view, so the editor
    // doesn't have the keyboard).
    await scad.resetView();
    await scad.clickEditorLine(1);
    await expect.poll(() => scad.selectedCall()).toBe('cube');
    await scad.button('Reset View').focus();
    await scad.page.keyboard.press('f');
    await scad.page.waitForTimeout(1500);
    await away();
    const cube = await amberSpot(scad);
    expect(Math.abs(cube.fx - 0.5)).toBeLessThan(0.1);
    expect(Math.abs(cube.fy - 0.5)).toBeLessThan(0.1);
    // The key only moved the camera.
    expect(await scad.source()).toBe('cube([200, 20, 10]);\ntranslate([150, 120, 0]) sphere(5);\n');
    expect(scad.pageErrors).toEqual([]);
  });

  test('Focus on text turns the camera to face it, square and level', async ({ scad }) => {
    // Jordan, 2026-11-27: text has an implied up, so Focus should line the
    // camera up with it. This text stands up (rotate 90 about X) and is
    // turned 30 degrees, so from the default view it reads at a slant.
    expect(await scad.load('cube(10);\ntranslate([40, 0, 0]) rotate([90, 0, 30]) linear_extrude(1) text("HIIIII", size = 10);\n')).toBe('Rendered');
    await scad.resetView();
    const v = await scad.viewport();
    await scad.clickEditorLine(2);
    await expect.poll(() => scad.selectedCall()).toBe('linear_extrude');
    await scad.button('Focus').click();
    await scad.page.waitForTimeout(1500);
    await scad.page.mouse.move(v.x + 5, v.y + 5);
    const spot = await amberSpot(scad);
    expect(Math.abs(spot.fx - 0.5)).toBeLessThan(0.08);
    expect(Math.abs(spot.fy - 0.5)).toBeLessThan(0.08);
    // Level: the left and right halves of the text sit at the same height
    // (from the default view this line of text climbs to the right).
    expect(Math.abs(spot.leftY - spot.rightY)).toBeLessThan(0.1 * spot.h);
    expect(spot.w / spot.h).toBeGreaterThan(2);
    expect(scad.pageErrors).toEqual([]);
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
    await expect.poll(() => countPixels(scad, isBlue, OVERLAY_ROWS), { timeout: 3000 }).toBeLessThan(300);
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
