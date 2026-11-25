// M11 directional constraints in the running app: the variables panel,
// Make variable, the Distance/Align/Pattern tool panel, and expression axes
// in the Position fields and gizmo. Real clicks and typing throughout.
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

const TWO_PARTS = 'cube([30, 20, 10]);\n\ntranslate([60, 5, 0]) sphere(r = 8, $fn = 32);\n';

test.describe('M11 directional constraints', () => {
  test('Distance with follow: the sphere keeps its gap when the cube grows', async ({ scad }) => {
    await scad.load(TWO_PARTS);
    await scad.button('Distance').click();
    const panel = scad.page.getByRole('region', { name: 'Distance tool' });
    await expect(panel).toBeVisible();
    // Nothing selected: the Move slot is waiting for a click.
    await expect(panel.getByTestId('slot-move')).toHaveAttribute('aria-pressed', 'true');
    await scad.clickEditorLine(3); // the sphere
    await expect(panel.getByTestId('slot-relative-to')).toHaveAttribute('aria-pressed', 'true');
    await scad.clickEditorLine(1); // the cube
    await expect(panel.getByTestId('slot-move')).toContainText('sphere');
    await expect(panel.getByTestId('slot-relative-to')).toContainText('cube');
    // The default distance is where the parts are now: 52 - 30.
    await expect(panel.getByLabel('Offset', { exact: true })).toHaveValue('22');
    await panel.getByLabel('Offset', { exact: true }).fill('5');
    await expect(scad.page.getByTestId('tool-preview')).toContainText('translate X = cube_x + cube_width + gap + sphere_r');
    await shot(scad, '1-distance-panel');
    await scad.rendersAfter(() => panel.getByRole('button', { name: 'Apply' }).click());
    expect(await scad.source()).toBe(
      'cube_x = 0;\ncube_width = 30;\nsphere_r = 8;\ngap = 5;\n\ntranslate([cube_x, 0, 0])\n    cube([cube_width, 20, 10]);\n\ntranslate([cube_x + cube_width + gap + sphere_r, 5, 0])\n    sphere(r = sphere_r, $fn = 32);\n',
    );
    await expect(panel).toBeHidden();
    // The variables panel lists what was written.
    const vars = scad.page.getByRole('complementary', { name: 'Variables' });
    for (const name of ['cube_x', 'cube_width', 'sphere_r', 'gap']) await expect(vars.getByTestId(`variable-${name}`)).toBeVisible();
    await shot(scad, '2-applied');

    // Grow the cube from the variables panel: the sphere moves with it.
    await scad.rendersAfter(async () => {
      await vars.getByLabel('Variable cube_width', { exact: true }).fill('50');
      await vars.getByLabel('Variable cube_width', { exact: true }).press('Enter');
    });
    expect(await scad.source()).toContain('cube_width = 50;');
    await scad.clickEditorLine(9); // the sphere's translate
    const x = scad.page.getByLabel('Position X', { exact: true });
    await expect(x).toHaveValue('cube_x + cube_width + gap + sphere_r');
    await expect(x).toHaveAttribute('title', /comes to 63/);
    // X is an expression: the gizmo has no X handle, Y and Z still drag.
    await expect(scad.page.getByTestId('gizmo-lock-note')).toContainText('X = cube_x + cube_width + gap + sphere_r');
    expect((await scad.axisHandle('x')).count).toBeLessThan(20);
    expect((await scad.axisHandle('y')).count).toBeGreaterThan(20);
    await shot(scad, '3-cube-grown-sphere-follows');
  });

  test('Align centers, and Position accepts an expression or a number', async ({ scad }) => {
    await scad.load('w = 30;\n\ntranslate([0, 10, 0]) cube([w, 20, 10], center = true);\n\ntranslate([60, 0, 0]) cylinder(h = 5, r = 4);\n');
    await scad.button('Align').click();
    const panel = scad.page.getByRole('region', { name: 'Align tool' });
    await panel.getByTestId('slot-move').click();
    await scad.clickEditorLine(5);
    await panel.getByTestId('slot-relative-to').click();
    await scad.clickEditorLine(3);
    await panel.getByRole('group', { name: 'Axis' }).getByRole('button', { name: 'Y' }).click();
    await expect(scad.page.getByTestId('tool-preview')).toContainText('translate Y = cube_y');
    await scad.rendersAfter(() => panel.getByRole('button', { name: 'Apply' }).click());
    expect(await scad.source()).toContain('translate([60, cube_y, 0])');

    // Position X takes an expression...
    await scad.clickEditorLine(7);
    const x = scad.page.getByLabel('Position X', { exact: true });
    await scad.rendersAfter(async () => {
      await x.fill('w * 2 + 5');
      await x.press('Enter');
    });
    expect(await scad.source()).toContain('translate([w * 2 + 5, cube_y, 0])');
    // ...and a number detaches it again.
    await scad.rendersAfter(async () => {
      await scad.page.getByLabel('Position X', { exact: true }).fill('12');
      await scad.page.getByLabel('Position X', { exact: true }).press('Enter');
    });
    expect(await scad.source()).toContain('translate([12, cube_y, 0])');
  });

  test('Pattern: a linear row, then the count edited from its panel', async ({ scad }) => {
    await scad.load('translate([0, 0, 0]) cube([10, 4, 4]);\n');
    await scad.clickEditorLine(1);
    await scad.button('Pattern').click();
    const panel = scad.page.getByRole('region', { name: 'Pattern tool' });
    await expect(panel.getByTestId('slot-part')).toContainText('cube');
    // Default pitch: the part's width plus 5.
    await expect(panel.getByLabel('Spacing', { exact: true })).toHaveValue('15');
    await shot(scad, '4-pattern-panel');
    await scad.rendersAfter(() => panel.getByRole('button', { name: 'Apply' }).click());
    expect(await scad.source()).toBe('for (i = [0 : 2])\n    translate([i * 15, 0, 0])\n    cube([10, 4, 4]);\n');
    const strip = scad.page.getByRole('group', { name: 'Pattern' });
    await expect(strip).toContainText('Linear pattern along X');
    await scad.rendersAfter(async () => {
      await strip.getByLabel('Pattern count').fill('5');
      await strip.getByLabel('Pattern count').press('Enter');
    });
    expect(await scad.source()).toContain('for (i = [0 : 4])');
    // The whole pattern moves like any part: Position gives it a translate.
    await scad.rendersAfter(async () => {
      await scad.page.getByLabel('Position Y', { exact: true }).fill('8');
      await scad.page.getByLabel('Position Y', { exact: true }).press('Enter');
    });
    expect(await scad.source()).toMatch(/^translate\(\[0, 8, 0\]\)\n\s+for \(i = \[0 : 4\]\)/);
    await scad.resetView();
    await shot(scad, '5-pattern-five');
  });

  test('Make variable from the parameter panel, and delete with inline', async ({ scad }) => {
    await scad.load('cylinder(h = 20, r = 5);\n');
    await scad.clickEditorLine(1);
    await scad.page.getByRole('button', { name: 'Make h a variable' }).click();
    const prompt = scad.page.getByRole('form', { name: 'Make variable' });
    await expect(prompt.getByLabel('Variable name')).toHaveValue('cylinder_h');
    await scad.rendersAfter(() => prompt.getByRole('button', { name: 'Make variable' }).click());
    expect(await scad.source()).toBe('cylinder_h = 20;\n\ncylinder(h = cylinder_h, r = 5);\n');
    // The r field autocompletes variable names: type one in.
    await scad.clickEditorLine(3);
    const r = scad.page.getByLabel('Parameter r', { exact: true });
    await scad.rendersAfter(async () => {
      await r.fill('cylinder_h / 4');
      await r.press('Enter');
    });
    expect(await scad.source()).toContain('cylinder(h = cylinder_h, r = cylinder_h / 4)');
    await shot(scad, '6-make-variable');

    // Deleting a used variable asks, then inlines its value.
    const vars = scad.page.getByRole('complementary', { name: 'Variables' });
    const row = vars.getByTestId('variable-cylinder_h');
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row.getByRole('alert')).toContainText('used in 2 places');
    await shot(scad, '7-delete-asks');
    await scad.rendersAfter(() => row.getByRole('button', { name: 'Inline its value and delete' }).click());
    expect(await scad.source()).toBe('cylinder(h = 20, r = 20 / 4);\n');
  });

  test('Customizer annotations become a slider and a dropdown; rename updates uses', async ({ scad }) => {
    await scad.load('// Wall thickness\nwall = 2; // [1:0.5:5]\nshape = "round"; // [round, square]\n/* [Hidden] */\nfn = 32;\n\ncube([10, 10, wall]);\n');
    const vars = scad.page.getByRole('complementary', { name: 'Variables' });
    await expect(vars.getByLabel('Variable wall slider')).toHaveAttribute('max', '5');
    await expect(vars.getByLabel('Variable shape')).toHaveValue('round');
    await expect(vars).toContainText('Wall thickness');
    await expect(vars.getByRole('region', { name: 'Hidden variables' })).toContainText('fn');
    await shot(scad, '8-customizer');
    await vars.getByRole('button', { name: 'wall' }).click();
    await scad.rendersAfter(async () => {
      await vars.getByLabel('New name for wall').fill('wall_t');
      await vars.getByLabel('New name for wall').press('Enter');
    });
    expect(await scad.source()).toBe('// Wall thickness\nwall_t = 2; // [1:0.5:5]\nshape = "round"; // [round, square]\n/* [Hidden] */\nfn = 32;\n\ncube([10, 10, wall_t]);\n');
  });
});
