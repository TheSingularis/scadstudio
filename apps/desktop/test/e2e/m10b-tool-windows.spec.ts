// M10b floating tool windows: the Properties window, one tool window at a
// time, dragging and remembering, the folded toolbar, the shading menu in
// the top bar, grid snap off by default (and remembered), Extrude off for 3D.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type ScadApp } from './fixtures';

// Screenshots for the PR / Jordan, when asked for (SCADSTUDIO_SHOTS=dir).
const SHOTS = process.env['SCADSTUDIO_SHOTS'];
async function shot(scad: ScadApp, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await scad.page.waitForTimeout(400);
  await scad.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const PARTS = 'cube([10, 10, 10]);\ntranslate([20, 0, 0]) sphere(r=6, $fn=32);\ntranslate([0, 25, 0]) square([8, 4]);\n';

async function windowBox(scad: ScadApp, testId: string) {
  const box = await scad.page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} not visible`);
  return box;
}

test.describe('M10b floating tool windows', () => {
  test('selecting a part opens its Properties window over the viewport; nothing selected closes it', async ({ scad }) => {
    await scad.load(PARTS);
    await expect(scad.propertiesWindow()).toBeHidden();
    await scad.clickEditorLine(2);
    const props = scad.propertiesWindow();
    await expect(props).toBeVisible();
    await expect(props.getByTestId('window-title-bar')).toContainText('sphere');
    await expect(props.getByRole('region', { name: 'Parameters' })).toContainText('r:');
    await expect(props.getByRole('region', { name: 'Placement' })).toBeVisible();
    await expect(props.getByRole('region', { name: 'Appearance' })).toBeVisible();
    // It sits inside the viewport, in its top-left corner.
    const vp = await scad.viewport();
    const box = await windowBox(scad, 'properties-window');
    expect(box.x).toBeGreaterThanOrEqual(vp.x);
    expect(box.x - vp.x).toBeLessThan(20);
    expect(box.y - vp.y).toBeLessThan(20);
    await shot(scad, '1-properties-window');
    // A parameter edit still writes the code.
    const r = scad.page.getByLabel('Parameter r', { exact: true });
    await r.fill('7');
    await scad.rendersAfter(() => r.press('Enter'));
    expect(await scad.source()).toContain('sphere(r=7, $fn=32);');
    await scad.clickViewport(-120, 300); // empty space
    await expect(scad.propertiesWindow()).toBeHidden();
  });

  test('a window drags by its title bar, keeps its place, and double-click puts it back', async ({ scad }) => {
    await scad.load(PARTS);
    await scad.clickEditorLine(1);
    const before = await windowBox(scad, 'properties-window');
    const bar = scad.propertiesWindow().getByTestId('window-title-bar');
    const b = await bar.boundingBox();
    await scad.page.mouse.move(b!.x + 40, b!.y + b!.height / 2);
    await scad.page.mouse.down();
    for (let i = 1; i <= 10; i++) await scad.page.mouse.move(b!.x + 40 + i * 20, b!.y + b!.height / 2 + i * 15);
    await scad.page.mouse.up();
    const moved = await windowBox(scad, 'properties-window');
    expect(Math.round(moved.x - before.x)).toBe(200);
    expect(Math.round(moved.y - before.y)).toBe(150);
    // Deselect and select again: it opens where it was left.
    await scad.clickViewport(-120, 300);
    await expect(scad.propertiesWindow()).toBeHidden();
    await scad.clickEditorLine(2);
    const again = await windowBox(scad, 'properties-window');
    expect(Math.round(again.x)).toBe(Math.round(moved.x));
    expect(Math.round(again.y)).toBe(Math.round(moved.y));
    // And after a reload (the position is stored, like other preferences).
    await scad.page.reload();
    await expect.poll(() => scad.status(), { timeout: 90_000 }).toMatch(/^Rendered/);
    await scad.load(PARTS);
    await scad.clickEditorLine(1);
    const reloaded = await windowBox(scad, 'properties-window');
    expect(Math.round(reloaded.x)).toBe(Math.round(moved.x));
    // Dragged far off: it stays inside the viewport.
    const bar2 = await scad.propertiesWindow().getByTestId('window-title-bar').boundingBox();
    await scad.page.mouse.move(bar2!.x + 40, bar2!.y + 10);
    await scad.page.mouse.down();
    await scad.page.mouse.move(bar2!.x + 2000, bar2!.y + 2000, { steps: 5 });
    await scad.page.mouse.up();
    const vp = await scad.viewport();
    const clamped = await windowBox(scad, 'properties-window');
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(vp.x + vp.width);
    expect(clamped.y).toBeLessThan(vp.y + vp.height);
    await scad.propertiesWindow().getByTestId('window-title-bar').dblclick({ position: { x: 40, y: 10 } });
    const home = await windowBox(scad, 'properties-window');
    expect(home.x - vp.x).toBeLessThan(20);
    expect(home.y - vp.y).toBeLessThan(20);
  });

  test('the Properties window collapses to its title bar', async ({ scad }) => {
    await scad.load(PARTS);
    await scad.clickEditorLine(1);
    await scad.propertiesWindow().getByRole('button', { name: 'Collapse window' }).click();
    await expect(scad.propertiesWindow().getByRole('region', { name: 'Parameters' })).toBeHidden();
    await scad.clickEditorLine(2);
    await expect(scad.propertiesWindow().getByRole('region', { name: 'Parameters' })).toBeHidden(); // remembered
    await scad.propertiesWindow().getByRole('button', { name: 'Expand window' }).click();
    await expect(scad.propertiesWindow().getByRole('region', { name: 'Parameters' })).toBeVisible();
  });

  test('one tool window at a time: a new tool replaces the open one; Esc and Cancel write nothing', async ({ scad }) => {
    await scad.load(PARTS);
    await scad.clickEditorLine(1);
    await scad.button('Distance').click();
    await expect(scad.toolWindow()).toHaveAttribute('aria-label', 'Distance tool');
    await expect(scad.propertiesWindow()).toBeHidden(); // steps aside for the tool
    await shot(scad, '2-distance-window');
    await scad.button('Boolean').click();
    await expect(scad.toolWindow()).toHaveCount(1);
    await expect(scad.toolWindow()).toHaveAttribute('aria-label', 'Union tool');
    await scad.page.keyboard.press('Escape');
    await expect(scad.toolWindow()).toBeHidden();
    await scad.button('Pattern').click();
    await expect(scad.toolWindow()).toHaveAttribute('aria-label', 'Pattern tool');
    await scad.toolWindow().getByRole('button', { name: 'Close window' }).click();
    await expect(scad.toolWindow()).toBeHidden();
    expect(await scad.source()).toBe(PARTS);
  });

  test('Boolean window: Difference of two selected parts, then the toolbar remembers the operation', async ({ scad }) => {
    await scad.load('cube(10, center=true);\ncylinder(h=30, r=3, center=true, $fn=24);\n');
    await scad.clickEditorLine(2); // the cylinder
    await scad.startBoolean('Difference');
    await expect(scad.page.getByTestId('slot-base')).toContainText('cylinder');
    await expect(scad.page.getByTestId('slot-subtract')).toHaveAttribute('aria-pressed', 'true');
    await scad.clickEditorLine(1); // an editor click fills the slot being picked
    await expect(scad.page.getByTestId('slot-subtract')).toContainText('cube');
    // Wrong way round: re-pick the base. The cube leaves Subtract, and the
    // Subtract slot waits for the cylinder.
    await scad.page.getByTestId('slot-base').click();
    // (the caret is already on line 1: click further along it, so it moves)
    await scad.page.locator('.monaco-editor .view-line').nth(0).click({ position: { x: 40, y: 5 } });
    await expect(scad.page.getByTestId('slot-base')).toContainText('cube');
    await expect(scad.page.getByTestId('slot-subtract')).toHaveAttribute('aria-pressed', 'true');
    await scad.clickEditorLine(2);
    await expect(scad.page.getByTestId('slot-subtract')).toContainText('cylinder');
    await expect(scad.page.getByTestId('tool-preview')).toContainText('difference() {');
    await shot(scad, '3-difference-window');
    await scad.applyTool();
    expect(await scad.source()).toBe('difference() {\n    cube(10, center=true);\n    cylinder(h=30, r=3, center=true, $fn=24);\n}\n');
    await shot(scad, '4-difference-applied');
    await scad.button('Boolean').click();
    await expect(scad.toolWindow()).toHaveAttribute('aria-label', 'Difference tool');
  });

  test('Extrude window: Rotate with an angle, and Extrude is off for a selected 3D part', async ({ scad }) => {
    await scad.load('translate([10, 0, 0]) square([4, 8]);\ncube(3);\n');
    await scad.clickEditorLine(2);
    await expect(scad.button('Extrude')).toBeDisabled();
    await scad.clickEditorLine(1);
    await expect(scad.button('Extrude')).toBeEnabled();
    await scad.startExtrude('Rotate');
    await expect(scad.page.getByTestId('slot-profile')).toContainText('square');
    await scad.page.getByLabel('Extrude angle').fill('270');
    await expect(scad.page.getByTestId('tool-preview')).toContainText('rotate_extrude(angle=270, $fn=48)');
    await shot(scad, '5-extrude-window');
    expect(await scad.applyTool()).toBe('Rendered');
    expect(await scad.source()).toBe('translate([10, 0, 0])\n    rotate_extrude(angle=270, $fn=48) {\n    square([4, 8]);\n}\ncube(3);\n');
    // The result is 3D now, so Extrude turns off for it.
    await expect(scad.button('Extrude')).toBeDisabled();
  });

  test('the toolbar is one row at 1280 px, and the shading menu is in the top bar', async ({ scad }) => {
    await scad.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
    await scad.load(PARTS);
    await scad.page.waitForTimeout(300);
    const tops = await scad.page.evaluate(() => {
      const row = document.querySelector('[aria-label="Insert"]')?.parentElement;
      return row ? [...row.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)) : [];
    });
    expect(tops.length).toBeGreaterThan(10);
    expect(new Set(tops).size, `button rows: ${[...new Set(tops)].join(', ')}`).toBe(1);
    await scad.clickEditorLine(1); // a selection no longer adds toolbar rows
    const topsSelected = await scad.page.evaluate(() => {
      const row = document.querySelector('[aria-label="Insert"]')?.parentElement;
      return row ? [...row.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)) : [];
    });
    expect(new Set(topsSelected).size).toBe(1);
    await shot(scad, '6-toolbar-1280');
    // Shading: in the top bar, not over the viewport.
    const shading = scad.page.getByLabel('Shading mode');
    const vp = await scad.viewport();
    const sb = await shading.boundingBox();
    expect(sb!.y + sb!.height).toBeLessThanOrEqual(vp.y);
    await shading.selectOption('wireframe');
    await expect(shading).toHaveValue('wireframe');
    await shading.selectOption('shaded');
    // Sketch mode: one row too (Insert and the part tools step aside, the
    // hint sits over the viewport).
    await scad.button('XY').click();
    await scad.page.getByRole('group', { name: 'Sketch tools' }).getByRole('button', { name: 'Circle' }).click();
    await expect(scad.page.getByTestId('sketch-hint')).toContainText('click the center');
    const sketchTops = await scad.page.evaluate(() => {
      const row = document.querySelector('[aria-label="Sketch tools"]')?.closest('div');
      return row ? [...row.querySelectorAll('button, select, input')].map((b) => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2)) : [];
    });
    expect(sketchTops.length).toBeGreaterThan(8);
    expect(Math.max(...sketchTops) - Math.min(...sketchTops), `sketch row centers: ${sketchTops.join(', ')}`).toBeLessThan(8);
    await shot(scad, '8-sketch-toolbar-1280');
  });

  test('sketch grid snap is off by default and the choice is remembered', async ({ scad }) => {
    await scad.load('cube(1);\n');
    await scad.button('XY').click();
    await expect(scad.page.getByText(/Sketching on XY plane/)).toBeVisible();
    const grid = scad.page.getByRole('checkbox', { name: 'Grid' });
    const points = scad.page.getByRole('checkbox', { name: 'Points/edges' });
    await expect(grid).not.toBeChecked();
    await expect(points).toBeChecked();
    await shot(scad, '7-sketch-grid-off');
    await grid.check();
    await scad.button('Exit Sketch').click();
    await scad.page.reload();
    await expect.poll(() => scad.status(), { timeout: 90_000 }).toMatch(/^Rendered/);
    await scad.button('XY').click();
    await expect(scad.page.getByRole('checkbox', { name: 'Grid' })).toBeChecked();
  });
});
