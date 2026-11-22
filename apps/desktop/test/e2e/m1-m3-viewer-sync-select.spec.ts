// M1 static viewer, M2 live text → visual sync, M3 click-to-select.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, SPIKE_FIXTURES_DIR } from './fixtures';

test.describe('M1 static viewer', () => {
  test('launches and renders the default scene without errors', async ({ scad }) => {
    expect(await scad.status()).toBe('Rendered');
    expect(await scad.source()).toContain('module bracket');
    expect(scad.pageErrors).toEqual([]);
    expect(scad.consoleLines.filter((l) => /Uncaught|render failed/.test(l))).toEqual([]);
    const shot = await scad.viewportShot();
    expect(shot.length).toBeGreaterThan(10_000); // a blank canvas compresses to almost nothing
  });

  test('opens a .scad file from the Open dialog', async ({ scad }) => {
    const file = join(SPIKE_FIXTURES_DIR, 'basics.scad');
    await scad.stubDialogs({ open: file });
    const status = await scad.rendersAfter(() => scad.button('Open .scad file...').click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toBe(readFileSync(file, 'utf8'));
    await expect(scad.page.getByText(file)).toBeVisible();
  });

  test('orbiting the camera changes the view', async ({ scad }) => {
    const before = await scad.viewportShot();
    await scad.dragViewport({ dx: -200, dy: 200 }, { dx: -80, dy: 200 });
    await scad.page.waitForTimeout(300);
    expect((await scad.viewportShot()).equals(before)).toBe(false);
  });
});

test.describe('M2 live sync', () => {
  test('typing in the editor re-renders after the debounce', async ({ scad }) => {
    await scad.load('cube(10);\n');
    const status = await scad.rendersAfter(() => scad.typeAtEnd('translate([20, 0, 0]) sphere(r=4);\n'));
    expect(status).toBe('Rendered');
    await scad.clickEditorLine(2);
    expect(await scad.selectedCall()).toBe('sphere');
  });

  test('a syntax error is reported and the rest of the file still renders', async ({ scad }) => {
    await scad.load('cube(10);\n');
    const broken = await scad.rendersAfter(() => scad.typeAtEnd('sphere(;\n'));
    // The good cube still renders; only the broken statement is missing.
    expect(broken).toMatch(/parse error\(s\) — Rendered 1\/2 nodes/);
    await scad.load('cube(10);\nsphere(4);\n', { fit: false });
    expect(await scad.status()).toBe('Rendered');
  });
});

test.describe('M3 click-to-select', () => {
  test('clicking a mesh selects it and highlights its source', async ({ scad }) => {
    await scad.load('cube(10, center=true);\n');
    expect(await scad.selectedCall()).toBeNull();
    await scad.clickViewport();
    expect(await scad.selectedCall()).toBe('cube');
    await expect(scad.page.locator('.scad-selected-node').first()).toBeVisible();
  });

  test('clicking empty space clears the selection', async ({ scad }) => {
    await scad.load('cube(4, center=true);\n');
    await scad.clickViewport();
    expect(await scad.selectedCall()).toBe('cube');
    const v = await scad.viewport();
    await scad.clickViewport(-v.width / 2 + 20, v.height / 2 - 20);
    expect(await scad.selectedCall()).toBeNull();
  });

  test('moving the editor caret selects the node under it', async ({ scad }) => {
    await scad.load('cube(10);\ntranslate([20, 0, 0]) sphere(r=4);\ncylinder(h=5, r=2);\n');
    await scad.clickEditorLine(2);
    expect(await scad.selectedCall()).toBe('sphere');
    await scad.clickEditorLine(3);
    expect(await scad.selectedCall()).toBe('cylinder');
  });
});
