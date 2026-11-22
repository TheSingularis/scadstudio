// M6 multi-select, boolean wrap-in-block and modifiers; M7 extrusions and
// bare-2D rendering.
import { test, expect, audit } from './fixtures';

// A big sphere around the origin with a small cube inside it: clicking the
// viewport centre always hits the sphere (node 0), and the cube (node 1) is
// reachable through the editor.
const SPHERE_AND_CUBE = 'sphere(r=20, $fn=32);\ncube(2, center=true);\n';

test.describe('M6 booleans and modifiers', () => {
  test('editor click + shift-click range-selects two nodes and Difference wraps them in selection order', async ({ scad }) => {
    await scad.load(SPHERE_AND_CUBE);
    await scad.clickEditorLine(2); // cube: replace-select, sets the range anchor
    await scad.clickViewport(0, 0, ['Shift']); // sphere
    await expect(scad.page.getByText(/Boolean \(2 selected/)).toBeVisible();
    // (cube minus the sphere around it is empty geometry, so only the source is checked)
    await scad.rendersAfter(() => scad.button('Difference').click());
    expect(await scad.source()).toBe('difference() {\n    cube(2, center=true);\n    sphere(r=20, $fn=32);\n}\n');
  });

  test('ctrl-click toggles a node in and out of the selection', async ({ scad }) => {
    await scad.load(SPHERE_AND_CUBE);
    await scad.clickEditorLine(2);
    await scad.clickViewport(0, 0, ['Control']);
    await expect(scad.page.getByText(/Boolean \(2 selected/)).toBeVisible();
    await scad.clickViewport(0, 0, ['Control']);
    await expect(scad.page.getByText(/Boolean \(/)).toBeHidden();
    expect(await scad.selectedCall()).toBe('cube');
  });

  for (const [label, op] of [
    ['Union', 'union'],
    ['Intersection', 'intersection'],
  ] as const) {
    test(`${label} wraps the selection`, async ({ scad }) => {
      await scad.load(SPHERE_AND_CUBE);
      await scad.clickEditorLine(2);
      await scad.clickViewport(0, 0, ['Shift']);
      await scad.rendersAfter(() => scad.button(label).click());
      expect(await scad.source()).toMatch(new RegExp(`^${op}\\(\\) \\{\\n`));
    });
  }

  test('modifier buttons write and toggle # % ! *', async ({ scad }) => {
    await scad.load('cube(10, center=true);\n');
    await scad.clickViewport();
    await scad.rendersAfter(() => scad.button('Highlight #').click());
    expect(await scad.source()).toBe('#cube(10, center=true);\n');
    await scad.rendersAfter(() => scad.button('Ghost %').click());
    expect(await scad.source()).toBe('%cube(10, center=true);\n');
    await scad.rendersAfter(() => scad.button('Ghost %').click());
    expect(await scad.source()).toBe('cube(10, center=true);\n');
  });

  test('Disable * skips the node and says so in the status', async ({ scad }) => {
    await scad.load('cube(10, center=true);\ntranslate([20, 0, 0]) sphere(3);\n');
    await scad.clickEditorLine(2);
    const status = await scad.rendersAfter(() => scad.button('Disable *').click());
    expect(status).toBe('Rendered (1 disabled)');
    expect(await scad.source()).toContain('*translate([20, 0, 0]) sphere(3);');
  });
});

test.describe('M7 extrusions', () => {
  test('Linear Extrude with nothing selected appends a default extrusion', async ({ scad }) => {
    await scad.load('cube(1);\n', { fit: false });
    await scad.clickViewport(-300, 300); // make sure nothing is selected
    const status = await scad.rendersAfter(() => scad.button('Linear Extrude').click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toContain('linear_extrude(height=10) circle(r=5, $fn=32);');
  });

  test('Rotate Extrude with nothing selected appends a torus', async ({ scad }) => {
    await scad.load('cube(1);\n', { fit: false });
    const status = await scad.rendersAfter(() => scad.button('Rotate Extrude').click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toContain('rotate_extrude($fn=48)');
  });

  test('bare 2D shapes render (thin-extrude retry)', async ({ scad }) => {
    const status = await scad.load('square([10, 5]);\ntranslate([20, 0, 0]) circle(r=4);\npolygon(points=[[0, 10], [5, 10], [0, 15]]);\n');
    expect(status).toBe('Rendered');
  });

  test('extrude-the-selection wraps a selected 2D shape in place', async ({ scad }) => {
    await scad.load('translate([3, 0, 0]) circle(r=5, $fn=32);\n');
    await scad.clickEditorLine(1);
    const status = await scad.rendersAfter(() => scad.button('Linear Extrude').click());
    expect(status).toBe('Rendered');
    expect(await scad.source()).toBe('translate([3, 0, 0])\n    linear_extrude(height=10) {\n    circle(r=5, $fn=32);\n}\n');
  });

  test(audit('L2', 'Extrude on a 3D shape does not silently produce an empty render'), async ({ scad }) => {
    test.fail();
    await scad.load('cube(5, center=true);\n');
    await scad.clickEditorLine(1);
    const status = await scad.rendersAfter(() => scad.button('Linear Extrude').click());
    expect(status).not.toMatch(/Rendered 0\/1 nodes$/);
  });
});
